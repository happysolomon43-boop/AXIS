CREATE TYPE version_source AS ENUM (
    'draft_edit', 'send', 'reupload', 'restore', 'import', 'bulk_replace', 'checkpoint'
);

CREATE TABLE chapters (
    id text PRIMARY KEY DEFAULT ('ch_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    book_id text NOT NULL REFERENCES books (id) ON DELETE RESTRICT,
    order_key text NOT NULL CHECK (order_key ~ '^[0-9]{10}$')
);

CREATE INDEX chapters_book_id_idx ON chapters (book_id, order_key);

CREATE TABLE chapter_versions (
    id text PRIMARY KEY DEFAULT ('ver_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
    series_id text NOT NULL,
    chapter_id text NOT NULL REFERENCES chapters (id) ON DELETE RESTRICT,
    version_no integer NOT NULL CHECK (version_no >= 1),
    source version_source NOT NULL,
    content text NOT NULL CHECK (char_length(content) <= 1000000),
    text_hash text NOT NULL CHECK (text_hash ~ '^[0-9a-f]{64}$'),
    hints_hash text NOT NULL CHECK (hints_hash ~ '^[0-9a-f]{64}$'),
    parent_version text,
    l_seq bigint NOT NULL CHECK (l_seq >= 1),
    UNIQUE (chapter_id, version_no),
    UNIQUE (chapter_id, id),
    FOREIGN KEY (chapter_id, parent_version) REFERENCES chapter_versions (chapter_id, id) ON DELETE RESTRICT,
    CHECK ((version_no = 1) = (parent_version IS NULL)),
    FOREIGN KEY (series_id, l_seq) REFERENCES ledger (series_id, l_seq) DEFERRABLE INITIALLY DEFERRED
);

CREATE TABLE chapter_active (
    series_id text NOT NULL,
    chapter_id text NOT NULL REFERENCES chapters (id) ON DELETE RESTRICT,
    version_id text,
    since_l bigint NOT NULL CHECK (since_l >= 1),
    PRIMARY KEY (chapter_id, since_l),
    FOREIGN KEY (chapter_id, version_id) REFERENCES chapter_versions (chapter_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (series_id, since_l) REFERENCES ledger (series_id, l_seq) DEFERRABLE INITIALLY DEFERRED
);

CREATE TRIGGER chapter_versions_immutable
    BEFORE UPDATE OR DELETE ON chapter_versions
    FOR EACH ROW EXECUTE FUNCTION axis_reject_change();

CREATE TRIGGER chapter_active_immutable
    BEFORE UPDATE OR DELETE ON chapter_active
    FOR EACH ROW EXECUTE FUNCTION axis_reject_change();
