LOCK TABLE chapter_drafts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM chapter_drafts WHERE editor_document IS NOT NULL) THEN
        RAISE EXCEPTION USING ERRCODE = 'AX002', MESSAGE = 'draft editor documents must survive rollback';
    END IF;
END;
$$;

ALTER TABLE chapter_drafts DROP CONSTRAINT chapter_drafts_editor_document_shape, DROP COLUMN editor_document;
DELETE FROM schema_migrations WHERE filename = '0017_draft_editor_document.sql';
