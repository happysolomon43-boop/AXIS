CREATE TABLE chapter_write_receipts (
    chapter_id text NOT NULL,
    request_id uuid NOT NULL,
    request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    operation text NOT NULL CHECK (operation IN ('save', 'send', 'restore', 'keep_mine')),
    version_id text NOT NULL,
    active_version_id text,
    source_version_id text,
    checkpoint_version_id text,
    PRIMARY KEY (chapter_id, request_id),
    FOREIGN KEY (chapter_id, version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (chapter_id, active_version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (chapter_id, source_version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (chapter_id, checkpoint_version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
    CHECK ((operation = 'restore') = (source_version_id IS NOT NULL)),
    CHECK (checkpoint_version_id IS NULL OR (operation IN ('restore', 'keep_mine') AND checkpoint_version_id <> version_id)),
    CHECK (operation <> 'send' OR active_version_id IS NOT DISTINCT FROM version_id)
);
COMMENT ON COLUMN chapter_write_receipts.request_hash IS 'Content-derived operation fingerprint; retain for future erase handling.';
