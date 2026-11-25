DROP TRIGGER chapter_versions_clear_draft ON chapter_versions;
DROP FUNCTION axis_clear_draft();
DROP TABLE chapter_drafts;
DELETE FROM schema_migrations WHERE filename = '0010_chapter_drafts.sql';
