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
