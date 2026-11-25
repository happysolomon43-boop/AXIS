DROP TABLE books;
DROP TABLE series;
DROP TYPE book_status;
DELETE FROM schema_migrations WHERE filename = '0001_containers.sql';
