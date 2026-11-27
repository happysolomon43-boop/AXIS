export type SeriesRow = {
  id: string;
  owner_id: string;
  title: string;
  genre_rubric_id: string | null;
  foundation: object;
};

export type BookRow = {
  id: string;
  series_id: string;
  title: string;
  ordinal: number;
  label: string | null;
  status: "planned" | "drafting" | "complete" | "released";
  author_id: string;
  language: string;
};

export type SeriesTree = { series: SeriesRow; books: BookRow[] };

export type ChapterRow = {
  id: string;
  book_id: string;
  order_key: string;
};

export type VersionRow = {
  id: string;
  chapter_id: string;
  version_no: number;
  source: string;
  text_hash: string;
  hints_hash: string;
  parent_version: string | null;
  l_seq: number;
};

export type ChapterCreated = { chapter: ChapterRow; version: VersionRow };

export type ChapterSync = {
  state: "draft_only" | "in_book" | "edited" | "being_revised";
  same: boolean;
};

export type PullBackRequest = { expected_active_version_id: string };
export type PullBackConflictReason = "released_book" | "active_changed" | "base_choice_required";
export type PullBackWritten = { chapter: ChapterRow; active_version_id: string };

export type ChapterListItem = ChapterRow & {
  title: string | null;
  word_count: number;
  version_id: string | null;
  active_version_id: string | null;
  sync?: ChapterSync;
};

export type BlockRow = {
  block_uid: string;
  ordinal: number;
  kind: "paragraph" | "heading" | "scene_break";
  text: string;
  hash: string;
};

export type SceneRow = {
  ordinal: number;
  fingerprint: string;
  first_block: number;
  last_block: number;
  pov_hint: string | null;
  location_hint: string | null;
  time_hint: string | null;
  time_mode: "linear" | "flashback" | "skip" | "loop";
};

export type VersionDetail = VersionRow & { content: string };
export type ChapterDetail = {
  chapter: ChapterRow;
  version: VersionDetail | null;
  active_version_id: string | null;
  blocks: BlockRow[];
  scenes: SceneRow[];
};
export type VersionWritten = { chapter: ChapterRow; version: VersionRow; active_version_id: string | null; sync?: ChapterSync };
export type WriteOperation = "save" | "send" | "restore" | "keep_mine";
export type WriteRequest = {
  request_id: string;
  content: string;
  parent_version: string;
  base_version: string;
  base_revision: number;
};
export type WriteResult = VersionWritten & {
  request_id: string;
  operation: WriteOperation;
  source_version_id: string | null;
  checkpoint_version_id: string | null;
  current: { version_id: string; revision: number; active_version_id: string | null; sync: ChapterSync };
};

export type DraftBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type DraftHead = { base_version: string; revision: number; content: string; blocks: DraftBlock[] };
export type DraftDetail = { chapter: ChapterRow; draft: DraftHead | null; sync?: ChapterSync };
export type WorkingDraftBlock = DraftBlock & { block_uid: string | null };
export type WorkingDraftHead = Omit<DraftHead, "blocks"> & { blocks: WorkingDraftBlock[] };
export type WorkingState = ChapterDetail & { draft: WorkingDraftHead | null; sync: ChapterSync };
export type DraftWritten = { chapter: ChapterRow; base_version: string; revision: number; sync?: ChapterSync };

export type VersionBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type VersionText = { chapter: ChapterRow; version: VersionRow; blocks: VersionBlock[] };
export type NamedSnapshot = {
  chapter_id: string; version_id: string; kind: "snapshot"; name: string;
  l_seq: number; pack_pins: Record<string, never>; created_at: string;
};
export type HistoryItem = VersionRow & { at: string; word_count: number; snapshot?: NamedSnapshot | null; snapshot_lifecycle?: SnapshotLifecycle | null; can_name_snapshot?: boolean };
export type ChapterHistory = { chapter: ChapterRow; active_version_id: string | null; versions: HistoryItem[] };

export type CaptureRequest = { request_id: string; content: string; base_version: string; base_revision: number; name?: string };
export type CaptureResult = {
  request_id: string; snapshot: NamedSnapshot; version: VersionRow;
  created_version: boolean; draft_current: boolean; active_version_id: string | null; sync: ChapterSync;
};

export type SnapshotLifecycle = { snapshot_id: string; state_token: string; previous_token: string | null };
export type SnapshotLabelAction = { action: "remove"; snapshot_id: string; expected_token: string } | { action: "undo"; snapshot_id: string; expected_token: string; name: string };
export type SnapshotLabelResult = { chapter_id: string; version_id: string; snapshot_lifecycle: SnapshotLifecycle; snapshot: NamedSnapshot | null; can_name_snapshot: boolean };
