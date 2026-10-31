import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, loadCatalogSnapshot } from '../../src/catalog/index.js';
import type { MigrationReport } from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import {
  formatMigrationReport,
  formatSummary,
  requiredSchemas,
  verifyMigrations,
  type MigrationInput,
} from '../../src/verify/index.js';
import { applySql, createReadOnlyRole, createTestDatabase } from './helpers/test-db.js';
import type { TestDatabase } from './helpers/test-db.js';

/**
 * What a later migration's RENAME or DROP does to an earlier migration's objects, against what
 * Postgres really leaves behind. Each scenario gets its own database; `applied` says which
 * migrations ran (default: all), and `afterwards` is a hand edit made after them.
 */
interface Scenario {
  migrations: string[];
  applied?: number[];
  afterwards?: string;
  recorded?: number[];
}

async function run(scenario: Scenario): Promise<MigrationReport[]> {
  const testDb = await createTestDatabase();
  databases.push(testDb);
  const inputs: MigrationInput[] = scenario.migrations.map((sql, i) => {
    const version = String(i + 1).padStart(3, '0');
    const fileName = `${version}_m${i + 1}.sql`;
    return {
      file: {
        version,
        name: `m${i + 1}`,
        fileName,
        path: `/x/${fileName}`,
        checksum: '0'.repeat(64),
      },
      parsed: parseMigration(sql, { file: fileName }),
    };
  });
  for (const [i, sql] of scenario.migrations.entries()) {
    if (scenario.applied === undefined || scenario.applied.includes(i)) {
      await applySql(testDb.admin, sql);
    }
  }
  if (scenario.afterwards !== undefined) await applySql(testDb.admin, scenario.afterwards);
  const readOnlyUrl = await createReadOnlyRole(testDb.url, testDb.name);
  const snapshot = await loadCatalogSnapshot(createDatabase(readOnlyUrl), requiredSchemas(inputs));
  return verifyMigrations({
    migrations: inputs,
    snapshot,
    recordedVersions:
      scenario.recorded === undefined
        ? null
        : new Set(scenario.recorded.map((i) => inputs[i]!.file.version)),
  });
}

const databases: TestDatabase[] = [];

beforeAll(loadParser);

afterAll(async () => {
  await Promise.all(databases.map((db) => db.drop()));
});

/** Every report's verdict, with the details in the failure message. */
function expectVerdicts(reports: readonly MigrationReport[], verdicts: string[]): void {
  const details = reports.map((r) => formatMigrationReport(r, { verbose: true })).join('\n\n');
  expect(
    reports.map((r) => r.verdict),
    details,
  ).toEqual(verdicts);
}

function problems(report: MigrationReport | undefined): string[] {
  return formatMigrationReport(report!)
    .split('\n')
    .filter((line) => /^ {2}(MISSING|DIFFERENT|UNEXPECTED) /.test(line));
}

describe('fully applied: every migration matches', () => {
  it.each<[string, Scenario, number]>([
    [
      'renamed columns, table key, type and trigger function',
      {
        migrations: [
          `create type mood as enum ('ok');
           create table authors (id int primary key);
           create table posts (
             id int primary key, title text, slug text, m mood, author_id int references authors (id),
             constraint posts_slug_key unique (slug),
             constraint posts_title_len check (char_length(title) > 0)
           );
           create index posts_title_idx on posts (title);
           create index on posts (author_id, slug);
           create function posts_touch() returns trigger language plpgsql as $$ begin return new; end $$;
           create trigger posts_touch before update on posts for each row execute function posts_touch();`,
          `alter table posts rename column title to headline;
           alter table authors rename column id to author_pk;
           alter table posts rename column slug to permalink;
           alter type mood rename to feeling;
           alter function posts_touch() rename to touch_row;`,
        ],
      },
      0,
    ],
    [
      'renamed table with an incoming foreign key, then moved to another schema',
      {
        migrations: [
          `create table todos (id int primary key, note text not null);
           create index todos_note_idx on todos (note);
           alter table todos enable row level security;
           create policy "read todos" on todos for select to authenticated using (true);
           create table todo_tags (todo_id int references todos (id));`,
          `alter table todos rename to tasks;`,
          `create schema archive;
           alter table tasks set schema archive;`,
        ],
      },
      0,
    ],
    [
      'dropped columns with indexes and unique, check and multi-column constraints',
      {
        migrations: [
          `create table orders (id int primary key, legacy_code text, amount int, a int, b int);
           create index orders_legacy_code_idx on orders (legacy_code);
           alter table orders add constraint orders_legacy_code_key unique (legacy_code);
           alter table orders add constraint orders_amount_check check (amount > 0);
           alter table orders add unique (a, b);
           alter table orders add check (a > b);
           create index on orders (a, b);`,
          `alter table orders drop column legacy_code;
           alter table orders drop column amount;
           alter table orders drop column b;`,
        ],
      },
      9,
    ],
    [
      'cascades: a parent table, a trigger function and a type dropped',
      {
        migrations: [
          `create table pa (id int primary key);
           create table ch (id int, pa_id int references pa (id));
           create table tt (id int);
           create function tgf() returns trigger language plpgsql as $$ begin return new; end $$;
           create trigger tgt before update on tt for each row execute function tgf();
           create type col_t as enum ('a');
           create table dt (id int, s col_t, ss col_t[]);`,
          `drop table pa cascade;
           drop function tgf() cascade;
           drop type col_t cascade;`,
        ],
      },
      10,
    ],
  ])('%s', async (_, scenario, superseded) => {
    const reports = await run(scenario);
    expectVerdicts(
      reports,
      scenario.migrations.map(() => 'MATCH'),
    );
    expect(reports[0]?.checks.filter((c) => c.status === 'superseded')).toHaveLength(superseded);
  });
});

