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

export type ChapterListItem = ChapterRow & {
  title: string | null;
  word_count: number;
  version_id: string | null;
  active_version_id: string | null;
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
export type VersionWritten = { chapter: ChapterRow; version: VersionRow; active_version_id: string | null };
export type RestoreWritten = VersionWritten & { checkpoint_version_id: string | null };

export type DraftBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type DraftHead = { base_version: string; revision: number; content: string; blocks: DraftBlock[] };
export type DraftDetail = { chapter: ChapterRow; draft: DraftHead | null };
export type DraftWritten = { chapter: ChapterRow; base_version: string; revision: number };

export type VersionBlock = Pick<BlockRow, "ordinal" | "kind" | "text">;
export type VersionText = { chapter: ChapterRow; version: VersionRow; blocks: VersionBlock[] };
export type HistoryItem = VersionRow & { at: string; word_count: number };
export type ChapterHistory = { chapter: ChapterRow; active_version_id: string | null; versions: HistoryItem[] };
