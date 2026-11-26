CREATE TABLE snapshot_label_lifecycles (
  chapter_id text NOT NULL,
  version_id text NOT NULL,
  snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(),
  state_token uuid NOT NULL DEFAULT gen_random_uuid(),
  previous_token uuid NULL DEFAULT NULL,
  removed_name_hash text NULL DEFAULT NULL,
  removed_created_at timestamptz NULL DEFAULT NULL,
  PRIMARY KEY (chapter_id, version_id),
  FOREIGN KEY (chapter_id, version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
  CHECK ((removed_name_hash IS NULL) = (removed_created_at IS NULL)),
  CHECK (removed_name_hash IS NULL OR removed_name_hash ~ '^[0-9a-f]{64}$'),
  CHECK (previous_token IS NULL OR previous_token <> state_token)
);
COMMENT ON COLUMN snapshot_label_lifecycles.removed_name_hash IS 'Content-derived digest; retain for future erase handling.';
INSERT INTO snapshot_label_lifecycles(chapter_id, version_id)
SELECT chapter_id, version_id FROM named_cuts;
ALTER TABLE snapshot_capture_requests ADD COLUMN snapshot_id uuid;
UPDATE snapshot_capture_requests r SET snapshot_id = s.snapshot_id
FROM snapshot_label_lifecycles s WHERE s.chapter_id = r.chapter_id AND s.version_id = r.captured_version_id;
ALTER TABLE snapshot_capture_requests ALTER COLUMN snapshot_id SET NOT NULL;
CREATE FUNCTION axis_track_snapshot_label() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO snapshot_label_lifecycles(chapter_id, version_id) VALUES(NEW.chapter_id, NEW.version_id)
  ON CONFLICT(chapter_id, version_id) DO UPDATE SET snapshot_id=EXCLUDED.snapshot_id,
    state_token=EXCLUDED.state_token, previous_token=NULL, removed_name_hash=NULL, removed_created_at=NULL;
  RETURN NEW;
END;
$$;
CREATE TRIGGER named_cuts_track_snapshot_label AFTER INSERT ON named_cuts
FOR EACH ROW EXECUTE FUNCTION axis_track_snapshot_label();
