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
