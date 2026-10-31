import type { MigrationFile } from './model.js';

/**
 * Orders version strings numerically without parsing them: 14-digit timestamps overflow
 * `Number.MAX_SAFE_INTEGER` precision, and digit strings of equal length already sort like numbers.
 * Shorter strings come first, so `9` < `10` < `0010` (leading zeros make a version "longer").
 *
 * Shared by the directory listing, the history diff and the verifier: which migration counts as
 * "later" decides what supersedes what, so every module must agree on it.
 */
export function compareVersions(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return compareText(a, b);
}

/** Migration order: by version, then by file name so duplicate versions still sort stably. */
export function compareMigrationFiles(a: MigrationFile, b: MigrationFile): number {
  return compareVersions(a.version, b.version) || compareText(a.fileName, b.fileName);
}

/** Code-unit order, independent of locale (unlike `localeCompare`). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
