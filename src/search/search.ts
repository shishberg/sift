import type { Store } from '../index/store.js';
import type { Embedder } from '../embed/types.js';
import type { Chunk, AgentType } from '../types.js';

// ---------------------------------------------------------------------------
// Result shape
// ---------------------------------------------------------------------------

export interface SearchResult {
  sessionId: string;
  agentType: AgentType;
  filePath: string;
  lineNumber: number;
  role: 'user' | 'assistant' | 'tool';
  snippet: string;
  timestamp: string;
  score: number;
}

// ---------------------------------------------------------------------------
// FTS5 query sanitization
// ---------------------------------------------------------------------------

/**
 * Sanitize a user query string into a safe FTS5 MATCH expression.
 *
 * FTS5 treats many punctuation characters (hyphens, colons, quotes, etc.) as
 * syntax operators, which causes parse errors for queries like `better-sqlite3`
 * or `foo:bar`. Wrapping each whitespace-delimited term in double quotes turns
 * it into a literal phrase search, neutralising all special characters.
 * Embedded double-quote characters inside a token are stripped so they cannot
 * break the quoting.
 *
 * Examples:
 *   `better-sqlite3`         →  `"better-sqlite3"`
 *   `better-sqlite3 WAL`     →  `"better-sqlite3" "WAL"`
 *   `foo:bar`                →  `"foo:bar"`
 *   `say "hello"`            →  `"say" "hello"`  (embedded quotes stripped)
 *   `` (empty)               →  `` (empty — caller skips FTS for empty result)
 */
export function sanitizeFtsQuery(query: string): string {
  const terms = query.trim().split(/\s+/).filter(t => t.length > 0);
  if (terms.length === 0) return '';
  return terms.map(t => '"' + t.replace(/"/g, '') + '"').join(' ');
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 20;

/**
 * Candidate pool size per index.
 * We pull max(limit, 50) candidates from each index so RRF has enough
 * material to work with — especially important when limit < 50.
 */
const POOL_SIZE = 50;

/** RRF constant (k). Score contribution per rank = 1/(k + rank). */
const RRF_K = 60;

/** Max snippet length in characters. */
const SNIPPET_MAX = 200;

// ---------------------------------------------------------------------------
// Pure RRF fusion
// ---------------------------------------------------------------------------

/**
 * Reciprocal Rank Fusion over ranked ID lists.
 *
 * Each sub-array in `lists` is a ranked list of chunk IDs with the best
 * result at index 0 (rank 1). For every (list, position) pair the chunk
 * earns `1/(k + rank)`. Contributions are summed per id, then sorted
 * descending and truncated to `limit`.
 *
 * This is a pure function — safe to unit-test without any DB or embedder.
 *
 * @param lists  Ordered arrays of chunk IDs, one array per search index.
 * @param opts.k      RRF constant (default 60).
 * @param opts.limit  Max entries to return.
 */
export function rrfFuse(
  lists: number[][],
  opts: { k?: number; limit: number },
): Array<{ id: number; score: number }> {
  const k = opts.k ?? RRF_K;
  const scores = new Map<number, number>();

  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const rank = i + 1; // 1-based
      const id = list[i];
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank));
    }
  }

  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit);
}

// ---------------------------------------------------------------------------
// Snippet helper
// ---------------------------------------------------------------------------

function makeSnippet(chunk: Chunk): string {
  if (chunk.text.length > 0) {
    return chunk.text.length <= SNIPPET_MAX
      ? chunk.text
      : chunk.text.slice(0, SNIPPET_MAX);
  }
  if (chunk.toolCall) {
    const raw = `${chunk.toolCall.name} ${chunk.toolCall.args}`;
    return raw.length <= SNIPPET_MAX ? raw : raw.slice(0, SNIPPET_MAX);
  }
  return '';
}

// ---------------------------------------------------------------------------
// Main search function
// ---------------------------------------------------------------------------

/**
 * Search the vector and full-text indexes, merge results with RRF, return
 * the top `limit` results.
 *
 * Candidate pool: each index is queried for `max(limit, 50)` candidates,
 * giving RRF enough material even when `limit` is small.
 *
 * @param query          Plain query string — no operators or syntax.
 * @param deps.store     Index store (injected so tests can use `:memory:`).
 * @param deps.embedder  Local embedder (injected so tests can pass fakes).
 * @param opts.limit     Max results returned (default 20).
 */
export async function search(
  query: string,
  deps: { store: Store; embedder: Embedder },
  opts?: { limit?: number },
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const poolSize = Math.max(limit, POOL_SIZE);

  const { store, embedder } = deps;

  // Embed the query. The embedder applies "search_query: " prefix for kind='query'.
  const [queryEmbedding] = await embedder.embed([query], 'query');

  // Run both indexes. vecSearch handles an empty vec table by returning [].
  // FTS5 MATCH throws on certain punctuation/syntax (e.g. "hello-world",
  // "foo:bar", unmatched quotes). sanitizeFtsQuery wraps each token in double
  // quotes so those cases become literal phrase searches that always parse
  // correctly. The try/catch is kept as a final safety net.
  const vecResults = store.vecSearch(queryEmbedding, poolSize);
  let ftsResults: Array<{ id: number; rank: number }>;
  try {
    const safeQuery = sanitizeFtsQuery(query);
    ftsResults = safeQuery.length > 0 ? store.ftsSearch(safeQuery, poolSize) : [];
  } catch {
    ftsResults = [];
  }

  // Extract ordered ID lists (array index = rank - 1).
  const vecIds = vecResults.map(r => r.id);
  const ftsIds = ftsResults.map(r => r.id);

  // Fuse with RRF.
  const fused = rrfFuse([vecIds, ftsIds], { limit });

  // Load full chunks and build results.
  const results: SearchResult[] = [];
  for (const { id, score } of fused) {
    const chunk = store.getChunk(id);
    if (!chunk) continue; // guard: id should always exist, but be safe
    results.push({
      sessionId: chunk.sessionId,
      agentType: chunk.agentType,
      filePath: chunk.filePath,
      lineNumber: chunk.lineNumber,
      role: chunk.role,
      snippet: makeSnippet(chunk),
      timestamp: chunk.timestamp,
      score,
    });
  }

  return results;
}
