LOCK TABLE chapter_drafts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM chapter_drafts WHERE paragraph_lineage IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'AX002', MESSAGE = 'draft paragraph lineage must survive rollback';
    END IF;
END;
$$;

ALTER TABLE chapter_drafts DROP CONSTRAINT chapter_drafts_paragraph_lineage_shape, DROP COLUMN paragraph_lineage;
DELETE FROM schema_migrations WHERE filename = '0018_draft_paragraph_lineage.sql';
