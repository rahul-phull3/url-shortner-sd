import pg from "pg";
import { SqlRepository } from "./sql-repository.ts";

export function connectPostgres(connectionString: string) {
  // TLS is configured using PostgreSQL connection parameters, including sslmode=verify-full.
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30000,
    statement_timeout: 3000,
    query_timeout: 3500,
  });
  const repo = new SqlRepository(async (sql, params = []) => {
    let index = 0;
    const text = sql.replace(/\?/g, () => `$${++index}`);
    const result = await pool.query(text, params);
    return result.rows;
  });
  return { pool, repo };
}