describe('what a rename must not hide', () => {
  it('RLS disabled, a policy dropped and NOT NULL removed on a table renamed later', async () => {
    const reports = await run({
      migrations: [
        `create table secrets (id int primary key, owner uuid not null);
         alter table secrets enable row level security;
         create policy owner_only on secrets for select to authenticated using (owner = auth.uid());`,
        `alter table secrets rename to user_secrets;`,
      ],
      afterwards: `alter table user_secrets disable row level security;
        drop policy owner_only on user_secrets;
        alter table user_secrets alter column owner drop not null;`,
    });
    expectVerdicts(reports, ['MISMATCH', 'MATCH']);
    expect(problems(reports[0])).toEqual([
      '  MISSING   line 3  policy "owner_only" on public.user_secrets (for SELECT, to authenticated)',
      '  DIFFERENT line 1  column public.user_secrets.owner: nullability expected not null, found nullable',
      '  DIFFERENT line 2  row level security on public.user_secrets: row level security expected enabled, found disabled',
    ]);
  });

  it('a column renamed later whose type and NOT NULL were changed by hand', async () => {
    const reports = await run({
      migrations: [
        'create table accounts (id int primary key, bal numeric(12,2) not null);',
        'alter table accounts rename column bal to balance;',
      ],
      afterwards: `alter table accounts alter column balance type text;
        alter table accounts alter column balance drop not null;`,
    });
    expectVerdicts(reports, ['MISMATCH', 'MATCH']);
    expect(problems(reports[0])).toEqual([
      '  DIFFERENT line 1  column public.accounts.balance: type expected numeric(12,2), found text; nullability expected not null, found nullable',
    ]);
  });

  it('a column dropped by hand from a table moved to another schema later', async () => {
    const reports = await run({
      migrations: [
        'create table orders (id int primary key, total int not null);',
        'create schema archive; alter table orders set schema archive;',
      ],
      afterwards: 'alter table archive.orders drop column total;',
    });
    expectVerdicts(reports, ['MISMATCH', 'MATCH']);
    expect(problems(reports[0])).toEqual([
      '  MISSING line 1  column archive.orders.total (integer, not null)',
    ]);
  });

  it('a partial apply: RLS never enabled before a later rename', async () => {
    const create = 'create table notes (id int primary key);';
    const reports = await run({
      migrations: [
        `${create}\nalter table notes enable row level security;`,
        'alter table notes rename to memos;',
      ],
      // The CREATE ran but not the ENABLE; then the rename ran.
      applied: [],
      afterwards: `${create} alter table notes rename to memos;`,
    });
    expect(reports[0]?.verdict).toBe('MISMATCH');
  });
});

describe('a later migration that did not run', () => {
  it('is blamed for its own change; the earlier, applied migration still matches', async () => {
    const reports = await run({
      migrations: [
        'create table big (id int primary key, n int not null);',
        'alter table big alter column n type bigint;',
      ],
      applied: [0],
      recorded: [0],
    });
    expectVerdicts(reports, ['MATCH', 'MISMATCH']);
    expect(formatSummary(reports)).not.toContain('recorded in history but MISMATCH');
  });

  it('drop-only migrations on an empty database are not called applied', async () => {
    const reports = await run({
      migrations: [
        'drop table if exists tmp_import;',
        'drop policy if exists x on pg_catalog.pg_class; drop function if exists old_fn(int);',
      ],
      applied: [],
      recorded: [],
    });
    const summary = formatSummary(reports);
    expect(summary).not.toContain('applied but NOT recorded');
    expect(summary).toContain('2 NOT recorded, and their MATCH does not show they ran');
  });
});

describe('foreign key actions', () => {
  it('reports an ON DELETE CASCADE replaced by hand with the default', async () => {
    const reports = await run({
      migrations: [
        `create table parents (id int primary key);
         create table kids (id int, parent_id int,
           constraint kids_parent_fk foreign key (parent_id) references parents (id) on delete cascade);`,
      ],
      afterwards: `alter table kids drop constraint kids_parent_fk,
        add constraint kids_parent_fk foreign key (parent_id) references parents (id);`,
    });
    expect(problems(reports[0])).toEqual([
      '  DIFFERENT line 2  constraint kids_parent_fk on public.kids: on delete expected cascade, found no action',
    ]);
  });
});
