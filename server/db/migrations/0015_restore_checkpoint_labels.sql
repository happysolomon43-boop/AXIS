INSERT INTO named_cuts (chapter_id, version_id, series_id, l_seq, label, created_at)
SELECT cv.chapter_id, cv.id, cv.series_id, cv.l_seq, 'Before restore', lg.at
FROM chapter_versions cv
JOIN ledger lg ON lg.series_id = cv.series_id AND lg.l_seq = cv.l_seq
  AND lg.op = 'chapter.checkpoint' AND cv.id = ANY(lg.target_ids)
WHERE cv.source = 'checkpoint'
  AND NOT EXISTS (SELECT 1 FROM named_cuts nc WHERE nc.chapter_id = cv.chapter_id AND nc.version_id = cv.id)
  AND NOT EXISTS (SELECT 1 FROM snapshot_label_lifecycles sl WHERE sl.chapter_id = cv.chapter_id AND sl.version_id = cv.id)
ORDER BY cv.chapter_id, cv.version_no
ON CONFLICT (chapter_id, version_id) DO NOTHING;
