DROP FUNCTION axis_segment(text);
DROP FUNCTION axis_sentences(text);
DROP FUNCTION axis_normalize(text);
DROP FUNCTION axis_fold(text);
DELETE FROM schema_migrations WHERE filename = '0006_intake_functions.sql';
