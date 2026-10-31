/**
 * Shared helpers for parser tests: parse inline SQL or a fixture, and look objects up by key so
 * assertions read like the expectations they check.
 */
import { readFileSync } from 'node:fs';
import { expect } from 'vitest';
import type { ExpectedObject, Note, ParsedMigration } from '../../../src/model.js';
import { parseMigration } from '../../../src/parser/index.js';

export const TEST_FILE = '20240101000000_test.sql';

export function parse(sql: string, defaultSchema?: string): ParsedMigration {
  return parseMigration(sql, { file: TEST_FILE, defaultSchema });
}

export function fixture(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
}

/** Keys of the net objects, in order. */
export function keys(result: ParsedMigration): string[] {
  return result.objects.map((o) => o.key);
}

/** The object with this key; fails the test (listing the keys that do exist) when missing. */
export function objectAt(result: ParsedMigration, key: string): ExpectedObject {
  const found = result.objects.find((o) => o.key === key);
  expect(found, `no object ${key}; have:\n  ${keys(result).join('\n  ')}`).toBeDefined();
  return found!;
}

/** The object without key and source, for comparing just what it asserts. */
export function attributes(o: ExpectedObject): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(o).filter(([field]) => field !== 'key' && field !== 'source'),
  );
}

/** Notes as `[category, statementType, reason]` tuples, which keeps note assertions compact. */
export function noteSummaries(result: ParsedMigration): [Note['category'], string, string][] {
  return result.notes.map((n) => [n.category, n.statementType, n.reason]);
}
