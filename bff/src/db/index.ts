import { Pool } from 'pg';
import type { AppConfig } from '../config/index.js';

export function createDbPool(config: AppConfig): Pool {
  return new Pool({ connectionString: config.database.url });
}

/**
 * Simple connectivity check used by the health route.
 * Does not leak connection details into the response.
 */
export async function checkDb(pool: Pool): Promise<boolean> {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
