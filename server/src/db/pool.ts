import pg, { type Pool } from "pg";

export function createPool(url: string): Pool {
  const pool = new pg.Pool({ connectionString: url, max: 10 });
  pool.on("error", (error) => {
    console.error(`pg pool error: ${error.message}`);
  });
  return pool;
}
