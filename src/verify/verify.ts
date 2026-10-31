import type {
  CatalogSnapshot,
  ExpectedObject,
  MigrationFile,
  MigrationReport,
  MigrationVerdict,
  ObjectCheck,
  ParsedMigration,
} from '../model.js';
import { compareMigrationFiles } from '../versions.js';
import { compareObject } from './compare.js';
import { SnapshotIndex } from './snapshot-index.js';
import { isAttributeField } from './attributes.js';
import { Timeline, type ResolvedObject } from './timeline.js';

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
 * Check every migration against the catalog and return one report per migration, in apply order
 * (or only the report for `only`, a file name).
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
  only?: string;
}): MigrationReport[] {
  const ordered = [...input.migrations].sort((a, b) => compareMigrationFiles(a.file, b.file));
  const timeline = new Timeline(ordered.map((m) => m.parsed));
  const catalog = new SnapshotIndex(input.snapshot);
  const reports: MigrationReport[] = [];
  ordered.forEach((migration, i) => {
    if (input.only !== undefined && migration.file.fileName !== input.only) return;
    const checks = timeline.resolve(i).map((resolved) => check(resolved, catalog));
    const evidence = checks.filter(
      (c) => c.status === 'match' && isEvidence(c, timeline.definedBefore(c.object.key, i)),
    ).length;
    reports.push(buildReport(migration, checks, evidence, input.recordedVersions));
  });
  return reports;
}

function check(resolved: ResolvedObject, catalog: SnapshotIndex): ObjectCheck {
  const { object, notes, supersededBy } = resolved;
  if (supersededBy !== undefined) {
    return { object, status: 'superseded', differences: [], supersededBy, notes };
  }
  const comparison = compareObject(object, catalog);
  if (comparison.status === 'different' || comparison.status === 'missing') {
    const fallback = earlierMatch(resolved, catalog, comparison.status);
    if (fallback !== null) return fallback;
  }
  return {
    object,
    status: comparison.status,
    differences: comparison.differences,
    notes: [...notes, ...comparison.notes],
  };
}

/**
 * A later migration changed the object, and the database still holds it as it was before that
 * change: the later migration did not run (yet), and it is the one that reports the difference.
 * The earlier migration did what it says, so it matches. Existence does not depend on attribute
 * changes, so a missing object only falls back past a rename.
 */
function earlierMatch(
  resolved: ResolvedObject,
  catalog: SnapshotIndex,
  status: 'different' | 'missing',
): ObjectCheck | null {
  for (const state of resolved.earlier) {
    if (status === 'missing' && state.object.key === resolved.object.key) continue;
    if (compareObject(state.object, catalog).status !== 'match') continue;
    return {
      object: state.object,
      status: 'match',
      differences: [],
      notes: [
        ...state.notes,
        `matches its state before ${state.changedBy}, whose change is not in the database ` +
          '(reported on that migration)',
      ],
    };
  }
  return null;
}

/**
 * Whether a matching check shows that its migration ran: it would not hold if the file had never
 * run. Drops hold before they run, and so does an object an earlier migration already declared
 * with the same compared attributes (a policy re-created with a new USING, CREATE OR REPLACE
 * FUNCTION with a new body, a column dropped and added back).
 */
function isEvidence(c: ObjectCheck, earlierDefinitions: readonly ExpectedObject[]): boolean {
  if (c.object.expect === 'absent') return false;
  return !earlierDefinitions.some((earlier) => sameComparedAttributes(c.object, earlier));
}

/** Whether every attribute `o` asserts (non-null) has the same value in `earlier`. */
function sameComparedAttributes(o: ExpectedObject, earlier: ExpectedObject): boolean {
  if (o.kind !== earlier.kind) return false;
  const before = earlier as unknown as Record<string, unknown>;
  return Object.entries(o).every(
    ([field, value]) =>
      !isAttributeField(field) ||
      value === null ||
      JSON.stringify(value) === JSON.stringify(before[field]),
  );
}

function buildReport(
  migration: MigrationInput,
  checks: ObjectCheck[],
  evidence: number,
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
    evidence,
    checks,
    notes: migration.parsed.notes,
    recorded: recordedVersions?.has(migration.file.version) ?? null,
  };
}
