CREATE FUNCTION axis_word_count(p_text text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
    folded text := axis_fold(p_text);
BEGIN
    RETURN CASE WHEN folded = '' THEN 0
        ELSE char_length(folded) - char_length(replace(folded, chr(32), '')) + 1
    END;
END;
$$;
