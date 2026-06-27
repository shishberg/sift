/**
 * Tests for the byte-offset tail reader.
 *
 * Temp files go to the session scratchpad — never near real agent logs.
 */
import { describe, it, expect } from 'vitest';
import { writeFile, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tailFile } from './tail.js';
import type { TailState, TailResult } from './tail.js';

const SCRATCH =
  '/private/tmp/claude-502/-Users-agent-src-agent-search/4f5a42c3-0fd4-419a-a089-6c6297ac6150/scratchpad';

let counter = 0;
function tmpPath(): string {
  return join(SCRATCH, `tail-test-${process.pid}-${++counter}.jsonl`);
}

// Silence the unused-type import in case TS complains — the import is there to
// verify the type is exported; the tests assert via concrete values.
type _AssertExports = [TailState, TailResult];

// ------------------------------------------------------------------ helpers

/** Byte length of a string in UTF-8 (matches what Node writes to disk). */
function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

// ================================================================== tests

describe('tailFile', () => {
  it('first read of multi-line file returns all complete lines numbered from 1', async () => {
    const path = tmpPath();
    await writeFile(path, 'line one\nline two\nline three\n');
    try {
      const result = await tailFile(path);

      expect(result.rescanned).toBe(false);
      expect(result.lines).toEqual([
        { lineNumber: 1, text: 'line one' },
        { lineNumber: 2, text: 'line two' },
        { lineNumber: 3, text: 'line three' },
      ]);
      expect(result.state.lastLineNumber).toBe(3);
      expect(result.state.lastOffset).toBe(bytes('line one\nline two\nline three\n'));
      expect(typeof result.state.inode).toBe('number');
    } finally {
      await unlink(path);
    }
  });

  it('incremental read returns only new lines with numbers continuing from prior read', async () => {
    const path = tmpPath();
    await writeFile(path, 'line one\nline two\n');
    try {
      const first = await tailFile(path);
      expect(first.lines.map((l) => l.text)).toEqual(['line one', 'line two']);

      await appendFile(path, 'line three\nline four\n');
      const second = await tailFile(path, first.state);

      expect(second.rescanned).toBe(false);
      expect(second.lines).toEqual([
        { lineNumber: 3, text: 'line three' },
        { lineNumber: 4, text: 'line four' },
      ]);
      expect(second.state.lastLineNumber).toBe(4);
    } finally {
      await unlink(path);
    }
  });

  it('holds back trailing partial line (no newline) and returns it once the newline arrives', async () => {
    const path = tmpPath();
    await writeFile(path, 'line one\npartial');
    try {
      const first = await tailFile(path);
      // Only the complete line is returned; 'partial' is held back.
      expect(first.lines).toEqual([{ lineNumber: 1, text: 'line one' }]);
      expect(first.state.lastLineNumber).toBe(1);
      // Offset must point at the start of 'partial', not EOF.
      expect(first.state.lastOffset).toBe(bytes('line one\n'));

      // Complete the partial line then add another.
      await appendFile(path, ' line\nline three\n');
      const second = await tailFile(path, first.state);

      expect(second.rescanned).toBe(false);
      expect(second.lines).toEqual([
        { lineNumber: 2, text: 'partial line' },
        { lineNumber: 3, text: 'line three' },
      ]);
      expect(second.state.lastLineNumber).toBe(3);
    } finally {
      await unlink(path);
    }
  });

  it('rescans from offset 0 when file is truncated (current size < prior lastOffset)', async () => {
    const path = tmpPath();
    await writeFile(path, 'line one\nline two\nline three\n');
    try {
      const first = await tailFile(path);
      expect(first.state.lastOffset).toBeGreaterThan(10);

      // Overwrite with something shorter — simulates log rotation / truncation.
      await writeFile(path, 'short\n');
      const second = await tailFile(path, first.state);

      expect(second.rescanned).toBe(true);
      expect(second.lines).toEqual([{ lineNumber: 1, text: 'short' }]);
      expect(second.state.lastLineNumber).toBe(1);
    } finally {
      await unlink(path);
    }
  });

  it('rescans from offset 0 when inode changes (file deleted and recreated)', async () => {
    const path = tmpPath();
    await writeFile(path, 'original line one\noriginal line two\n');
    try {
      const first = await tailFile(path);
      const priorState = { ...first.state };

      // Delete and recreate — different inode.
      await unlink(path);
      await writeFile(path, 'new file first line\n');

      const second = await tailFile(path, priorState);

      expect(second.rescanned).toBe(true);
      expect(second.lines).toEqual([{ lineNumber: 1, text: 'new file first line' }]);
      expect(second.state.inode).not.toBe(priorState.inode);
    } finally {
      await unlink(path).catch(() => {/* already deleted in test is fine */});
    }
  });

  it('returns empty lines array for an empty file', async () => {
    const path = tmpPath();
    await writeFile(path, '');
    try {
      const result = await tailFile(path);

      expect(result.lines).toEqual([]);
      expect(result.rescanned).toBe(false);
      expect(result.state.lastOffset).toBe(0);
      expect(result.state.lastLineNumber).toBe(0);
    } finally {
      await unlink(path);
    }
  });

  it('holds back the entire file content when there is no trailing newline', async () => {
    const path = tmpPath();
    await writeFile(path, 'no newline at all');
    try {
      const result = await tailFile(path);

      expect(result.lines).toEqual([]);
      // Offset stays at 0 so next read re-reads from the start of the partial.
      expect(result.state.lastOffset).toBe(0);
      expect(result.state.lastLineNumber).toBe(0);
    } finally {
      await unlink(path);
    }
  });

  it('handles no-op call when file has not grown since prior read', async () => {
    const path = tmpPath();
    await writeFile(path, 'line one\n');
    try {
      const first = await tailFile(path);
      expect(first.lines).toHaveLength(1);

      // Call again with same state — file unchanged.
      const second = await tailFile(path, first.state);

      expect(second.lines).toEqual([]);
      expect(second.rescanned).toBe(false);
      expect(second.state.lastOffset).toBe(first.state.lastOffset);
      expect(second.state.lastLineNumber).toBe(first.state.lastLineNumber);
    } finally {
      await unlink(path);
    }
  });

  // ---------------------------------------------------------------- regression

  it('rescans when same-inode file is overwritten with size above lastOffset but below lastSize', async () => {
    // Reproduces the bug where truncation was compared against lastOffset
    // rather than lastSize. When a partial line is held back:
    //   lastOffset = bytes('full line\n')     = 10   <-- start of partial
    //   lastSize   = bytes('full line\nXXXX') = 14
    // An overwrite with 12 bytes (10 < 12 < 14) was NOT detected by
    // "currentSize < lastOffset" (12 >= 10), so the reader started at offset 10
    // inside the new file and returned garbage.
    const path = tmpPath();
    await writeFile(path, 'full line\nXXXX'); // 14 bytes; 'XXXX' is the held-back partial
    try {
      const first = await tailFile(path);
      expect(first.lines).toEqual([{ lineNumber: 1, text: 'full line' }]);
      expect(first.state.lastOffset).toBe(10); // start of 'XXXX'
      expect(first.state.lastSize).toBe(14);

      // Overwrite: 12 bytes — bigger than lastOffset (10) but smaller than lastSize (14).
      // The fix must compare against lastSize, not lastOffset.
      await writeFile(path, 'replaced-ok\n'); // 12 bytes
      expect(bytes('replaced-ok\n')).toBe(12); // sanity

      const second = await tailFile(path, first.state);
      expect(second.rescanned).toBe(true);
      expect(second.lines).toEqual([{ lineNumber: 1, text: 'replaced-ok' }]);
    } finally {
      await unlink(path);
    }
  });

  // ---------------------------------------------------------------- additional coverage

  it('CRLF line endings are stripped and offsets are still byte-accurate', async () => {
    const path = tmpPath();
    // Write CRLF content directly as bytes so the newline style is explicit.
    await writeFile(path, Buffer.from('line one\r\nline two\r\n'));
    try {
      const result = await tailFile(path);
      expect(result.lines).toEqual([
        { lineNumber: 1, text: 'line one' },
        { lineNumber: 2, text: 'line two' },
      ]);
      expect(result.state.lastOffset).toBe(bytes('line one\r\nline two\r\n'));
    } finally {
      await unlink(path);
    }
  });

  it('returns empty-string lines for blank lines in the file', async () => {
    const path = tmpPath();
    await writeFile(path, 'first\n\nthird\n');
    try {
      const result = await tailFile(path);
      expect(result.lines).toEqual([
        { lineNumber: 1, text: 'first' },
        { lineNumber: 2, text: '' },
        { lineNumber: 3, text: 'third' },
      ]);
    } finally {
      await unlink(path);
    }
  });

  it('partial line stays held across multiple calls until newline arrives', async () => {
    const path = tmpPath();
    await writeFile(path, 'done\npart1');
    try {
      const first = await tailFile(path);
      expect(first.lines).toEqual([{ lineNumber: 1, text: 'done' }]);
      expect(first.state.lastOffset).toBe(bytes('done\n'));

      // Append more partial bytes — still no newline.
      await appendFile(path, 'part2');
      const second = await tailFile(path, first.state);
      expect(second.lines).toEqual([]);
      // Offset must not have advanced; still points at start of partial.
      expect(second.state.lastOffset).toBe(bytes('done\n'));

      // Now complete the line.
      await appendFile(path, '\n');
      const third = await tailFile(path, second.state);
      expect(third.lines).toEqual([{ lineNumber: 2, text: 'part1part2' }]);
    } finally {
      await unlink(path);
    }
  });
});
