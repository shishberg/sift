# Session Log via ai-elements (rendered from raw log) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web session view a faithful viewer of the raw session log (full, paired tool input/output) and render it with vendored `ai-elements-vue` `Message` + `Tool` components.

**Architecture:** Two layers. **Layer A (backend):** a new "render" read path that, given a session id, finds its source files via the index, parses each raw log faithfully (untruncated, tool calls paired with their results), and returns ordered `TranscriptItem[]`. The DB stays the search index — it only answers "which files belong to this session" and supplies cwd. **Layer B (frontend):** vendor trimmed `Message`/`Tool` components (no heavy deps) and rewrite `SessionView` to consume the richer data, keeping match-highlight + scroll and line numbers.

**Tech Stack:** TypeScript, Node, better-sqlite3, vitest (backend). Vue 3 + Vite + reka-ui + Tailwind 4 + markdown-it (frontend).

## Global Constraints

- **Read-only:** never write/modify the session logs or opencode's DB. (`.mex/context/decisions.md:112`)
- **No new heavy deps.** Do NOT add `ai`, `@lucide/vue`, `vue-stream-markdown`, or shiki/`code-block`. Vendor trimmed components. Icons = inline SVG.
- **Keep markdown-it** (`web/src/lib/markdown.ts` `renderMarkdown`) for prose. Do NOT use `MessageResponse`.
- **Tool input/output render as plain `<pre>`** — no syntax highlighting.
- **Thinking blocks stay dropped.**
- **The index schema and ingest path (`parseLine`, adapters, opencode `index()`) are unchanged.** New render code is separate.
- Backend tests live next to source (`src/render/x.test.ts`). Run: `npx vitest run <path>`. Full suite: `npm test`.
- Frontend has no unit-test harness; the gate is `npm run web:build` (runs `vue-tsc --noEmit` + `vite build`).

---

## Layer A — backend

### Task A1: Transcript types + shared result-text helper

**Files:**
- Modify: `src/types.ts` (append new exports)
- Create: `src/render/shared.ts`
- Test: `src/render/shared.test.ts`

**Interfaces:**
- Produces:
  - `TranscriptItem` — `{ role: 'user'|'assistant'|'tool'; text: string; tool?: ToolDetail; filePath: string; lineNumbers: number[]; timestamp: string }`
  - `ToolDetail` — `{ name: string; input: string; output?: string; isError?: boolean }`
  - `resultText(content: unknown): string` — claude/pi tool-result content is a string or an array of `{type:'text',text}` blocks; returns the joined text.

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/shared.test.ts
import { describe, it, expect } from 'vitest';
import { resultText } from './shared.js';

