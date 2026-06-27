/**
 * Byte-offset tail reader.
 *
 * Pure-ish: reads the filesystem but has no global state, no DB calls, no
 * chokidar. The caller is responsible for persisting TailState between reads.
 *
 * ## Line-number tracking
 * TailState includes `lastLineNumber` — the 1-based number of the last
 * complete line returned in the previous call (0 if nothing has been returned
 * yet). Callers MUST persist this alongside lastOffset/inode/lastSize.
 *
 * ACTION REQUIRED for the indexer task: `source_files` in store.ts does not
 * yet have a `last_line_number` column (nor a matching field on SourceFile).
 * The indexer must add that column and pass lastLineNumber through TailState so
 * adapters receive correct 1-based line numbers for incremental reads.
 */

import { open, stat } from 'node:fs/promises';

// ------------------------------------------------------------------ types

export interface TailState {
  /** inode of the file at the time of the last read. */
  inode: number;
  /** Byte offset of the first un-confirmed byte (start of any held-back partial line). */
  lastOffset: number;
  /** File size observed at the last read. */
  lastSize: number;
  /**
   * 1-based line number of the last complete line returned (0 when nothing
   * has been returned yet, e.g. on first read of an empty or partial-only file).
   */
  lastLineNumber: number;
}

export interface TailLine {
  /** 1-based line number within the file. */
  lineNumber: number;
  /** Line content, newline stripped. */
  text: string;
}

export interface TailResult {
  /** Complete lines read in this call. Empty if nothing new or all partial. */
  lines: TailLine[];
  /** Updated state to persist and pass to the next call. */
  state: TailState;
  /**
   * True when the read started from byte 0 because a truncation or inode
   * change was detected (vs. the normal append case where this is false).
   * False on a first read (no prior state).
   */
  rescanned: boolean;
}

// ------------------------------------------------------------------ main

/**
 * Read only the newly-appended complete lines of a file.
 *
 * Pass the TailState returned by the previous call as `prior`. Omit `prior`
 * (or pass undefined) for the very first read of a file.
 *
 * Guarantees:
 * - Trailing partial line (bytes after the last '\n') is NOT returned; the
 *   returned state's lastOffset points at the start of that partial line so
 *   the next call re-reads those bytes once the newline arrives.
 * - If the file shrank (truncation) or its inode changed (rotation/recreation),
 *   the whole file is re-read from offset 0 and rescanned = true.
 */
export async function tailFile(filePath: string, prior?: TailState): Promise<TailResult> {
  const stats = await stat(filePath);
  const currentInode = stats.ino;
  const currentSize = stats.size;

  // ---- decide start position -----------------------------------------

  // Compare against lastSize (the previously observed EOF), not lastOffset
  // (which may point at the start of a held-back partial line, not EOF).
  // Using lastOffset would miss truncations to a size in the range
  // [lastOffset, lastSize), causing the reader to start mid-file on new content.
  const needRescan =
    prior !== undefined &&
    (prior.inode !== currentInode || currentSize < prior.lastSize);

  let startOffset: number;
  let startLineNumber: number; // 1-based number for the FIRST line we will yield
  let rescanned: boolean;

  if (prior === undefined || needRescan) {
    startOffset = 0;
    startLineNumber = 1;
    rescanned = needRescan; // false on true first read; true on forced rescan
  } else {
    startOffset = prior.lastOffset;
    startLineNumber = prior.lastLineNumber + 1;
    rescanned = false;
  }

  // ---- no new bytes to read ------------------------------------------

  if (startOffset >= currentSize) {
    return {
      lines: [],
      state: {
        inode: currentInode,
        lastOffset: startOffset,
        lastSize: currentSize,
        lastLineNumber: needRescan ? 0 : (prior?.lastLineNumber ?? 0),
      },
      rescanned,
    };
  }

  // ---- read from startOffset to EOF ----------------------------------

  const bytesToRead = currentSize - startOffset;
  const buffer = Buffer.allocUnsafe(bytesToRead);

  const fh = await open(filePath, 'r');
  try {
    const { bytesRead } = await fh.read(buffer, 0, bytesToRead, startOffset);
    // Truncate buffer if fewer bytes were actually available (e.g. concurrent
    // truncation between stat and read — very unlikely but defensive).
    const data = bytesRead < bytesToRead ? buffer.subarray(0, bytesRead) : buffer;

    // ---- split into complete lines -----------------------------------
    //
    // Scan for '\n' (0x0a). Each '\n' terminates a complete line. Bytes after
    // the last '\n' are a partial line — hold them back by not advancing the
    // offset past them.
    //
    // '\r\n' line endings: strip a trailing '\r' from each line text so callers
    // see clean content regardless of line-ending style.

    const lines: TailLine[] = [];
    let segmentStart = 0; // start of current segment within `data`
    let currentLineNumber = startLineNumber;
    let lastCompleteByteEnd = 0; // how many bytes of `data` belong to complete lines

    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0x0a /* '\n' */) {
        // Extract the segment up to (but not including) the '\n'.
        let end = i;
        // Strip trailing '\r' for '\r\n' files.
        if (end > segmentStart && data[end - 1] === 0x0d /* '\r' */) {
          end -= 1;
        }
        const text = data.subarray(segmentStart, end).toString('utf8');
        lines.push({ lineNumber: currentLineNumber, text });
        currentLineNumber += 1;
        segmentStart = i + 1;
        lastCompleteByteEnd = i + 1;
      }
    }

    // New offset = start of any held-back partial line (or EOF if no partial).
    const newOffset = startOffset + lastCompleteByteEnd;
    const newLineNumber =
      lines.length > 0
        ? lines[lines.length - 1].lineNumber
        : needRescan
          ? 0
          : (prior?.lastLineNumber ?? 0);

    return {
      lines,
      state: {
        inode: currentInode,
        lastOffset: newOffset,
        lastSize: currentSize,
        lastLineNumber: newLineNumber,
      },
      rescanned,
    };
  } finally {
    await fh.close();
  }
}
