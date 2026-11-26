DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM snapshot_label_lifecycles WHERE removed_name_hash IS NOT NULL OR removed_created_at IS NOT NULL)
     OR EXISTS (SELECT 1 FROM named_cuts n LEFT JOIN snapshot_label_lifecycles s USING(chapter_id, version_id) WHERE s.chapter_id IS NULL)
     OR EXISTS (SELECT 1 FROM snapshot_label_lifecycles s LEFT JOIN named_cuts n USING(chapter_id, version_id) WHERE n.chapter_id IS NULL)
     OR EXISTS (SELECT 1 FROM snapshot_capture_requests r LEFT JOIN snapshot_label_lifecycles s
       ON s.chapter_id=r.chapter_id AND s.version_id=r.captured_version_id AND s.snapshot_id=r.snapshot_id WHERE s.chapter_id IS NULL)
  THEN RAISE EXCEPTION USING ERRCODE='AX002', MESSAGE='snapshot label lifecycle rollback requires live receipt bindings';
  END IF;
END;
$$;
DROP TRIGGER named_cuts_track_snapshot_label ON named_cuts;
DROP FUNCTION axis_track_snapshot_label();
ALTER TABLE snapshot_capture_requests DROP COLUMN snapshot_id;
DROP TABLE snapshot_label_lifecycles;
DELETE FROM schema_migrations WHERE filename='0014_snapshot_label_lifecycles.sql';
