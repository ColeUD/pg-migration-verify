/**
 * Runs in its own module scope (vitest isolates test files), so the parser has not been loaded.
 */
import { describe, expect, it } from 'vitest';
import { parseMigration } from '../../../src/parser/index.js';

describe('parseMigration before loadParser()', () => {
  it('throws a clear error instead of a WASM internals message', () => {
    expect(() => parseMigration('select 1', { file: 'x.sql' })).toThrow(
      'The SQL parser is not loaded: await loadParser() before calling parseMigration().',
    );
  });
});
