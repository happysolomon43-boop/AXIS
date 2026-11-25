DROP FUNCTION commit_inputs(text, text, text, text, jsonb);
DELETE FROM schema_migrations WHERE filename = '0004_commit_inputs.sql';
