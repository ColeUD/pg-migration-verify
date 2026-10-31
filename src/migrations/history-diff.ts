import type { MigrationFile, RecordedMigration } from '../model.js';
import { compareMigrationFiles, compareVersions } from '../versions.js';

/** How the repository's migration files line up with the database's recorded history. */
export interface HistoryDiff {
  /** Files whose version was never recorded: not applied, or applied by hand without recording. */
  onlyInRepo: MigrationFile[];
  /** Recorded versions with no file: deleted, renamed, or applied from another branch. */
  onlyInDatabase: RecordedMigration[];
  /**
   * Versions present on both sides. `nameMatches` is null when the history row has no name
   * (older Supabase CLI versions did not store one).
   */
  inBoth: { file: MigrationFile; recorded: RecordedMigration; nameMatches: boolean | null }[];
}

/**
 * Compares files and recorded history by version, the way the Supabase CLI decides what is
 * pending. Names are compared only as a hint: the CLI itself ignores them, but a different name
 * usually means a file was renamed after it was applied.
 *
 * Output order is by version, so the result is deterministic whatever order the inputs had.
 */
export function diffHistory(
  files: readonly MigrationFile[],
  recorded: readonly RecordedMigration[],
): HistoryDiff {
  const recordedByVersion = new Map<string, RecordedMigration>();
  for (const row of recorded) {
    if (!recordedByVersion.has(row.version)) recordedByVersion.set(row.version, row);
  }
  const fileVersions = new Set(files.map((f) => f.version));

  const sortedFiles = [...files].sort(compareMigrationFiles);

  const onlyInRepo: MigrationFile[] = [];
  const inBoth: HistoryDiff['inBoth'] = [];
  for (const file of sortedFiles) {
    const row = recordedByVersion.get(file.version);
    if (row === undefined) {
      onlyInRepo.push(file);
    } else {
      inBoth.push({
        file,
        recorded: row,
        nameMatches: row.name === null ? null : row.name === file.name,
      });
    }
  }

  const onlyInDatabase = [...recordedByVersion.values()]
    .filter((row) => !fileVersions.has(row.version))
    .sort((a, b) => compareVersions(a.version, b.version));

  return { onlyInRepo, onlyInDatabase, inBoth };
}
