/**
 * opencode.ts
 *
 * Reads sessions from opencode's SQLite database (~/.local/share/opencode/opencode.db)
 * and converts them into the common Chunk shape for indexing.
 *
 * opencode data model:
 *   message  — one per turn; JSON `data` field carries `role` (user | assistant)
 *   part     — one or more per message; JSON `data` field carries `type`:
 *              'text'        → text chunk (role from parent message)
 *              'tool'        → tool chunk (name from .tool, args from .state.input,
 *                             output text from .state.output)
 *              other types   → skipped (reasoning, step-start, step-finish, patch, file)
 *
 * Incremental cursor:
 *   The SQLite `rowid` of each `part` row is stable and strictly increasing. We
 *   track the highest rowid processed in the agent-search `meta` table under the
 *   key 'opencode_cursor'. Each run queries `WHERE rowid > cursor`, then advances
 *   the cursor atomically with the chunk inserts.
 *
 * agentType: 'opencode'
 * filePath convention: 'opencode://<sessionId>' (virtual — not a real filesystem path)
 * lineNumber: the part's rowid in the opencode DB (stable, globally unique)
 */

import Database from 'better-sqlite3';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Chunk } from '../types.js';
import type { Store } from '../index/store.js';
import { truncate, TOOL_ARGS_MAX, TOOL_RESULT_MAX } from '../text.js';

// ---- public constants ----

export const DEFAULT_OPENCODE_DB_PATH = join(
  homedir(),
  '.local',
  'share',
  'opencode',
  'opencode.db',
);

const META_CURSOR_KEY = 'opencode_cursor';

// ---- internal row shapes ----

interface PartRow {
  rowid: number;
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

interface MessageRow {
  id: string;
  data: string;
}

// ---- OpenCodeSource ----

/**
 * Source that reads chunks from opencode's SQLite database.
 *
 * This is NOT a JSONL adapter — it does not implement the `Adapter` interface.
 * It is a parallel "source" concept: it queries the DB directly and produces
 * `Chunk[]`, which the caller inserts into the agent-search store.
 *
 * Constructor accepts either:
 *   - A path string  → opens with `{ readonly: true }` (production)
 *   - A Database instance → used directly (for tests; caller owns + closes it)
 *
 * Call `.close()` when done if you constructed with a path.
 */
export class OpenCodeSource {
  private readonly db: Database.Database;
  private readonly ownDb: boolean;

  constructor(dbOrPath: string | Database.Database = DEFAULT_OPENCODE_DB_PATH) {
    if (typeof dbOrPath === 'string') {
      // Open read-only so we never accidentally write to opencode's DB.
      // WAL mode allows concurrent reads alongside opencode's writer.
      this.db = new Database(dbOrPath, { readonly: true });
      this.ownDb = true;
    } else {
      this.db = dbOrPath;
      this.ownDb = false;
    }
  }

  /** Close the DB connection — only if this instance opened it. */
  close(): void {
    if (this.ownDb) this.db.close();
  }

  /**
   * Read new parts from opencode (rowid > stored cursor), convert to Chunk[],
   * insert into the store, and advance the cursor.
   *
   * The cursor update and chunk inserts are committed atomically so a crash
   * between the two cannot produce duplicate rows on the next run.
   *
   * The cursor advances even when a batch of parts produces zero indexable
   * chunks (e.g. all were skipped parts), so they are never reprocessed.
   *
   * @returns Number of chunks inserted (0 when nothing is new).
   */
  index(store: Store): number {
    const cursorStr = store.getMeta(META_CURSOR_KEY);
    const cursor = cursorStr !== undefined ? parseInt(cursorStr, 10) : 0;

    // Pull all parts with rowid > cursor in stable insertion order.
    const parts = this.db
      .prepare(
        `SELECT rowid, id, message_id, session_id, time_created, data
         FROM   part
         WHERE  rowid > ?
         ORDER  BY rowid`,
      )
      .all(cursor) as PartRow[];

    if (parts.length === 0) return 0;

    // Resolve message roles. We batch-load to avoid N+1 queries.
    const messageIds = [...new Set(parts.map((p) => p.message_id))];
    const placeholders = messageIds.map(() => '?').join(',');
    const messages = this.db
      .prepare(`SELECT id, data FROM message WHERE id IN (${placeholders})`)
      .all(...messageIds) as MessageRow[];

    const roleByMessageId = new Map<string, 'user' | 'assistant'>();
    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg.data) as { role?: string };
        if (parsed.role === 'user' || parsed.role === 'assistant') {
          roleByMessageId.set(msg.id, parsed.role);
        }
      } catch {
        // Malformed JSON — skip silently.
      }
    }

    // Convert parts to Chunk[].
    const chunks: Chunk[] = [];

    for (const part of parts) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue; // Malformed JSON — skip.
      }

      const type = typeof parsed.type === 'string' ? parsed.type : undefined;
      if (!type) continue;

      const sessionId = part.session_id;
      const filePath = `opencode://${sessionId}`;
      const lineNumber = part.rowid;
      let timestamp: string;
      try {
        timestamp = new Date(part.time_created).toISOString();
      } catch {
        // out-of-range or invalid time_created — fall back to empty string
        timestamp = '';
      }
      // Default to 'assistant' if the message role is unknown (defensive).
      const role = roleByMessageId.get(part.message_id) ?? 'assistant';

      if (type === 'text') {
        const text = typeof parsed.text === 'string' ? parsed.text : '';
        if (!text) continue; // Skip blank text parts.
        chunks.push({
          agentType: 'opencode',
          sessionId,
          filePath,
          lineNumber,
          role,
          text,
          timestamp,
        });
      } else if (type === 'tool') {
        const toolName = typeof parsed.tool === 'string' ? parsed.tool : '';
        if (!toolName) continue;

        const state = parsed.state as
          | { input?: unknown; output?: unknown }
          | undefined;

        const rawArgs = state?.input !== undefined ? JSON.stringify(state.input) : '';
        const args = truncate(rawArgs, TOOL_ARGS_MAX);

        const rawOutput = typeof state?.output === 'string' ? state.output : '';
        const text = truncate(rawOutput, TOOL_RESULT_MAX);

        chunks.push({
          agentType: 'opencode',
          sessionId,
          filePath,
          lineNumber,
          role: 'tool',
          text,
          toolCall: { name: toolName, args },
          timestamp,
        });
      }
      // reasoning, step-start, step-finish, patch, file → not indexed.
    }

    // The new cursor is the highest rowid we processed (regardless of whether
    // it produced an indexable chunk — we must advance past skipped rows too).
    const newCursor = parts[parts.length - 1]!.rowid;

    // Insert chunks and update the cursor in a single atomic transaction.
    // If this instance is called within an existing transaction, better-sqlite3
    // promotes the inner call to a SAVEPOINT automatically.
    store.runTransaction(() => {
      if (chunks.length > 0) {
        store.addChunks(chunks.map((chunk) => ({ chunk })));
      }
      store.setMeta(META_CURSOR_KEY, String(newCursor));
    });

    return chunks.length;
  }
}