describe('resultText', () => {
  it('returns a string as-is', () => {
    expect(resultText('hello')).toBe('hello');
  });
  it('joins text blocks from an array', () => {
    expect(resultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\nb');
  });
  it('returns empty string for anything else', () => {
    expect(resultText(undefined)).toBe('');
    expect(resultText(42)).toBe('');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/shared.test.ts`
Expected: FAIL — cannot find module `./shared.js`.

- [ ] **Step 3: Add the types to `src/types.ts`**

Append to `src/types.ts`:

```typescript
/** One tool call in a faithful transcript: full input, and output once paired. */
export interface ToolDetail {
  name: string;
  /** Full args — a JSON string for object inputs, or the raw string. */
  input: string;
  /** Full result text; undefined until/unless a matching result is found. */
  output?: string;
  isError?: boolean;
}

/**
 * One item in a faithful session transcript, read from the raw log (not the
 * lossy search index). `text` holds untruncated prose for user/assistant; tool
 * items carry `tool` instead. `lineNumbers` lists every source log line this
 * item covers (a tool item covers its call line and its result line), so the
 * web view can match-and-scroll from a search result that hit either line.
 */
export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool?: ToolDetail;
  filePath: string;
  lineNumbers: number[];
  timestamp: string;
}
```

- [ ] **Step 4: Create `src/render/shared.ts`**

```typescript
/**
 * Claude and pi tool-result content can be a plain string or an array of
 * content blocks; we only keep the text blocks. Anything else → ''.
 */
export function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Record<string, unknown>[])
      .filter((b) => b['type'] === 'text')
      .map((b) => (b['text'] as string | undefined) ?? '')
      .join('\n');
  }
  return '';
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/render/shared.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/render/shared.ts src/render/shared.test.ts
git commit -m "feat(render): transcript types + shared result-text helper"
```

---

### Task A2: Claude transcript parser

**Files:**
- Create: `src/render/claude.ts`
- Test: `src/render/claude.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem`, `ToolDetail` (A1); `resultText` (A1).
- Produces: `parseClaudeTranscript(lines: string[], filePath: string): TranscriptItem[]`.

Pairing keys (confirmed from fixtures): `tool_use.id` ↔ `tool_result.tool_use_id`; `tool_result.is_error` is the error flag; results live in later `user` messages.

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/claude.test.ts
import { describe, it, expect } from 'vitest';
import { parseClaudeTranscript } from './claude.js';

const FP = '/logs/s.jsonl';

function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parseClaudeTranscript', () => {
  it('emits user/assistant text items with untruncated text', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'user', timestamp: 't1', message: { role: 'user', content: 'hi there' } },
        { type: 'assistant', timestamp: 't2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } },
      ),
      FP,
    );
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ['user', 'hi there'],
      ['assistant', 'hello'],
    ]);
    expect(items[0].filePath).toBe(FP);
    expect(items[0].lineNumbers).toEqual([1]);
  });

  it('pairs tool_use with its later tool_result, covering both line numbers', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'assistant', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: '/x' } }] } },
        { type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', is_error: false, content: 'file body' }] } },
      ),
      FP,
    );
    expect(items).toHaveLength(1);
    expect(items[0].role).toBe('tool');
    expect(items[0].tool).toEqual({ name: 'Read', input: '{"path":"/x"}', output: 'file body', isError: false });
    expect(items[0].lineNumbers).toEqual([1, 2]);
  });

  it('skips thinking blocks and drops empty user-only-tool_result bubbles', () => {
    const items = parseClaudeTranscript(
      lines(
        { type: 'assistant', timestamp: 't1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] } },
        { type: 'user', timestamp: 't2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['tool']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/claude.test.ts`
Expected: FAIL — cannot find module `./claude.js`.

- [ ] **Step 3: Create `src/render/claude.ts`**

```typescript
import type { TranscriptItem } from '../types.js';
import { resultText } from './shared.js';

/**
 * Parse a full claude JSONL transcript faithfully: untruncated text, tool_use
 * paired with its later tool_result (by id), thinking dropped. Order preserved.
 */
export function parseClaudeTranscript(lines: string[], filePath: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndexById = new Map<string, number>();

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = record['type'];
    if (type !== 'user' && type !== 'assistant') return;

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const message = record['message'] as { role?: string; content?: unknown } | undefined;
    if (!message) return;
    const role = message.role === 'user' ? 'user' : 'assistant';
    const content = message.content;

    if (typeof content === 'string') {
      if (content) items.push({ role, text: content, filePath, lineNumbers: [lineNumber], timestamp });
      return;
    }
    if (!Array.isArray(content)) return;

    for (const block of content as Record<string, unknown>[]) {
      const blockType = block['type'] as string | undefined;

      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
      } else if (blockType === 'thinking') {
        continue;
      } else if (blockType === 'tool_use') {
        const id = block['id'] as string | undefined;
        const name = (block['name'] as string | undefined) ?? '';
        const input = block['input'];
        const inputStr = typeof input === 'string' ? input : JSON.stringify(input ?? {});
        items.push({ role: 'tool', text: '', tool: { name, input: inputStr }, filePath, lineNumbers: [lineNumber], timestamp });
        if (id) toolIndexById.set(id, items.length - 1);
      } else if (blockType === 'tool_result') {
        const id = block['tool_use_id'] as string | undefined;
        const output = resultText(block['content']);
        const isError = block['is_error'] === true;
        const idx = id !== undefined ? toolIndexById.get(id) : undefined;
        if (idx !== undefined && items[idx]?.tool) {
          items[idx].tool!.output = output;
          items[idx].tool!.isError = isError;
          items[idx].lineNumbers.push(lineNumber);
        } else {
          // Orphan result (call in another file or out of order): standalone item.
          items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError }, filePath, lineNumbers: [lineNumber], timestamp });
        }
      }
    }
  });

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/claude.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/claude.ts src/render/claude.test.ts
git commit -m "feat(render): faithful claude transcript parser"
```

---

### Task A3: Codex transcript parser

**Files:**
- Create: `src/render/codex.ts`
- Test: `src/render/codex.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` (A1).
- Produces: `parseCodexTranscript(lines: string[], filePath: string): TranscriptItem[]`.

Format (confirmed): records are `{ type:'response_item', timestamp, payload }`. `payload.type` ∈ `message` (role user/assistant/developer; concat `input_text`/`output_text`), `function_call` (`name`, `arguments` string, `call_id`), `function_call_output` (`call_id`, `output` string). Pair by `call_id`. Skip `developer` messages and all other payload types.

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/codex.test.ts
import { describe, it, expect } from 'vitest';
import { parseCodexTranscript } from './codex.js';

const FP = '/logs/rollout.jsonl';
function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parseCodexTranscript', () => {
  it('emits messages and pairs function_call with its output by call_id', () => {
    const items = parseCodexTranscript(
      lines(
        { type: 'response_item', timestamp: 't1', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'run it' }] } },
        { type: 'response_item', timestamp: 't2', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}', call_id: 'c1' } },
        { type: 'response_item', timestamp: 't3', payload: { type: 'function_call_output', call_id: 'c1', output: 'a\nb' } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['user', 'tool']);
    expect(items[0].text).toBe('run it');
    expect(items[1].tool).toEqual({ name: 'shell', input: '{"cmd":"ls"}', output: 'a\nb', isError: false });
    expect(items[1].lineNumbers).toEqual([2, 3]);
  });

  it('skips developer messages and non-response_item lines', () => {
    const items = parseCodexTranscript(
      lines(
        { type: 'session_meta', payload: { cwd: '/x' } },
        { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'instructions' }] } },
        { type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
      ),
      FP,
    );
    expect(items.map((i) => [i.role, i.text])).toEqual([['assistant', 'done']]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/codex.test.ts`
Expected: FAIL — cannot find module `./codex.js`.

- [ ] **Step 3: Create `src/render/codex.ts`**

```typescript
import type { TranscriptItem } from '../types.js';

/**
 * Parse a full codex JSONL transcript faithfully: untruncated message text,
 * function_call paired with function_call_output (by call_id). developer
 * messages and non-content records are skipped. Order preserved.
 */
export function parseCodexTranscript(lines: string[], filePath: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndexByCallId = new Map<string, number>();

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (record['type'] !== 'response_item') return;

    const payload = record['payload'] as Record<string, unknown> | undefined;
    if (!payload) return;
    const payloadType = payload['type'] as string | undefined;
    const timestamp = (record['timestamp'] as string | undefined) ?? '';

    if (payloadType === 'message') {
      const role = payload['role'] as string | undefined;
      if (role !== 'user' && role !== 'assistant') return; // skip developer/system
      const content = payload['content'] as Record<string, unknown>[] | undefined;
      if (!Array.isArray(content)) return;
      const text = content
        .filter((b) => b['type'] === 'input_text' || b['type'] === 'output_text')
        .map((b) => (b['text'] as string | undefined) ?? '')
        .join('');
      if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
    } else if (payloadType === 'function_call') {
      const name = (payload['name'] as string | undefined) ?? '';
      const input = (payload['arguments'] as string | undefined) ?? '';
      const callId = payload['call_id'] as string | undefined;
      items.push({ role: 'tool', text: '', tool: { name, input }, filePath, lineNumbers: [lineNumber], timestamp });
      if (callId) toolIndexByCallId.set(callId, items.length - 1);
    } else if (payloadType === 'function_call_output') {
      const callId = payload['call_id'] as string | undefined;
      const output = (payload['output'] as string | undefined) ?? '';
      const idx = callId !== undefined ? toolIndexByCallId.get(callId) : undefined;
      if (idx !== undefined && items[idx]?.tool) {
        items[idx].tool!.output = output;
        items[idx].tool!.isError = false;
        items[idx].lineNumbers.push(lineNumber);
      } else {
        items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError: false }, filePath, lineNumbers: [lineNumber], timestamp });
      }
    }
  });

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/codex.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/codex.ts src/render/codex.test.ts
git commit -m "feat(render): faithful codex transcript parser"
```

---

### Task A4: Pi transcript parser

**Files:**
- Create: `src/render/pi.ts`
- Test: `src/render/pi.test.ts`

**Interfaces:**
- Consumes: `TranscriptItem` (A1); `resultText` (A1).
- Produces: `parsePiTranscript(lines: string[], filePath: string): TranscriptItem[]`.

Format (confirmed): records `{ type:'message', timestamp, message }`. `message.role` ∈ `user`/`assistant` (content blocks: `text`, `thinking` (skip), `toolCall` with `id`,`name`,`arguments`) or `toolResult` (`toolCallId`, `content` text blocks). Pair `toolCall.id` ↔ `toolResult.toolCallId`.

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/pi.test.ts
import { describe, it, expect } from 'vitest';
import { parsePiTranscript } from './pi.js';

const FP = '/logs/2026_abc.jsonl';
function lines(...records: unknown[]): string[] {
  return records.map((r) => JSON.stringify(r));
}

describe('parsePiTranscript', () => {
  it('emits text, skips thinking, pairs toolCall with toolResult', () => {
    const items = parsePiTranscript(
      lines(
        { type: 'message', timestamp: 't1', message: { role: 'assistant', content: [
          { type: 'thinking', text: 'hmm' },
          { type: 'text', text: 'doing it' },
          { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'ls' } },
        ] } },
        { type: 'message', timestamp: 't2', message: { role: 'toolResult', toolCallId: 'call_1', content: [{ type: 'text', text: 'a\nb' }] } },
      ),
      FP,
    );
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool']);
    expect(items[0].text).toBe('doing it');
    expect(items[1].tool).toEqual({ name: 'bash', input: '{"command":"ls"}', output: 'a\nb', isError: false });
    expect(items[1].lineNumbers).toEqual([1, 2]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/pi.test.ts`
