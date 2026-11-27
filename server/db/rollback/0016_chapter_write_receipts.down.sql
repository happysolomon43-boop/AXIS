LOCK TABLE chapter_write_receipts IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM chapter_write_receipts) THEN
        RAISE EXCEPTION USING ERRCODE = 'AX002', MESSAGE = 'write receipts must survive rollback';
    END IF;
END;
$$;

DROP TABLE chapter_write_receipts;
DELETE FROM schema_migrations WHERE filename = '0016_chapter_write_receipts.sql';
