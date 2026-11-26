CREATE TABLE named_cuts (
  chapter_id text NOT NULL,
  version_id text NOT NULL,
  series_id text NOT NULL,
  l_seq bigint NOT NULL CHECK (l_seq >= 1),
  kind text NOT NULL DEFAULT 'snapshot' CHECK (kind = 'snapshot'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 200 AND label = axis_fold(label)),
  pack_pins jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(pack_pins) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chapter_id, version_id),
  FOREIGN KEY (chapter_id, version_id) REFERENCES chapter_versions(chapter_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (series_id, l_seq) REFERENCES ledger(series_id, l_seq) ON DELETE RESTRICT
);
CREATE INDEX named_cuts_ledger_idx ON named_cuts(series_id, l_seq);
