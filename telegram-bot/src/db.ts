import Database, { type Database as Db } from "better-sqlite3";
import type { Logger } from "winston";
import { loadOmnikeyConfig } from "./config";

let dbInstance: Db | null = null;

export function initDb(logger: Logger): Db {
  if (dbInstance) return dbInstance;
  const { sqlitePath } = loadOmnikeyConfig();
  dbInstance = new Database(sqlitePath, {
    readonly: true,
    fileMustExist: true,
  });
  // WAL is set by the writer; we only read. Set busy timeout so concurrent
  // writes from omnikey-ai never throw SQLITE_BUSY at us.
  dbInstance.pragma("busy_timeout = 5000");
  logger.info("Opened SQLite database (read-only)", { path: sqlitePath });
  return dbInstance;
}

export function closeDb(logger?: Logger): void {
  if (!dbInstance) return;
  try {
    dbInstance.close();
    logger?.info("Closed SQLite database");
  } catch (err) {
    logger?.warn("Error closing SQLite database", {
      error: (err as Error).message,
    });
  } finally {
    dbInstance = null;
  }
}

export interface RecentSession {
  readonly id: string;
  readonly title: string;
  readonly turns: number;
  readonly lastActiveAt: string;
  readonly groupName: string | null;
}

export interface SessionRow extends RecentSession {
  readonly historyJson: string;
}

export function getRecentSessions(limit: number): RecentSession[] {
  const db = dbInstance;
  if (!db) throw new Error("Database not initialised. Call initDb() first.");
  const rows = db
    .prepare(
      `SELECT id, title, turns, last_active_at AS lastActiveAt, group_name AS groupName
       FROM agent_sessions
       ORDER BY last_active_at DESC
       LIMIT ?`,
    )
    .all(limit) as RecentSession[];
  return rows;
}

export function getSessionById(sessionId: string): SessionRow | null {
  const db = dbInstance;
  if (!db) throw new Error("Database not initialised. Call initDb() first.");
  const row = db
    .prepare(
      `SELECT id, title, turns, last_active_at AS lastActiveAt, group_name AS groupName, history_json AS historyJson
       FROM agent_sessions
       WHERE id = ?`,
    )
    .get(sessionId) as SessionRow | undefined;
  return row ?? null;
}

export function getMostRecentSession(): SessionRow | null {
  const db = dbInstance;
  if (!db) throw new Error("Database not initialised. Call initDb() first.");
  const row = db
    .prepare(
      `SELECT id, title, turns, last_active_at AS lastActiveAt, group_name AS groupName, history_json AS historyJson
       FROM agent_sessions
       ORDER BY last_active_at DESC
       LIMIT 1`,
    )
    .get() as SessionRow | undefined;
  return row ?? null;
}
