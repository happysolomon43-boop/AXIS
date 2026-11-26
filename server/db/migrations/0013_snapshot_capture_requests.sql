CREATE TABLE snapshot_capture_requests (
  chapter_id text NOT NULL,
  request_id uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  captured_version_id text NOT NULL,
  draft_base_version_id text NOT NULL,
  draft_base_revision integer NOT NULL CHECK (draft_base_revision BETWEEN 0 AND 2147483647),
  created_version boolean NOT NULL,
  PRIMARY KEY (chapter_id, request_id),
  FOREIGN KEY (chapter_id, captured_version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (chapter_id, draft_base_version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
  CHECK (NOT created_version OR (captured_version_id = draft_base_version_id AND draft_base_revision = 0))
);
