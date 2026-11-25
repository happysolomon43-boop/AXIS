CREATE FUNCTION axis_fold(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT btrim(regexp_replace(
        p_text,
        '[' || chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
            || chr(133) || chr(160) || chr(5760)
            || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
            || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202)
            || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) || ']+',
        ' ', 'g'
    ), ' ');
$$;

CREATE FUNCTION axis_normalize(p_text text)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    SELECT translate(
        axis_fold(p_text),
        chr(8216) || chr(8217) || chr(8218) || chr(8219)
            || chr(8220) || chr(8221) || chr(8222) || chr(8223)
            || chr(8210) || chr(8211) || chr(8212) || chr(8213) || chr(8722),
        repeat(chr(39), 4) || repeat(chr(34), 4) || repeat(chr(45), 5)
    );
$$;

CREATE FUNCTION axis_sentences(p_text text)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    folded text := axis_fold(p_text);
    terminator constant text := '[.!?' || chr(8230) || ']';
    closer constant text := '[' || ']' || ')' || chr(34) || chr(39) || chr(8217) || chr(8221) || ']';
BEGIN
    IF folded = '' THEN
        RETURN ARRAY[]::text[];
    END IF;
    RETURN regexp_split_to_array(
        folded, '(?<=' || terminator || '|' || terminator || closer || ') (?=[^abcdefghijklmnopqrstuvwxyz])'
    );
END;
$$;

CREATE FUNCTION axis_segment(p_content text)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
    WITH input AS (
        SELECT replace(replace(p_content, chr(13) || chr(10), chr(10)), chr(13), chr(10)) AS content,
               chr(9) || chr(10) || chr(11) || chr(12) || chr(13) || chr(32)
                   || chr(133) || chr(160) || chr(5760)
                   || chr(8192) || chr(8193) || chr(8194) || chr(8195) || chr(8196) || chr(8197)
                   || chr(8198) || chr(8199) || chr(8200) || chr(8201) || chr(8202)
                   || chr(8232) || chr(8233) || chr(8239) || chr(8287) || chr(12288) AS whitespace
    ), lines AS (
        SELECT line.value, line.line_no, btrim(line.value, input.whitespace) AS trimmed, input.whitespace
        FROM input, string_to_table(input.content, chr(10)) WITH ORDINALITY AS line(value, line_no)
    ), classified AS (
        SELECT *, CASE
            WHEN trimmed = '' THEN 'blank'
            WHEN trimmed IN ('---', '***', '* * *') THEN 'scene_break'
            WHEN trimmed ~ '^#{1,6} +[^ ]' THEN 'heading'
            ELSE 'paragraph'
        END AS kind
        FROM lines
    ), grouped AS (
        SELECT *, count(*) FILTER (WHERE kind <> 'paragraph') OVER (ORDER BY line_no) AS paragraph_group
        FROM classified
    ), raw_blocks AS (
        SELECT min(line_no) AS first_line, 'paragraph' AS kind,
               btrim(string_agg(value, chr(10) ORDER BY line_no), whitespace) AS text
        FROM grouped WHERE kind = 'paragraph'
        GROUP BY paragraph_group, whitespace
        UNION ALL
        SELECT line_no, kind, CASE WHEN kind = 'heading'
            THEN btrim(regexp_replace(trimmed, '^#{1,6} +', ''), whitespace)
            ELSE trimmed
        END
        FROM classified WHERE kind IN ('heading', 'scene_break')
    ), ordered AS (
        SELECT kind, text, row_number() OVER (ORDER BY first_line) AS ordinal,
               count(*) FILTER (WHERE kind = 'scene_break') OVER (ORDER BY first_line) AS break_group
        FROM raw_blocks
    ), scene_numbers AS (
        SELECT ordinal, dense_rank() OVER (ORDER BY break_group) AS scene
        FROM ordered WHERE kind <> 'scene_break'
    )
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'ordinal', ordered.ordinal, 'kind', ordered.kind, 'text', ordered.text, 'scene', scene_numbers.scene
    ) ORDER BY ordered.ordinal), '[]'::jsonb)
    FROM ordered LEFT JOIN scene_numbers USING (ordinal);
$$;
