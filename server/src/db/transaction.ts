import type { Pool, PoolClient } from "pg";
import { reportFailure } from "../logging.js";

export const readOnlyTransaction = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

export async function transaction<T>(
  pool: Pool,
  begin: "BEGIN" | typeof readOnlyTransaction,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query(begin);
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      discard = true;
      reportFailure("database_rollback_failed", rollbackError);
    }
    throw error;
  } finally {
    client.release(discard);
  }
}
