DROP TABLE ledger;
DROP FUNCTION axis_reject_change();
DELETE FROM schema_migrations WHERE filename = '0002_ledger.sql';