Expected: FAIL — cannot find module `./pi.js`.

- [ ] **Step 3: Create `src/render/pi.ts`**

```typescript
import type { TranscriptItem } from '../types.js';
import { resultText } from './shared.js';

/**
 * Parse a full pi JSONL transcript faithfully: untruncated text, thinking
 * dropped, toolCall paired with its toolResult message (by id). Order kept.
 */
export function parsePiTranscript(lines: string[], filePath: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const toolIndexById = new Map<string, number>();

  lines.forEach((line, i) => {
    const lineNumber = i + 1;
    const trimmed = line.trim();
    if (!trimmed) return;

    let record: Record<string, unknown>;
    try {
      record = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      return;
    }
    if (record['type'] !== 'message') return;

    const timestamp = (record['timestamp'] as string | undefined) ?? '';
    const message = record['message'] as Record<string, unknown> | undefined;
    if (!message) return;
    const role = message['role'] as string | undefined;
    if (!role) return;

    if (role === 'toolResult') {
      const id = message['toolCallId'] as string | undefined;
      const output = resultText(message['content']);
      const idx = id !== undefined ? toolIndexById.get(id) : undefined;
      if (idx !== undefined && items[idx]?.tool) {
        items[idx].tool!.output = output;
        items[idx].tool!.isError = false;
        items[idx].lineNumbers.push(lineNumber);
      } else {
        items.push({ role: 'tool', text: '', tool: { name: '', input: '', output, isError: false }, filePath, lineNumbers: [lineNumber], timestamp });
      }
      return;
    }

    if (role !== 'user' && role !== 'assistant') return;
    const content = message['content'] as Record<string, unknown>[] | undefined;
    if (!Array.isArray(content)) return;

    for (const block of content) {
      const blockType = block['type'] as string | undefined;
      if (blockType === 'text') {
        const text = (block['text'] as string | undefined) ?? '';
        if (text) items.push({ role, text, filePath, lineNumbers: [lineNumber], timestamp });
      } else if (blockType === 'thinking') {
        continue;
      } else if (blockType === 'toolCall') {
        const id = block['id'] as string | undefined;
        const name = (block['name'] as string | undefined) ?? '';
        const rawArgs = block['arguments'];
        const input = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs ?? {});
        items.push({ role: 'tool', text: '', tool: { name, input }, filePath, lineNumbers: [lineNumber], timestamp });
        if (id) toolIndexById.set(id, items.length - 1);
      }
    }
  });

  return items;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/pi.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/render/pi.ts src/render/pi.test.ts
git commit -m "feat(render): faithful pi transcript parser"
```

---

### Task A5: OpenCode transcript reader

**Files:**
- Modify: `src/sources/opencode.ts` (add a method to `OpenCodeSource`)
- Test: `src/sources/opencode.test.ts` (add a `describe` block)

**Interfaces:**
- Consumes: `TranscriptItem`, `ToolDetail` (A1).
- Produces: `OpenCodeSource.readTranscript(sessionId: string): TranscriptItem[]`.

OpenCode stores a tool part with **both** input and output in `data.state` (`state.input`, `state.output`), so no pairing is needed — one `tool` part → one tool item. `text` parts → text items. `lineNumber` = part `rowid` (matches ingest). `filePath` = `opencode://<sessionId>`.

- [ ] **Step 1: Write the failing test**

Check the top of `src/sources/opencode.test.ts` for the existing in-memory DB setup helper and reuse it. Add:

```typescript
// src/sources/opencode.test.ts — add inside the file
describe('readTranscript', () => {
  it('returns text and tool items (input+output) in rowid order', () => {
    // Reuse the file's existing helper that builds an in-memory opencode DB.
    // It must insert: a message row {id:'m1', data:{role:'assistant'}} and parts:
    //   part rowid 1: {type:'text', text:'hi'}
    //   part rowid 2: {type:'tool', tool:'bash', state:{input:{cmd:'ls'}, output:'a\nb'}}
    const db = makeOpencodeDb([
      { id: 'm1', role: 'assistant' },
    ], [
      { rowid: 1, messageId: 'm1', sessionId: 's1', data: { type: 'text', text: 'hi' } },
      { rowid: 2, messageId: 'm1', sessionId: 's1', data: { type: 'tool', tool: 'bash', state: { input: { cmd: 'ls' }, output: 'a\nb' } } },
    ]);
    const source = new OpenCodeSource(db);
    const items = source.readTranscript('s1');
    expect(items.map((i) => i.role)).toEqual(['assistant', 'tool']);
    expect(items[0]).toMatchObject({ text: 'hi', filePath: 'opencode://s1', lineNumbers: [1] });
    expect(items[1].tool).toEqual({ name: 'bash', input: '{"cmd":"ls"}', output: 'a\nb', isError: false });
    expect(items[1].lineNumbers).toEqual([2]);
  });
});
```

> NOTE for implementer: adapt the fixture calls to the file's **existing** helper for building an opencode DB (the `index()` tests already create one). If there is no reusable helper, build the in-memory DB inline with `new Database(':memory:')`, create `message(id TEXT, data TEXT)` and `part(rowid INTEGER PRIMARY KEY, id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT)`, insert the rows above with `data` JSON-stringified, and pass the `Database` instance to `new OpenCodeSource(db)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/sources/opencode.test.ts -t readTranscript`
Expected: FAIL — `source.readTranscript is not a function`.

- [ ] **Step 3: Add `readTranscript` to `OpenCodeSource`**

Add `import type { TranscriptItem } from '../types.js';` to the top of `src/sources/opencode.ts`, then add this method to the class:

