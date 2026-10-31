import type {
  CatalogSnapshot,
  MigrationFile,
  MigrationReport,
  MigrationVerdict,
  ObjectCheck,
  ParsedMigration,
} from '../model.js';
import { compareMigrationFiles } from '../versions.js';
import { compareObject } from './compare.js';
import { SnapshotIndex } from './snapshot-index.js';
import { resolveObjects, type ResolvedObject } from './timeline.js';

/** One repository migration file together with what its SQL is expected to do. */
export interface MigrationInput {
  file: MigrationFile;
  parsed: ParsedMigration;
}

/**
 * Every schema the verification will look objects up in: object schemas, schemas of tables that
 * foreign keys reference, and schemas of trigger functions. Sorted and unique.
 *
 * The catalog loader only reads the schemas it is asked for (Supabase databases carry large
 * `auth`/`storage` schemas nobody's migrations touch), so the caller passes this list to it.
 */
export function requiredSchemas(migrations: readonly MigrationInput[]): string[] {
  const schemas = new Set<string>();
  for (const { parsed } of migrations) {
    for (const o of parsed.objects) {
      schemas.add(o.schema);
      if (o.kind === 'constraint' && o.references !== null) schemas.add(o.references.schema);
      if (o.kind === 'trigger' && o.function !== null && o.function.schema !== null) {
        schemas.add(o.function.schema);
      }
    }
  }
  schemas.delete('');
  return [...schemas].sort();
}

/**
 * Check every migration against the catalog and return one report per migration, in version order.
 *
 * All migrations are needed even when only one report is wanted: whether an object of migration N
 * should still exist depends on what migrations N+1.. did to it (see `resolveObjects`).
 *
 * @param recordedVersions versions found in the history table, or null when it is unavailable.
 * @throws when an object lives in a schema the snapshot does not cover (load `requiredSchemas()`).
 */
export function verifyMigrations(input: {
  migrations: readonly MigrationInput[];
  snapshot: CatalogSnapshot;
  recordedVersions: ReadonlySet<string> | null;
}): MigrationReport[] {
  const ordered = [...input.migrations].sort((a, b) => compareMigrationFiles(a.file, b.file));
  const parsed = ordered.map((m) => m.parsed);
  const catalog = new SnapshotIndex(input.snapshot);
  return ordered.map((migration, i) => {
    const checks = resolveObjects(parsed, i).map((resolved) => check(resolved, catalog));
    return buildReport(migration, checks, input.recordedVersions);
  });
}

function check(resolved: ResolvedObject, catalog: SnapshotIndex): ObjectCheck {
  const { object, notes, supersededBy } = resolved;
  if (supersededBy !== undefined) {
    return { object, status: 'superseded', differences: [], supersededBy, notes };
  }
  const comparison = compareObject(object, catalog);
  return {
    object,
    status: comparison.status,
    differences: comparison.differences,
    notes: [...notes, ...comparison.notes],
  };
}

function buildReport(
  migration: MigrationInput,
  checks: ObjectCheck[],
  recordedVersions: ReadonlySet<string> | null,
): MigrationReport {
  const checked = checks.filter((c) => c.status !== 'superseded').length;
  const matched = checks.filter((c) => c.status === 'match').length;
  const verdict: MigrationVerdict =
    checked === 0 ? 'NOTHING_TO_VERIFY' : matched === checked ? 'MATCH' : 'MISMATCH';
  return {
    file: migration.file.fileName,
    version: migration.file.version,
    name: migration.file.name,
    verdict,
    checked,
    matched,
    checks,
    notes: migration.parsed.notes,
    recorded: recordedVersions?.has(migration.file.version) ?? null,
  };
}
