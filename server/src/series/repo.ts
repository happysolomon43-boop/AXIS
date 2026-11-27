import { reportFailure } from "../logging.js";
import type { Pool } from "pg";

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

const seriesColumns = "id, owner_id, title, genre_rubric_id, foundation";
const bookColumns = "id, series_id, title, ordinal, label, status, author_id, language";

export async function listSeries(pool: Pool, ownerId: string): Promise<SeriesRow[]> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query<SeriesRow>(
      `SELECT ${seriesColumns} FROM series WHERE owner_id = $1
       ORDER BY title COLLATE "C" ASC, id COLLATE "C" ASC`,
      [ownerId],
    );
    await client.query("COMMIT");
    return rows;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      reportFailure("database_rollback_failed", rollbackError);
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function createSeriesWithFirstBook(
  pool: Pool,
  ownerId: string,
  title: string,
  bookTitle: string,
): Promise<SeriesTree> {
  const client = await pool.connect();
  let discardClient = false;
  try {
    await client.query("BEGIN");
    const { rows: [series] } = await client.query<SeriesRow>(
      `INSERT INTO series (owner_id, title)
       VALUES ($1, $2) RETURNING ${seriesColumns}`,
      [ownerId, title],
    );
    if (!series) throw new Error("Series insert returned no row");

    const { rows: [book] } = await client.query<BookRow>(
      `INSERT INTO books (series_id, title, ordinal, author_id)
       VALUES ($1, $2, 1, $3) RETURNING ${bookColumns}`,
      [series.id, bookTitle, ownerId],
    );
    if (!book) throw new Error("Book insert returned no row");

    await client.query("COMMIT");
    return { series, books: [book] };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      reportFailure("database_rollback_failed", rollbackError);
      discardClient = true;
    }
    throw error;
  } finally {
    client.release(discardClient);
  }
}

export async function getSeriesTree(
  pool: Pool,
  ownerId: string,
  seriesId: string,
): Promise<SeriesTree | null> {
  const { rows: [series] } = await pool.query<SeriesRow>(
    `SELECT ${seriesColumns} FROM series WHERE id = $1 AND owner_id = $2`,
    [seriesId, ownerId],
  );
  if (!series) return null;

  const { rows: books } = await pool.query<BookRow>(
    `SELECT ${bookColumns} FROM books WHERE series_id = $1 ORDER BY ordinal ASC`,
    [seriesId],
  );
  return { series, books };
}
