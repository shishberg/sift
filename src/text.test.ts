import { describe, it, expect } from 'vitest';
import { truncate, TOOL_ARGS_MAX, TOOL_RESULT_MAX } from './text.js';

describe('truncate', () => {
  it('returns the input unchanged when at or below max', () => {
    expect(truncate('hello', 10)).toBe('hello');
    expect(truncate('hello', 5)).toBe('hello');
  });

  it('slices to max and appends an ellipsis when over max', () => {
    expect(truncate('hello world', 5)).toBe('hello...');
  });

  it('handles the empty string', () => {
    expect(truncate('', 5)).toBe('');
  });
});

describe('truncation constants', () => {
  it('exposes the shared tool-args and tool-result limits', () => {
    expect(TOOL_ARGS_MAX).toBe(200);
    expect(TOOL_RESULT_MAX).toBe(500);
  });
});
