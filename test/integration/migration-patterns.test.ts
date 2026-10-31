import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, loadCatalogSnapshot } from '../../src/catalog/index.js';
import type { CatalogSnapshot, MigrationReport, ParsedMigration } from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import {
  formatMigrationReport,
  formatSummary,
  requiredSchemas,
  verifyMigrations,
  type MigrationInput,
} from '../../src/verify/index.js';
import { PATTERN_MIGRATIONS } from '../fixtures/migration-patterns.js';
import { applySql, createReadOnlyRole, createTestDatabase } from './helpers/test-db.js';
import type { TestDatabase } from './helpers/test-db.js';

/**
 * Migrations that rebuild, rename or re-declare objects, applied to a real Postgres in order: each
 * must verify as MATCH. The unit test of the same name checks the report text against a
 * hand-written catalog; this one proves that catalog is what Postgres really leaves behind.
 */
describe('migration patterns applied to a real database', () => {
  let testDb: TestDatabase;
  let reports: MigrationReport[];

  beforeAll(async () => {
    await loadParser();
    testDb = await createTestDatabase();
    const migrations: MigrationInput[] = [];
    for (const [fileName, sql] of Object.entries(PATTERN_MIGRATIONS)) {
      await applySql(testDb.admin, sql);
      migrations.push(synthetic(fileName, parseMigration(sql, { file: fileName })));
    }
    const snapshot = await loadSnapshot(testDb, migrations);
    reports = verifyMigrations({ migrations, snapshot, recordedVersions: null });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('verifies every migration as MATCH, with what later ones removed superseded', () => {
    const details = reports.map((r) => formatMigrationReport(r)).join('\n');
    expect(formatSummary(reports), details).toBe(
      [
        'VERSION         NAME                    RESULT  MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240101000000  tasks_and_settings      MATCH   4/4      11          0             -',
        '20240102000000  rebuild_enum_and_table  MATCH   10/10    0           0             -',
        '20240201000000  profiles                MATCH   11/11    3           0             -',
        '20240202000000  drop_generated_names    MATCH*  3/3      0           0             -',
        '20240301000000  widgets_using_index     MATCH   6/6      0           0             -',
        '20240302000000  gadgets_index           MATCH   3/3      0           0             -',
        '20240303000000  gadgets_primary_key     MATCH   3/3      0           0             -',
        '20240401000000  diary_renames           MATCH   11/11    0           0             -',
        '20240501000000  ine                     MATCH   4/4      0           0             -',
        '20240502000000  ine_if_not_exists       MATCH*  1/1      3           0             -',
        '',
        '10 migrations: 10 MATCH, 0 MISMATCH, 0 nothing to verify. History unavailable.',
        'MATCH*: every check would also hold had the file never run, so it may not have been applied.',
      ].join('\n'),
    );
  });
});

/**
 * Unnamed constraints and indexes of every flavor, including expression columns, INCLUDE columns,
 * repeated names and names cut to 63 bytes (some multibyte). Each table gets at most one object
 * per generated name, so Postgres never has to add a collision suffix.
 */
const LONG_TABLE = `gn_${'t'.repeat(57)}`;
const MULTIBYTE_TABLE = `gn_${'é'.repeat(30)}`;
const GENERATED_NAMES_SQL = String.raw`
CREATE TABLE public.gn_items (
  id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  a int REFERENCES public.gn_items (id),
  b int,
  code text UNIQUE,
  email text,
  data jsonb,
  CHECK (a > b),
  CHECK (b > 0 AND b < 100),
  UNIQUE (a, b),
  UNIQUE (b) INCLUDE (a),
  EXCLUDE USING gist (int4range(a, b) WITH &&)
);
CREATE INDEX ON public.gn_items (lower(email));
CREATE INDEX ON public.gn_items ((a + b), (a - b));
CREATE INDEX ON public.gn_items ((data ->> 'k'));
CREATE INDEX ON public.gn_items ((code::varchar));
CREATE INDEX ON public.gn_items (a) INCLUDE (b, code);
CREATE INDEX ON public.gn_items (a, a);
CREATE INDEX ON public.gn_items ((coalesce(a, b)));
CREATE TABLE public.gn_pair (x int, y int, PRIMARY KEY (x, y), FOREIGN KEY (x, y) REFERENCES public.gn_pair (x, y));
CREATE TABLE public.${LONG_TABLE} (${'c'.repeat(40)} int UNIQUE CHECK (${'c'.repeat(40)} > 0));
CREATE INDEX ON public.${LONG_TABLE} (${'c'.repeat(40)});
CREATE TABLE public."${MULTIBYTE_TABLE}" ("${'ü'.repeat(20)}" int UNIQUE, n int CHECK (n > 0));
CREATE INDEX ON public."${MULTIBYTE_TABLE}" (n);
`;

describe('generated names of unnamed constraints and indexes', () => {
  let testDb: TestDatabase;
  let parsed: ParsedMigration;
  let snapshot: CatalogSnapshot;

  beforeAll(async () => {
    await loadParser();
    testDb = await createTestDatabase();
    await applySql(testDb.admin, GENERATED_NAMES_SQL);
    parsed = parseMigration(GENERATED_NAMES_SQL, { file: '20240601000000_names.sql' });
    snapshot = await loadSnapshot(testDb, [synthetic('20240601000000_names.sql', parsed)]);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('predicts the name Postgres gave every unnamed constraint and index', () => {
    const predicted = parsed.objects.flatMap((o) =>
      (o.kind === 'constraint' || o.kind === 'index') && o.name === null
        ? [{ key: o.key, kind: o.kind, schema: o.schema, table: o.table, name: o.impliedName }]
        : [],
    );
    const actualConstraints = new Set(
      snapshot.constraints.map((c) => `${c.schema}.${c.table}.${c.name}`),
    );
    const actualIndexes = new Set(snapshot.indexes.map((i) => `${i.schema}.${i.name}`));
    const wrong = predicted.filter((p) =>
      p.kind === 'constraint'
        ? !actualConstraints.has(`${p.schema}.${p.table}.${p.name ?? ''}`)
        : !actualIndexes.has(`${p.schema}.${p.name ?? ''}`),
    );
    expect(wrong, `actual: ${[...actualConstraints, ...actualIndexes].join(', ')}`).toEqual([]);
    // gn_items: 8 constraints and 7 indexes; gn_pair: 2; each long-named table: 2 and 1.
    expect(predicted).toHaveLength(23);
    expect(predicted.map((p) => p.name)).toContain(`gn_${'t'.repeat(26)}_${'c'.repeat(29)}_key`);
  });
});

async function loadSnapshot(
  testDb: TestDatabase,
  migrations: readonly MigrationInput[],
): Promise<CatalogSnapshot> {
  const readOnlyUrl = await createReadOnlyRole(testDb.url, testDb.name);
  return loadCatalogSnapshot(createDatabase(readOnlyUrl), requiredSchemas(migrations));
}

function synthetic(fileName: string, parsed: ParsedMigration): MigrationInput {
  const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
  return {
    file: { version, name, fileName, path: `/synthetic/${fileName}`, checksum: '0'.repeat(64) },
    parsed,
  };
}