```typescript
  /**
   * Faithful transcript for one session, read from opencode's DB. Unlike the
   * lossy `index()` path, text and tool output are untruncated. Each tool part
   * already carries input + output in `state`, so no pairing is needed.
   */
  readTranscript(sessionId: string): TranscriptItem[] {
    const parts = this.db
      .prepare(
        `SELECT rowid, message_id, time_created, data
         FROM   part
         WHERE  session_id = ?
         ORDER  BY rowid`,
      )
      .all(sessionId) as Array<{ rowid: number; message_id: string; time_created: number; data: string }>;
    if (parts.length === 0) return [];

    const messageIds = [...new Set(parts.map((p) => p.message_id))];
    const placeholders = messageIds.map(() => '?').join(',');
    const messages = this.db
      .prepare(`SELECT id, data FROM message WHERE id IN (${placeholders})`)
      .all(...messageIds) as Array<{ id: string; data: string }>;
    const roleByMessageId = new Map<string, 'user' | 'assistant'>();
    for (const msg of messages) {
      try {
        const parsed = JSON.parse(msg.data) as { role?: string };
        if (parsed.role === 'user' || parsed.role === 'assistant') roleByMessageId.set(msg.id, parsed.role);
      } catch {
        // skip
      }
    }

    const filePath = `opencode://${sessionId}`;
    const items: TranscriptItem[] = [];
    for (const part of parts) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(part.data) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = typeof parsed['type'] === 'string' ? (parsed['type'] as string) : undefined;
      if (!type) continue;
      let timestamp = '';
      try {
        timestamp = new Date(part.time_created).toISOString();
      } catch {
        timestamp = '';
      }
      const role = roleByMessageId.get(part.message_id) ?? 'assistant';

      if (type === 'text') {
        const text = typeof parsed['text'] === 'string' ? (parsed['text'] as string) : '';
        if (text) items.push({ role, text, filePath, lineNumbers: [part.rowid], timestamp });
      } else if (type === 'tool') {
        const name = typeof parsed['tool'] === 'string' ? (parsed['tool'] as string) : '';
        if (!name) continue;
        const state = parsed['state'] as { input?: unknown; output?: unknown; status?: unknown } | undefined;
        const input = state?.input !== undefined ? JSON.stringify(state.input) : '';
        const output =
          typeof state?.output === 'string' ? state.output : state?.output !== undefined ? JSON.stringify(state.output) : undefined;
        const isError = state?.status === 'error';
        items.push({ role: 'tool', text: '', tool: { name, input, output, isError }, filePath, lineNumbers: [part.rowid], timestamp });
      }
    }
    return items;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/sources/opencode.test.ts -t readTranscript`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/sources/opencode.ts src/sources/opencode.test.ts
git commit -m "feat(render): opencode faithful transcript reader"
```

---

### Task A6: Store method — files for a session

**Files:**
- Modify: `src/index/store.ts`
- Test: `src/index/store.test.ts` (add a test)

**Interfaces:**
- Produces: `Store.getSessionFiles(sessionId: string): { filePath: string; agentType: string }[]` — distinct `(file_path, agent_type)` for the session, ordered by `file_path`.

- [ ] **Step 1: Write the failing test**

Reuse the existing in-memory store + `addChunks` helpers in `src/index/store.test.ts`. Add:

```typescript
it('getSessionFiles returns distinct file/agent for a session, ordered', () => {
  // store is the existing test fixture; insert two chunks in one file + one in another.
  store.addChunks([
    { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/b.jsonl', lineNumber: 1, role: 'user', text: 'a', timestamp: 't' } },
    { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/b.jsonl', lineNumber: 2, role: 'assistant', text: 'b', timestamp: 't' } },
    { chunk: { agentType: 'claude', sessionId: 's1', filePath: '/a.jsonl', lineNumber: 1, role: 'user', text: 'c', timestamp: 't' } },
  ]);
  expect(store.getSessionFiles('s1')).toEqual([
    { filePath: '/a.jsonl', agentType: 'claude' },
    { filePath: '/b.jsonl', agentType: 'claude' },
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/index/store.test.ts -t getSessionFiles`
Expected: FAIL — `store.getSessionFiles is not a function`.

- [ ] **Step 3: Implement**

Add the method next to `getSessionChunks` in `src/index/store.ts`:

```typescript
  /** Distinct (file_path, agent_type) for a session, ordered by file_path. */
  getSessionFiles(sessionId: string): { filePath: string; agentType: string }[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT file_path AS filePath, agent_type AS agentType
         FROM   chunks
         WHERE  session_id = ?
         ORDER  BY file_path`,
      )
      .all(sessionId) as { filePath: string; agentType: string }[];
    return rows;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/index/store.test.ts -t getSessionFiles`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/index/store.ts src/index/store.test.ts
git commit -m "feat(store): getSessionFiles for the render path"
```

---

### Task A7: Transcript orchestrator

**Files:**
- Create: `src/render/transcript.ts`
- Test: `src/render/transcript.test.ts`

**Interfaces:**
- Consumes: `getSessionFiles` (A6); `parseClaudeTranscript`/`parseCodexTranscript`/`parsePiTranscript` (A2–A4); `OpenCodeSource.readTranscript` (A5); `TranscriptItem` (A1).
- Produces:
  - `interface TranscriptDeps { getSessionFiles(id: string): { filePath: string; agentType: string }[]; readFile(path: string): string; openTranscript(sessionId: string): TranscriptItem[]; }`
  - `readTranscript(sessionId: string, deps: TranscriptDeps): TranscriptItem[]`

Dispatch by `agentType`: `claude`/`codex`/`pi` → read the file, split into lines, run the matching parser; `opencode` → `deps.openTranscript(sessionId)` (called at most once). Concatenate in `getSessionFiles` order.

- [ ] **Step 1: Write the failing test**

```typescript
// src/render/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { readTranscript } from './transcript.js';

describe('readTranscript', () => {
  it('dispatches jsonl files to the right parser and concatenates in order', () => {
    const files = [
      { filePath: '/c.jsonl', agentType: 'claude' },
      { filePath: '/x.jsonl', agentType: 'codex' },
    ];
    const fileBodies: Record<string, string> = {
      '/c.jsonl': JSON.stringify({ type: 'user', timestamp: 't', message: { role: 'user', content: 'hi' } }),
      '/x.jsonl': JSON.stringify({ type: 'response_item', timestamp: 't', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'yo' }] } }),
    };
    const items = readTranscript('s1', {
      getSessionFiles: () => files,
      readFile: (p) => fileBodies[p],
      openTranscript: () => [],
    });
    expect(items.map((i) => [i.role, i.text])).toEqual([['user', 'hi'], ['assistant', 'yo']]);
  });

  it('routes opencode sessions to openTranscript', () => {
    const items = readTranscript('s1', {
      getSessionFiles: () => [{ filePath: 'opencode://s1', agentType: 'opencode' }],
      readFile: () => { throw new Error('should not read files for opencode'); },
      openTranscript: (id) => [{ role: 'assistant', text: 'oc ' + id, tool: undefined, filePath: 'opencode://s1', lineNumbers: [1], timestamp: 't' }],
    });
    expect(items).toEqual([{ role: 'assistant', text: 'oc s1', tool: undefined, filePath: 'opencode://s1', lineNumbers: [1], timestamp: 't' }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/render/transcript.test.ts`
