import pg, { type Pool } from "pg";

import { reportFailure } from "../logging.js";

export function createPool(url: string): Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", (error) => {
    reportFailure("database_pool_failed", error);
  });
  return pool;
}
