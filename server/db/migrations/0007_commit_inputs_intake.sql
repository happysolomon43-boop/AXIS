CREATE FUNCTION axis_hints_hash(p_hints jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    canonical text;
BEGIN
    IF p_hints IS NULL OR p_hints = 'null'::jsonb THEN
        RETURN encode(sha256(''::bytea), 'hex');
    END IF;
    IF jsonb_typeof(p_hints) <> 'array' THEN
        RAISE EXCEPTION 'invalid hints' USING ERRCODE = 'AX002';
    END IF;

    IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_hints) AS item(value)
        WHERE CASE jsonb_typeof(item.value)
            WHEN 'null' THEN false
            WHEN 'object' THEN
                item.value - ARRAY['pov', 'location', 'time', 'time_mode'] <> '{}'::jsonb
                OR EXISTS (
                    SELECT 1 FROM jsonb_each(item.value) AS field(key, value)
                    WHERE jsonb_typeof(field.value) <> 'null' AND (
                        jsonb_typeof(field.value) <> 'string'
                        OR CASE WHEN field.key = 'time_mode'
                            THEN (field.value #>> '{}') NOT IN ('linear', 'flashback', 'skip', 'loop')
                            ELSE char_length(field.value #>> '{}') NOT BETWEEN 1 AND 200
                        END
                    )
                )
            ELSE true
        END
    ) THEN
        RAISE EXCEPTION 'invalid hints' USING ERRCODE = 'AX002';
    END IF;

    SELECT COALESCE(string_agg(
        jsonb_build_array(ordinal, pov, location, time_hint, mode)::text || chr(10),
        '' ORDER BY ordinal
    ) FILTER (WHERE pov IS NOT NULL OR location IS NOT NULL OR time_hint IS NOT NULL OR mode <> 'linear'), '')
    INTO canonical
    FROM (
        SELECT item.ordinal, item.value ->> 'pov' AS pov, item.value ->> 'location' AS location,
               item.value ->> 'time' AS time_hint, COALESCE(item.value ->> 'time_mode', 'linear') AS mode
        FROM jsonb_array_elements(p_hints) WITH ORDINALITY AS item(value, ordinal)
    ) AS hints;

    RETURN encode(sha256(convert_to(canonical, 'UTF8')), 'hex');
END;
$$;

CREATE FUNCTION axis_intake_store(p_version_id text, p_hints jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    version_content text;
    previous_version text;
    segmented jsonb;
    scene_count integer;
BEGIN
    SELECT v.content, v.parent_version INTO version_content, previous_version
    FROM chapter_versions AS v WHERE v.id = p_version_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'version not found' USING ERRCODE = 'AX002';
    END IF;

    segmented := axis_segment(version_content);
    IF jsonb_typeof(p_hints) = 'array' THEN
        SELECT COALESCE(max(s.scene), 0) INTO scene_count
        FROM jsonb_to_recordset(segmented) AS s(scene integer);
        IF jsonb_array_length(p_hints) > scene_count THEN
            RAISE EXCEPTION 'invalid hints' USING ERRCODE = 'AX002';
        END IF;
    END IF;

    -- The ordinal rank pairs unique keys at rank one and duplicates in order.
    WITH hashed AS (
        SELECT b.ordinal, b.kind::block_kind AS kind, b.text,
               encode(sha256(convert_to(axis_fold(b.text), 'UTF8')), 'hex') AS hash
        FROM jsonb_to_recordset(segmented) AS b(ordinal integer, kind text, text text)
    ), incoming AS (
        SELECT *, row_number() OVER (PARTITION BY kind, hash ORDER BY ordinal) AS pair_no
        FROM hashed
    ), parent AS (
        SELECT b.kind, b.hash, b.block_uid,
               row_number() OVER (PARTITION BY b.kind, b.hash ORDER BY b.ordinal) AS pair_no
        FROM blocks AS b WHERE b.version_id = previous_version
    )
    INSERT INTO blocks (version_id, block_uid, ordinal, kind, text, hash)
    SELECT p_version_id,
           COALESCE(parent.block_uid, 'b_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
           incoming.ordinal, incoming.kind, incoming.text, incoming.hash
    FROM incoming LEFT JOIN parent USING (kind, hash, pair_no)
    ORDER BY incoming.ordinal;

    WITH normalized_blocks AS (
        SELECT b.scene, b.ordinal, (
            SELECT string_agg(axis_normalize(sentence.text), chr(10) ORDER BY sentence.ordinal)
            FROM unnest(axis_sentences(b.text)) WITH ORDINALITY AS sentence(text, ordinal)
        ) AS normalized
        FROM jsonb_to_recordset(segmented) AS b(ordinal integer, text text, scene integer)
        WHERE b.scene IS NOT NULL
    ), scene_text AS (
        SELECT scene AS ordinal, min(ordinal) AS first_block, max(ordinal) AS last_block,
               string_agg(normalized, chr(10) || chr(10) ORDER BY ordinal) AS text
        FROM normalized_blocks GROUP BY scene
    )
    INSERT INTO scenes (
        version_id, ordinal, fingerprint, first_block, last_block, pov_hint, location_hint, time_hint, time_mode
    )
    SELECT p_version_id, s.ordinal, encode(sha256(convert_to(s.text, 'UTF8')), 'hex'),
           s.first_block, s.last_block, h.hint ->> 'pov', h.hint ->> 'location', h.hint ->> 'time',
           COALESCE(h.hint ->> 'time_mode', 'linear')::time_mode
    FROM scene_text AS s CROSS JOIN LATERAL (SELECT p_hints -> (s.ordinal - 1) AS hint) AS h
    ORDER BY s.ordinal;
END;
$$;

CREATE FUNCTION axis_intake_backfill()
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    unprocessed_version text;
    processed integer := 0;
BEGIN
    FOR unprocessed_version IN
        SELECT v.id FROM chapter_versions AS v
        WHERE NOT EXISTS (SELECT 1 FROM blocks AS b WHERE b.version_id = v.id)
          AND axis_fold(v.content) <> ''
        ORDER BY v.chapter_id, v.version_no
    LOOP
        PERFORM axis_intake_store(unprocessed_version, NULL);
        processed := processed + 1;
    END LOOP;
    RETURN processed;
END;
$$;

CREATE OR REPLACE FUNCTION commit_inputs(p_series_id text, p_door text, p_actor text, p_op text, p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
    next_l_seq bigint;
    input_row jsonb;
    input_kind text;
    row_index integer := 0;
    row_kinds text[] := ARRAY[]::text[];
    target_ids text[] := ARRAY[]::text[];
    target_id text;
    valid_row boolean;
    book_id_value text;
    order_key_value text;
    next_order bigint;
    chapter_reference numeric;
    version_reference numeric;
    chapter_id_value text;
    version_id_value text;
    latest_version_no integer;
    latest_version_id text;
    parent_id text;
    content_value text;
    hints_value jsonb;
    hints_hash_value text;
BEGIN
    IF p_door IS DISTINCT FROM 'corpus' THEN
        RAISE EXCEPTION 'door not supported' USING ERRCODE = 'AX002';
    END IF;

    IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'rows must be an array of 1 to 100 objects' USING ERRCODE = 'AX002';
    END IF;
    IF jsonb_array_length(p_rows) NOT BETWEEN 1 AND 100 OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(p_rows) AS item(value)
        WHERE jsonb_typeof(item.value) <> 'object'
    ) THEN
        RAISE EXCEPTION 'rows must be an array of 1 to 100 objects' USING ERRCODE = 'AX002';
    END IF;

    PERFORM 1 FROM series AS s WHERE s.id = p_series_id FOR NO KEY UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'series not found' USING ERRCODE = 'AX002';
    END IF;

    SELECT COALESCE(max(l.l_seq), 0) + 1 INTO next_l_seq
    FROM ledger AS l
    WHERE l.series_id = p_series_id;

    FOR input_row IN
        SELECT item.value FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS item(value, position)
        ORDER BY item.position
    LOOP
        input_kind := input_row ->> 'kind';
        CASE input_kind
            WHEN 'chapter' THEN
                valid_row := input_row - ARRAY['kind', 'book_id', 'order_key'] = '{}'::jsonb
                    AND jsonb_typeof(input_row -> 'book_id') = 'string'
                    AND (
                        NOT (input_row ? 'order_key')
                        OR jsonb_typeof(input_row -> 'order_key') IN ('string', 'null')
                    );
            WHEN 'chapter_version' THEN
                valid_row := input_row - ARRAY['kind', 'chapter_id', 'chapter_ref', 'content', 'source', 'parent_version', 'hints'] = '{}'::jsonb
                    AND jsonb_typeof(input_row -> 'content') = 'string'
                    AND jsonb_typeof(input_row -> 'source') = 'string'
                    AND (
                        NOT (input_row ? 'parent_version')
                        OR jsonb_typeof(input_row -> 'parent_version') IN ('string', 'null')
                    )
                    AND (
                        NOT (input_row ? 'hints')
                        OR jsonb_typeof(input_row -> 'hints') IN ('array', 'null')
                    );
            WHEN 'chapter_active' THEN
                valid_row := input_row - ARRAY['kind', 'chapter_id', 'chapter_ref', 'version_id', 'version_ref'] = '{}'::jsonb
                    AND (input_row ? 'version_id') <> (input_row ? 'version_ref')
                    AND (
                        jsonb_typeof(input_row -> 'version_id') IN ('string', 'null')
                        OR jsonb_typeof(input_row -> 'version_ref') = 'number'
                    );
            ELSE
                valid_row := false;
        END CASE;

        IF input_kind IN ('chapter_version', 'chapter_active') THEN
            valid_row := valid_row
                AND (input_row ? 'chapter_id') <> (input_row ? 'chapter_ref')
                AND (
                    jsonb_typeof(input_row -> 'chapter_id') = 'string'
                    OR jsonb_typeof(input_row -> 'chapter_ref') = 'number'
                );
        END IF;
        IF valid_row IS NOT TRUE THEN
            RAISE EXCEPTION 'invalid row' USING ERRCODE = 'AX002';
        END IF;

        IF input_kind = 'chapter' THEN
            book_id_value := input_row ->> 'book_id';
            order_key_value := input_row ->> 'order_key';
            PERFORM 1 FROM books AS b WHERE b.id = book_id_value AND b.series_id = p_series_id;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'book not in series' USING ERRCODE = 'AX002';
            END IF;

            IF order_key_value IS NULL THEN
                SELECT COALESCE(max(c.order_key::bigint), 0) + 1000 INTO next_order
                FROM chapters AS c WHERE c.book_id = book_id_value;
                IF next_order > 9999999999 THEN
                    RAISE EXCEPTION 'order key space exhausted' USING ERRCODE = 'AX002';
                END IF;
                order_key_value := lpad(next_order::text, 10, '0');
            ELSIF order_key_value !~ '^[0-9]{10}$' THEN
                RAISE EXCEPTION 'invalid row' USING ERRCODE = 'AX002';
            END IF;

            INSERT INTO chapters (book_id, order_key)
            VALUES (book_id_value, order_key_value)
            RETURNING id INTO target_id;
        ELSE
            chapter_reference := (input_row ->> 'chapter_ref')::numeric;
            version_reference := (input_row ->> 'version_ref')::numeric;
            IF chapter_reference <> trunc(chapter_reference) OR version_reference <> trunc(version_reference) THEN
                RAISE EXCEPTION 'invalid row' USING ERRCODE = 'AX002';
            END IF;

            IF chapter_reference IS NOT NULL THEN
                IF chapter_reference < 0 OR chapter_reference >= row_index THEN
                    RAISE EXCEPTION 'invalid reference' USING ERRCODE = 'AX002';
                END IF;
                IF row_kinds[chapter_reference::integer + 1] <> 'chapter' THEN
                    RAISE EXCEPTION 'invalid reference' USING ERRCODE = 'AX002';
                END IF;
                chapter_id_value := target_ids[chapter_reference::integer + 1];
            ELSE
                chapter_id_value := input_row ->> 'chapter_id';
                PERFORM 1
                FROM chapters AS c JOIN books AS b ON b.id = c.book_id
                WHERE c.id = chapter_id_value AND b.series_id = p_series_id;
                IF NOT FOUND THEN
                    RAISE EXCEPTION 'chapter not in series' USING ERRCODE = 'AX002';
                END IF;
            END IF;

            IF input_kind = 'chapter_version' THEN
                SELECT v.version_no, v.id INTO latest_version_no, latest_version_id
                FROM chapter_versions AS v
                WHERE v.chapter_id = chapter_id_value
                ORDER BY v.version_no DESC LIMIT 1;

                parent_id := input_row ->> 'parent_version';
                IF parent_id IS NOT NULL THEN
                    IF latest_version_no IS NULL OR NOT EXISTS (
                        SELECT 1 FROM chapter_versions AS v
                        WHERE v.chapter_id = chapter_id_value AND v.id = parent_id
                    ) THEN
                        RAISE EXCEPTION 'invalid parent version' USING ERRCODE = 'AX002';
                    END IF;
                ELSE
                    parent_id := latest_version_id;
                END IF;

                content_value := input_row ->> 'content';
                hints_value := input_row -> 'hints';
                hints_hash_value := axis_hints_hash(hints_value);
                INSERT INTO chapter_versions (
                    series_id, chapter_id, version_no, source, content, text_hash, hints_hash, parent_version, l_seq
                )
                VALUES (
                    p_series_id, chapter_id_value, COALESCE(latest_version_no, 0) + 1,
                    (input_row ->> 'source')::version_source, content_value,
                    encode(sha256(convert_to(axis_fold(content_value), 'UTF8')), 'hex'),
                    hints_hash_value, parent_id, next_l_seq
                )
                RETURNING id INTO target_id;
                PERFORM axis_intake_store(target_id, hints_value);
            ELSE
                version_id_value := input_row ->> 'version_id';
                IF version_reference IS NOT NULL THEN
                    IF version_reference < 0 OR version_reference >= row_index THEN
                        RAISE EXCEPTION 'invalid reference' USING ERRCODE = 'AX002';
                    END IF;
                    IF row_kinds[version_reference::integer + 1] <> 'chapter_version' THEN
                        RAISE EXCEPTION 'invalid reference' USING ERRCODE = 'AX002';
                    END IF;
                    version_id_value := target_ids[version_reference::integer + 1];
                END IF;
                IF version_id_value IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM chapter_versions AS v
                    WHERE v.chapter_id = chapter_id_value AND v.id = version_id_value
                ) THEN
                    RAISE EXCEPTION 'version not in chapter' USING ERRCODE = 'AX002';
                END IF;

                INSERT INTO chapter_active (series_id, chapter_id, version_id, since_l)
                VALUES (p_series_id, chapter_id_value, version_id_value, next_l_seq);
                target_id := chapter_id_value;
            END IF;
        END IF;

        row_kinds := array_append(row_kinds, input_kind);
        target_ids := array_append(target_ids, target_id);
        row_index := row_index + 1;
    END LOOP;

    INSERT INTO ledger (series_id, l_seq, door, actor, op, target_ids)
    VALUES (p_series_id, next_l_seq, p_door, p_actor, p_op, target_ids);

    RETURN jsonb_build_object('l_seq', next_l_seq, 'ids', target_ids);
END;
$$;

SELECT axis_intake_backfill();