Expected: FAIL — cannot find module `./transcript.js`.

- [ ] **Step 3: Create `src/render/transcript.ts`**

```typescript
import type { TranscriptItem } from '../types.js';
import { parseClaudeTranscript } from './claude.js';
import { parseCodexTranscript } from './codex.js';
import { parsePiTranscript } from './pi.js';

export interface TranscriptDeps {
  getSessionFiles(sessionId: string): { filePath: string; agentType: string }[];
  readFile(path: string): string;
  /** Returns the full opencode transcript for the session (DB-backed). */
  openTranscript(sessionId: string): TranscriptItem[];
}

/**
 * Build a faithful transcript for a session from its raw log file(s). The index
 * only tells us which files belong to the session; content comes from the logs.
 */
export function readTranscript(sessionId: string, deps: TranscriptDeps): TranscriptItem[] {
  const files = deps.getSessionFiles(sessionId);
  const out: TranscriptItem[] = [];
  let openHandled = false;

  for (const { filePath, agentType } of files) {
    if (agentType === 'opencode') {
      if (!openHandled) {
        out.push(...deps.openTranscript(sessionId));
        openHandled = true;
      }
      continue;
    }
    let body: string;
    try {
      body = deps.readFile(filePath);
    } catch {
      continue; // log file gone/unreadable — skip it
    }
    const lines = body.split('\n');
    if (agentType === 'claude') out.push(...parseClaudeTranscript(lines, filePath));
    else if (agentType === 'codex') out.push(...parseCodexTranscript(lines, filePath));
    else if (agentType === 'pi') out.push(...parsePiTranscript(lines, filePath));
  }

  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/render/transcript.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/render/transcript.ts src/render/transcript.test.ts
git commit -m "feat(render): transcript orchestrator"
```

---

### Task A8: Wire the render path into the server response

**Files:**
- Modify: `src/server/server.ts` (the `SessionResponse` interface + `getSession` dep type)
- Modify: `src/cli/cli.ts` (the `getSession` implementation, ~lines 708-716)
- Test: `src/server/server.test.ts` (update the session-route test)

**Interfaces:**
- Produces (server `SessionResponse`): `{ sessionId: string; agentType: string | null; filePath: string; cwd: string; items: TranscriptItem[] }`.

- [ ] **Step 1: Update the server's `SessionResponse` type**

In `src/server/server.ts`, find the `SessionResponse` interface (around lines 27-33, fields `sessionId/filePath/cwd/chunks`). Replace its body with:

```typescript
  sessionId: string;
  /** Agent that produced the session; null if unknown. */
  agentType: string | null;
  /** First real log file path (for the copy-path button). '' if none. */
  filePath: string;
  /** Working directory relative to $HOME; '' if not recorded. */
  cwd: string;
  items: TranscriptItem[];
```

Add the import at the top of `src/server/server.ts`:

```typescript
import type { TranscriptItem } from '../types.js';
```

(If `SessionResponse` currently imports/uses `Chunk`, drop that usage — the route handler just passes the object through, so no other server.ts change is needed.)

- [ ] **Step 2: Update the session-route test**

In `src/server/server.test.ts`, find the test that stubs `getSession` and asserts the response. Update the stub to return the new shape and assert on `items`:

```typescript
// stub passed to startServer:
getSession: (id: string) => ({
  sessionId: id,
  agentType: 'claude',
  filePath: '/logs/s.jsonl',
  cwd: '~/proj',
  items: [{ role: 'user', text: 'hi', tool: undefined, filePath: '/logs/s.jsonl', lineNumbers: [1], timestamp: 't' }],
}),
// ...in the assertion:
expect(body.items[0].text).toBe('hi');
expect(body.agentType).toBe('claude');
```

- [ ] **Step 3: Run the server test to verify it fails**

Run: `npx vitest run src/server/server.test.ts`
Expected: FAIL — type/shape mismatch (`items` undefined or type error).

- [ ] **Step 4: Rewrite `getSession` in `src/cli/cli.ts`**

Add imports near the top of `src/cli/cli.ts`:

```typescript
import { readFileSync } from 'node:fs';
import { readTranscript } from '../render/transcript.js';
import { OpenCodeSource } from '../sources/opencode.js';
```

Replace the `getSession` block (currently lines ~708-716) with:

```typescript
        getSession: (sessionId) => {
          const items = readTranscript(sessionId, {
            getSessionFiles: (id) => store.getSessionFiles(id),
            readFile: (p) => readFileSync(p, 'utf8'),
            openTranscript: (id) => {
              const source = new OpenCodeSource();
              try {
                return source.readTranscript(id);
              } finally {
                source.close();
              }
            },
          });
          const files = store.getSessionFiles(sessionId);
          const realFile = files.find((f) => f.agentType !== 'opencode')?.filePath ?? files[0]?.filePath ?? '';
          return {
            sessionId,
            agentType: files[0]?.agentType ?? null,
            filePath: realFile,
            cwd: homeRelative(store.getSessionCwd(sessionId) ?? '', homedir()),
            items,
          };
        },
```

- [ ] **Step 5: Run the server test + full backend suite**

Run: `npx vitest run src/server/server.test.ts && npm test`
Expected: PASS. (If any other test referenced the old `chunks` field on the session response, update it to `items`.)

