DROP TABLE scenes;
DROP TABLE blocks;
DROP TYPE time_mode;
DROP TYPE block_kind;
DELETE FROM schema_migrations WHERE filename = '0005_intake_tables.sql';
