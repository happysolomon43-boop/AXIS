CREATE FUNCTION axis_reject_change()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
    RAISE EXCEPTION 'append-only table %', TG_TABLE_NAME USING ERRCODE = 'AX001';
END;
$$;

CREATE TABLE ledger (
    series_id text NOT NULL REFERENCES series (id) ON DELETE RESTRICT,
    l_seq bigint NOT NULL CHECK (l_seq >= 1),
    at timestamptz NOT NULL DEFAULT now(),
    door text NOT NULL CHECK (door IN ('corpus', 'reading', 'writer', 'appraisal', 'pack', 'conversation')),
    actor text NOT NULL CHECK (actor ~ '^usr_[a-z0-9]{2,32}$'),
    op text NOT NULL CHECK (op ~ '^[a-z][a-z0-9_.]{0,63}$'),
    target_ids text[] NOT NULL CHECK (cardinality(target_ids) >= 1),
    PRIMARY KEY (series_id, l_seq)
);

CREATE TRIGGER ledger_immutable
    BEFORE UPDATE OR DELETE ON ledger
    FOR EACH ROW EXECUTE FUNCTION axis_reject_change();