- [ ] **Step 6: Typecheck backend**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add src/server/server.ts src/cli/cli.ts src/server/server.test.ts
git commit -m "feat(server): session endpoint renders faithful transcript from raw log"
```

---

## Layer B — frontend

### Task B1: Vendor trimmed Message + Tool components + collapsible

**Files:**
- Create: `web/src/components/ui/collapsible/index.ts`
- Create: `web/src/components/ai-elements/message/Message.vue`
- Create: `web/src/components/ai-elements/message/MessageContent.vue`
- Create: `web/src/components/ai-elements/message/index.ts`
- Create: `web/src/components/ai-elements/tool/Tool.vue`
- Create: `web/src/components/ai-elements/tool/ToolHeader.vue`
- Create: `web/src/components/ai-elements/tool/ToolContent.vue`
- Create: `web/src/components/ai-elements/tool/ToolInput.vue`
- Create: `web/src/components/ai-elements/tool/ToolOutput.vue`
- Create: `web/src/components/ai-elements/tool/index.ts`

**Interfaces:**
- Produces:
  - `Message` props `{ from: 'user'|'assistant'|'tool'; class?: string }`
  - `MessageContent` props `{ class?: string }` (renders a `.bubble` div; colour comes from the parent `.is-user`/`.is-assistant` class via CSS — Task B5)
  - `Tool` props `{ defaultOpen?: boolean; class?: string }`
  - `ToolHeader` props `{ name: string; isError?: boolean; class?: string }`
  - `ToolContent` props `{ class?: string }`
  - `ToolInput` props `{ input: string; class?: string }`
  - `ToolOutput` props `{ output?: string; isError?: boolean; class?: string }`

These are trimmed from the ai-elements registry: same structure/classnames, but no `ai` SDK types, no lucide (inline SVG), no `code-block`/shiki (plain `<pre>`), no `MessageResponse`.

- [ ] **Step 1: Create the collapsible re-export**

```typescript
// web/src/components/ui/collapsible/index.ts
// shadcn-style thin wrapper over reka-ui's collapsible primitives.
export { CollapsibleRoot as Collapsible, CollapsibleTrigger, CollapsibleContent } from 'reka-ui';
```

- [ ] **Step 2: Create `Message.vue`**

```vue
<!-- web/src/components/ai-elements/message/Message.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{ from: 'user' | 'assistant' | 'tool'; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <div
    :class="cn(
      'group flex w-full max-w-[80%] gap-2',
      props.from === 'user' ? 'is-user ml-auto justify-end' : 'is-assistant',
      props.class,
    )"
    v-bind="$attrs"
  >
    <slot />
  </div>
</template>
```

- [ ] **Step 3: Create `MessageContent.vue`**

```vue
<!-- web/src/components/ai-elements/message/MessageContent.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <!-- .bubble + the parent .is-user/.is-assistant class drive the colours (style.css). -->
  <div :class="cn('bubble flex w-fit flex-col gap-2 overflow-hidden text-sm', props.class)" v-bind="$attrs">
    <slot />
  </div>
</template>
```

- [ ] **Step 4: Create `message/index.ts`**

```typescript
// web/src/components/ai-elements/message/index.ts
export { default as Message } from './Message.vue';
export { default as MessageContent } from './MessageContent.vue';
```

- [ ] **Step 5: Create `Tool.vue`**

```vue
<!-- web/src/components/ai-elements/tool/Tool.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { Collapsible } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{ defaultOpen?: boolean; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <Collapsible
    :default-open="props.defaultOpen ?? false"
    :class="cn('tool-block group w-full rounded-md border', props.class)"
    v-bind="$attrs"
  >
    <slot />
  </Collapsible>
</template>
```

- [ ] **Step 6: Create `ToolHeader.vue`** (inline wrench + chevron SVG; plain status text — no lucide, no badge component)

```vue
<!-- web/src/components/ai-elements/tool/ToolHeader.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{ name: string; isError?: boolean; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <CollapsibleTrigger :class="cn('tool-header flex w-full items-center justify-between gap-4 p-3', props.class)" v-bind="$attrs">
    <span class="flex items-center gap-2">
      <!-- wrench -->
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
        <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2-2 2.5-2.5z" />
      </svg>
      <span class="tool-name font-medium text-sm">{{ props.name || 'tool' }}</span>
      <span class="tool-status" :class="props.isError ? 'tool-status-error' : 'tool-status-ok'">
        {{ props.isError ? 'Error' : 'Completed' }}
      </span>
    </span>
    <!-- chevron (rotates when open via CSS in style.css) -->
    <svg class="tool-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0.6">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  </CollapsibleTrigger>
</template>
```

- [ ] **Step 7: Create `ToolContent.vue`**

```vue
<!-- web/src/components/ai-elements/tool/ToolContent.vue -->
<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { CollapsibleContent } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';

const props = defineProps<{ class?: HTMLAttributes['class'] }>();
</script>

<template>
  <CollapsibleContent :class="cn('tool-content', props.class)" v-bind="$attrs">
    <slot />
  </CollapsibleContent>
</template>
```

- [ ] **Step 8: Create `ToolInput.vue`** (plain `<pre>`, pretty-print JSON when parseable)

```vue
<!-- web/src/components/ai-elements/tool/ToolInput.vue -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ input: string }>();

const formatted = computed(() => {
  try {
    return JSON.stringify(JSON.parse(props.input), null, 2);
  } catch {
    return props.input;
  }
});
</script>

<template>
  <div class="tool-section">
    <h4 class="tool-section-label">Parameters</h4>
    <pre class="tool-pre">{{ formatted }}</pre>
  </div>
</template>
```

- [ ] **Step 9: Create `ToolOutput.vue`**

```vue
<!-- web/src/components/ai-elements/tool/ToolOutput.vue -->
<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ output?: string; isError?: boolean }>();

const formatted = computed(() => {
  const raw = props.output ?? '';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
});
</script>

<template>
  <div v-if="output" class="tool-section">
    <h4 class="tool-section-label">{{ props.isError ? 'Error' : 'Result' }}</h4>
    <pre class="tool-pre" :class="{ 'tool-pre-error': props.isError }">{{ formatted }}</pre>
  </div>
</template>
```

- [ ] **Step 10: Create `tool/index.ts`**

```typescript
// web/src/components/ai-elements/tool/index.ts
export { default as Tool } from './Tool.vue';
export { default as ToolHeader } from './ToolHeader.vue';
export { default as ToolContent } from './ToolContent.vue';
export { default as ToolInput } from './ToolInput.vue';
export { default as ToolOutput } from './ToolOutput.vue';
```

- [ ] **Step 11: Typecheck (will still pass; components unused yet)**

Run: `npm run --prefix web typecheck`
Expected: no errors.

- [ ] **Step 12: Commit**

```bash
git add web/src/components/ui/collapsible web/src/components/ai-elements
git commit -m "feat(web): vendor trimmed ai-elements Message + Tool components"
```

---

### Task B2: Frontend transcript types

**Files:**
- Modify: `web/src/types.ts`

**Interfaces:**
- Produces: `ToolDetail`, `TranscriptItem`, and an updated `SessionResponse` mirroring the backend (Task A8).

- [ ] **Step 1: Replace `Chunk`/`SessionResponse` in `web/src/types.ts`**

Keep `SearchResult` and `AgentType` and `StatusResponse` as-is. Replace the `Chunk` and `SessionResponse` interfaces with:

```typescript
/** Mirror of backend ToolDetail. */
export interface ToolDetail {
  name: string;
  input: string;
  output?: string;
  isError?: boolean;
}

/** Mirror of backend TranscriptItem (faithful, log-derived). */
export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool';
  text: string;
  tool?: ToolDetail;
  filePath: string;
  lineNumbers: number[];
  timestamp: string;
}

