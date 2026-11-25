DROP TABLE chapter_active;
DROP TABLE chapter_versions;
DROP TABLE chapters;
DROP TYPE version_source;
DELETE FROM schema_migrations WHERE filename = '0003_corpus.sql';
