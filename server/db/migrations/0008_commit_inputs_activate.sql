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
                valid_row := input_row - ARRAY['kind', 'chapter_id', 'chapter_ref', 'content', 'source', 'parent_version', 'hints', 'activate'] = '{}'::jsonb
                    AND jsonb_typeof(input_row -> 'content') = 'string'
                    AND jsonb_typeof(input_row -> 'source') = 'string'
                    AND (
                        NOT (input_row ? 'parent_version')
                        OR jsonb_typeof(input_row -> 'parent_version') IN ('string', 'null')
                    )
                    AND (
                        NOT (input_row ? 'hints')
                        OR jsonb_typeof(input_row -> 'hints') IN ('array', 'null')
                    )
                    AND (
                        NOT (input_row ? 'activate')
                        OR jsonb_typeof(input_row -> 'activate') IN ('boolean', 'null')
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
                IF (input_row -> 'activate') = 'true'::jsonb THEN
                    INSERT INTO chapter_active (series_id, chapter_id, version_id, since_l)
                    VALUES (p_series_id, chapter_id_value, target_id, next_l_seq);
                END IF;
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