export interface SessionResponse {
  sessionId: string;
  agentType: AgentType | null;
  filePath: string;
  /** Working directory relative to $HOME ('' if unknown). */
  cwd: string;
  items: TranscriptItem[];
}
```

> The old `Chunk` interface is removed. `SearchResult` still has its own `role`/`lineNumber` fields and is unaffected.

- [ ] **Step 2: Typecheck (expected to FAIL — SessionView/App still use old shape)**

Run: `npm run --prefix web typecheck`
Expected: FAIL — `SessionView.vue` references `Chunk`/`chunks`. That's fixed in B3/B4. Proceed.

- [ ] **Step 3: Commit**

```bash
git add web/src/types.ts
git commit -m "feat(web): transcript types mirroring the backend"
```

---

### Task B3: Rewrite SessionView to render the transcript

**Files:**
- Modify: `web/src/views/SessionView.vue` (full rewrite of script + template)

**Interfaces:**
- Consumes: `Message`/`MessageContent` and `Tool`/`ToolHeader`/`ToolContent`/`ToolInput`/`ToolOutput` (B1); `TranscriptItem`/`SessionResponse` (B2); `renderMarkdown` (`web/src/lib/markdown.ts`); `sessionHeader` (updated in B4).

- [ ] **Step 1: Replace the whole file with the transcript version**

```vue
<script setup lang="ts">
import { onMounted, onUnmounted, nextTick, computed, ref } from 'vue';
import { useRoute } from 'vue-router';
import type { SessionResponse, TranscriptItem } from '@/types';
import { renderMarkdown } from '@/lib/markdown';
import { sessionHeader, resetSessionHeader } from '@/lib/sessionHeader';
import { Message, MessageContent } from '@/components/ai-elements/message';
import { Tool, ToolHeader, ToolContent, ToolInput, ToolOutput } from '@/components/ai-elements/tool';

const route = useRoute();

const sessionId = computed(() => route.params.id as string);
const matchFile = computed(() => (route.query.file as string | undefined) ?? '');
const matchLine = computed(() => parseInt((route.query.line as string | undefined) ?? '0', 10));

const session = ref<SessionResponse | null>(null);
const loading = ref(true);
const error = ref('');

async function loadSession(): Promise<void> {
  loading.value = true;
  error.value = '';
  resetSessionHeader();
  sessionHeader.active = true;
  sessionHeader.sessionId = sessionId.value;
  try {
    const res = await fetch('/api/session/' + encodeURIComponent(sessionId.value));
    if (!res.ok) {
      const body = (await res.json()) as { error?: string };
      error.value = body.error ?? ('Server error ' + res.status);
      loading.value = false;
      return;
    }
    session.value = (await res.json()) as SessionResponse;
    sessionHeader.agentType = session.value.agentType;
    sessionHeader.filePath = session.value.filePath;
    sessionHeader.cwd = session.value.cwd;
    loading.value = false;
    await nextTick();
    scrollToMatch();
  } catch (e) {
    error.value = e instanceof Error ? e.message : 'Could not load session.';
    loading.value = false;
  }
}

function isMatch(item: TranscriptItem): boolean {
  return item.filePath === matchFile.value && item.lineNumbers.includes(matchLine.value);
}

