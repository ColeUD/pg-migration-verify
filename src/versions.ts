import type { MigrationFile } from './model.js';

/**
 * Orders versions the way the Supabase CLI compares them: as strings, byte by byte
 * (`FindPendingMigrations` compares `remote < local`, and the history is read `ORDER BY version`
 * on a text column). For versions of equal length, such as the CLI's 14-digit timestamps, that is
 * numeric order; across lengths it is not (`10` < `9`).
 *
 * Shared by the directory listing, the history diff and the verifier: which migration counts as
 * "later" decides what supersedes what, so every module must agree on it.
 */
export function compareVersions(a: string, b: string): number {
  return compareText(a, b);
}

/**
 * Apply order: by file name, byte by byte, as the Supabase CLI reads the directory
 * (`ListLocalMigrations` takes `fs.ReadDir` order) and applies it. `10_b.sql` runs before
 * `1_a.sql` and `9_c.sql`. File names are unique in a directory, so the order is total.
 */
export function compareMigrationFiles(a: MigrationFile, b: MigrationFile): number {
  return compareText(a.fileName, b.fileName);
}

/** Code-unit order, independent of locale (unlike `localeCompare`). */
export function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A warning when versions differ in length, because then file-name order (the order the Supabase
 * CLI applies them in, and the order this tool assumes) is not numeric order. Null otherwise.
 */
export function mixedVersionLengthWarning(files: readonly MigrationFile[]): string | null {
  const lengths = new Set(files.map((f) => f.version.length));
  if (lengths.size < 2) return null;
  return (
    'Versions of different lengths: the Supabase CLI applies migrations in file-name order ' +
    '(10_b.sql before 9_a.sql), not numeric order, and they are verified in that order too.'
  );
}