function scrollToMatch(): void {
  const el = document.querySelector('[data-matched]') as HTMLElement | null;
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderedHtml(text: string): string {
  return renderMarkdown(text);
}

function itemKey(item: TranscriptItem): string {
  return item.filePath + ':' + item.lineNumbers.join('-');
}

onMounted(() => {
  void loadSession();
});

onUnmounted(() => {
  resetSessionHeader();
});
</script>

<template>
  <div style="max-width: 760px; margin: 0 auto; padding: 28px 24px 48px">
    <div v-if="loading" style="color: var(--muted-fg); font-size: 14px; padding-top: 32px; text-align: center">
      Loading…
    </div>

    <div
      v-if="error"
      class="rounded-md px-4 py-3"
      style="background: #fef2f2; border: 1px solid #fca5a5; color: #991b1b; font-size: 13px"
    >
      {{ error }}
    </div>

    <div v-if="!loading && !error && session" class="flex flex-col" style="gap: 16px">
      <template v-for="item in session.items" :key="itemKey(item)">
        <!-- Tool call -->
        <div
          v-if="item.role === 'tool'"
          :data-matched="isMatch(item) ? '' : undefined"
          :class="['transcript-row', isMatch(item) ? 'chunk-matched' : '']"
        >
          <Tool>
            <ToolHeader :name="item.tool?.name ?? 'tool'" :is-error="item.tool?.isError" />
            <ToolContent>
              <ToolInput v-if="item.tool?.input" :input="item.tool.input" />
              <ToolOutput :output="item.tool?.output" :is-error="item.tool?.isError" />
            </ToolContent>
          </Tool>
          <span class="line-label">:{{ item.lineNumbers[0] }}</span>
        </div>

        <!-- User / assistant message -->
        <div
          v-else
          :data-matched="isMatch(item) ? '' : undefined"
          :class="['transcript-row', isMatch(item) ? 'chunk-matched' : '']"
        >
          <Message :from="item.role">
            <MessageContent>
              <div class="md-body" v-html="renderedHtml(item.text)"></div>
            </MessageContent>
          </Message>
          <span class="line-label" :class="item.role === 'user' ? 'line-label-right' : ''">:{{ item.lineNumbers[0] }}</span>
        </div>
      </template>

      <div v-if="session.items.length === 0" style="color: var(--muted-fg); font-size: 14px">
        This session has no readable messages.
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Typecheck**

Run: `npm run --prefix web typecheck`
Expected: FAIL only on `App.vue`/`sessionHeader` (the `canToggleTools`/`showTools` removal happens in B4). SessionView itself should be clean. Proceed to B4.

- [ ] **Step 3: Commit**

```bash
git add web/src/views/SessionView.vue
git commit -m "feat(web): render session transcript with ai-elements Message + Tool"
```

---

### Task B4: Drop the hide-tools toggle wiring

**Files:**
- Modify: `web/src/lib/sessionHeader.ts`
- Modify: `web/src/App.vue`

**Interfaces:**
- Removes `showTools` and `canToggleTools` from `SessionHeaderState` and `resetSessionHeader`.

- [ ] **Step 1: Edit `web/src/lib/sessionHeader.ts`**

Remove `showTools` and `canToggleTools` from the `SessionHeaderState` interface, from the `reactive(...)` initializer, and from `resetSessionHeader()`. Final file:

```typescript
import { reactive } from 'vue';

export interface SessionHeaderState {
  active: boolean;
  agentType: string | null;
  sessionId: string;
  filePath: string;
  cwd: string;
}

export const sessionHeader = reactive<SessionHeaderState>({
  active: false,
  agentType: null,
  sessionId: '',
  filePath: '',
  cwd: '',
});

export function resetSessionHeader(): void {
  sessionHeader.active = false;
  sessionHeader.agentType = null;
  sessionHeader.sessionId = '';
  sessionHeader.filePath = '';
  sessionHeader.cwd = '';
}
```

- [ ] **Step 2: Edit `web/src/App.vue`** — remove the hide-tools button

Delete the entire `<button v-if="sessionHeader.active && sessionHeader.canToggleTools" ...>…</button>` block (the "hide tools / show tools" toggle, ~lines 134-149). Leave the progress block beside it untouched.

- [ ] **Step 3: Typecheck the whole web app**

Run: `npm run --prefix web typecheck`
Expected: PASS (no remaining references to `chunks`, `showTools`, or `canToggleTools`).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/sessionHeader.ts web/src/App.vue
git commit -m "feat(web): drop global hide-tools toggle (per-tool collapse replaces it)"
```

---

### Task B5: Swap the message CSS for bubbles + tool styles

**Files:**
- Modify: `web/src/style.css`

**Interfaces:** none (styling only). Uses existing CSS vars: `--user-bg/--user-border/--user-text`, `--assistant-bg/--assistant-border/--assistant-text`, `--surface`, `--border`, `--muted-fg`, `--fg`, `--violet`.

- [ ] **Step 1: Remove the dead message-chrome CSS**

Delete these rule blocks from `web/src/style.css`: `.role-rule`, `.role-label`, `.rule-line` (the "Role rule" section ~lines 105-128) and `.msg`, `.msg-user`, `.msg-assistant`, `.msg-user .role-label`, `.msg-assistant .role-label` (the "Message boxes" section ~lines 200-220). **Keep** `.md-body …` and `.chunk-matched`.

- [ ] **Step 2: Add bubble + tool + line-label CSS**

Add near where `.msg` used to be:

```css
/* ── Transcript rows ───────────────────────────────────────────────────── */
.transcript-row {
  position: relative;
}
.line-label {
  display: block;
  margin-top: 2px;
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 10px;
  color: var(--border);
  letter-spacing: 0.02em;
}
.line-label-right {
  text-align: right;
}

/* ── Message bubbles (ai-elements Message + our colours) ───────────────── */
.bubble {
  border-radius: 8px;
  padding: 12px 16px;
  border: 1px solid var(--border);
  background: var(--white);
}
.is-user .bubble {
  background: var(--user-bg);
  border-color: var(--user-border);
  color: var(--user-text);
}
.is-assistant .bubble {
  background: var(--assistant-bg);
  border-color: var(--assistant-border);
  color: var(--assistant-text);
}

/* ── Tool block (ai-elements Tool) ─────────────────────────────────────── */
.tool-block {
  border-color: var(--border);
  background: var(--white);
}
.tool-header {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--fg);
  font: inherit;
  text-align: left;
}
.tool-header:hover {
  background: var(--surface);
}
.tool-name {
  font-family: "JetBrains Mono", ui-monospace, monospace;
}
.tool-status {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted-fg);
}
.tool-status-error {
  background: #fef2f2;
  color: #991b1b;
}
.tool-chevron {
  transition: transform 0.15s;
}
.tool-block[data-state="open"] .tool-chevron {
  transform: rotate(180deg);
}
.tool-section {
  padding: 0 12px 12px;
}
.tool-section-label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--muted-fg);
  margin: 8px 0 4px;
}
.tool-pre {
  font-family: "JetBrains Mono", ui-monospace, monospace;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted-fg);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  overflow-x: auto;
  white-space: pre-wrap;
  word-break: break-word;
  margin: 0;
}
.tool-pre-error {
  background: #fef2f2;
  border-color: #fca5a5;
  color: #991b1b;
}
```

- [ ] **Step 3: Build the web app (full gate)**

Run: `npm run --prefix web build`
Expected: PASS — `vue-tsc --noEmit` clean, `vite build` succeeds.

- [ ] **Step 4: Commit**

```bash
git add web/src/style.css
git commit -m "feat(web): bubble + tool CSS, remove dead message-chrome styles"
```

---

### Task B6: Manual verification against a real session

**Files:** none (verification only).

- [ ] **Step 1: Run the app**

Use the `/run` skill (or: build the web app, then `npm run build` for the backend and start `node dist/cli/cli.js serve --watch`, open the printed URL). Search for a query that hits a tool call, click a result.

- [ ] **Step 2: Confirm, with eyes on the screen:**
  - User messages are right-aligned bubbles in the user colour; assistant left-aligned in the assistant colour.
  - Tool calls show as collapsed blocks with the tool name + status; expanding shows full (untruncated) Parameters and Result.
  - The searched-into message/tool has the violet ring and the page scrolled to it.
  - Line numbers (`:NN`) show beside items.
  - No "show/hide tools" button remains in the header.

- [ ] **Step 3: Run the full backend suite once more**

Run: `npm test`
Expected: PASS.

---

## Self-Review

**Spec coverage:**
- Render from raw log, DB = index + file lookup → A6 (`getSessionFiles`), A7 (orchestrator), A8 (wiring). ✓
- Per-agent faithful parsers (claude/codex/pi/opencode), paired tool I/O, untruncated, ordered → A2, A3, A4, A5. ✓
- Thinking dropped → A2, A4 (skip `thinking`). ✓
- New response shape with line numbers for match-scroll → A1 (`TranscriptItem.lineNumbers`), B2. ✓
- Vendor Message + Tool, no shiki/MessageResponse/heavy deps → B1. ✓
- User right bubble / assistant left bubble, keep colours → B1 (`Message`), B5 (`.is-user/.is-assistant .bubble`). ✓
- markdown-it kept → B3 (`renderMarkdown` into `MessageContent`). ✓
- Match highlight + scroll, line numbers kept → B3 (`isMatch`, `scrollToMatch`, `.line-label`), B5 (`.chunk-matched` retained). ✓
- Drop role rules + global hide-tools toggle → B4, B5. ✓
- Remove dead CSS, keep `.md-body`/`.chunk-matched` → B5. ✓

**Placeholder scan:** The only deferred detail is the opencode test fixture builder in A5 Step 1, which has an explicit NOTE telling the implementer to reuse the file's existing helper or build the `:memory:` DB inline with the given schema — concrete, not a TODO.

**Type consistency:** `TranscriptItem`/`ToolDetail` field names (`role`, `text`, `tool`, `tool.name/input/output/isError`, `filePath`, `lineNumbers`, `timestamp`) are identical across A1 (backend), all parsers (A2–A5), the orchestrator (A7), the server response (A8), and the frontend mirror (B2). Component prop names (`from`, `name`, `input`, `output`, `isError`, `defaultOpen`) match between B1 (definitions) and B3 (usage). `getSessionFiles` returns `{ filePath, agentType }` consistently in A6, A7, A8.
