/**
 * "Applied but NOT recorded" is the tool's headline claim, so it must rest on evidence: a check
 * that would fail had the file never run. Drops, a policy re-created with a new USING (expressions
 * are not compared), CREATE OR REPLACE FUNCTION (bodies are not compared) and a column added back
 * as an earlier migration defined it all match before the file runs.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { CatalogSnapshot, MigrationReport } from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import { formatMigrationReport, formatSummary, verifyMigrations } from '../../src/verify/index.js';
import { cat, snapshot } from './verify/builders.js';

beforeAll(loadParser);

function verify(
  files: Record<string, string>,
  catalog: CatalogSnapshot,
  recorded: string[],
): MigrationReport[] {
  return verifyMigrations({
    migrations: Object.entries(files).map(([fileName, sql]) => {
      const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
      return {
        file: { version, name, fileName, path: `/repo/${fileName}`, checksum: '0'.repeat(64) },
        parsed: parseMigration(sql, { file: fileName }),
      };
    }),
    snapshot: catalog,
    recordedVersions: new Set(recorded),
  });
}

describe('a MATCH that does not show the file ran', () => {
  it('drop-only migrations against an empty database are not "applied"', () => {
    const reports = verify(
      {
        '002_drop_tmp.sql': 'drop table tmp_import;',
        '003_drop_old.sql': 'drop policy if exists x on t; drop function if exists old_fn(int);',
      },
      snapshot(),
      [],
    );
    expect(reports.map((r) => [r.verdict, r.evidence])).toEqual([
      ['MATCH', 0],
      ['MATCH', 0],
    ]);
    const summary = formatSummary(reports);
    expect(summary).not.toContain('applied but NOT recorded');
    expect(summary).toContain(
      '2 NOT recorded, and their MATCH does not show they ran: 002_drop_tmp.sql, 003_drop_old.sql',
    );
    expect(summary).toMatch(/002 +drop_tmp +MATCH\* /);
    expect(formatMigrationReport(reports[0]!)).toContain('  evidence: none, every check would');
  });

  it('a re-created policy and a replaced function are not evidence', () => {
    const reports = verify(
      {
        '001_docs.sql': `create table docs (id int, owner uuid);
          create policy "read own" on docs for select to authenticated using (owner = auth.uid());
          create function doc_count() returns int language sql as $$ select 1 $$;`,
        '002_open_docs.sql': `drop policy "read own" on docs;
          create policy "read own" on docs for select to authenticated using (true);
          create or replace function doc_count() returns int language sql as $$ select 2 $$;`,
      },
      // Only 001 ran.
      snapshot({
        relations: [cat.table('docs')],
        columns: [cat.column('docs', 'id', 'integer'), cat.column('docs', 'owner', 'uuid')],
        policies: [cat.policy('docs', 'read own', { command: 'SELECT', roles: ['authenticated'] })],
        functions: [cat.fn('doc_count', [])],
      }),
      ['001'],
    );
    expect(reports[1]).toMatchObject({ verdict: 'MATCH', evidence: 0, recorded: false });
    expect(formatSummary(reports)).not.toContain('applied but NOT recorded');
  });

  it('a column added back as it was before is not evidence', () => {
    const reports = verify(
      {
        '001_flags.sql': 'create table f (id int, flag boolean);',
        '002_drop_flag.sql': 'alter table f drop column flag;',
        '003_add_flag.sql': 'alter table f add column flag boolean;',
      },
      // Neither 002 nor 003 ran: the original column is still there.
      snapshot({
        relations: [cat.table('f')],
        columns: [cat.column('f', 'id', 'integer'), cat.column('f', 'flag', 'boolean')],
      }),
      ['001'],
    );
    expect(reports.map((r) => [r.verdict, r.evidence])).toEqual([
      ['MATCH', 2],
      // The drop is re-created later, so it has nothing left to check.
      ['NOTHING_TO_VERIFY', 0],
      ['MATCH', 0],
    ]);
    expect(formatSummary(reports)).not.toContain('applied but NOT recorded');
  });

  it('a new object that exists is evidence (control)', () => {
    const reports = verify(
      {
        '001_flags.sql': 'create table f (id int);',
        '002_add_note.sql': 'alter table f add column note text; drop table if exists tmp;',
      },
      snapshot({
        relations: [cat.table('f')],
        columns: [cat.column('f', 'id', 'integer'), cat.column('f', 'note', 'text')],
      }),
      ['001'],
    );
    expect(reports[1]).toMatchObject({ verdict: 'MATCH', evidence: 1 });
    expect(formatSummary(reports)).toContain('1 applied but NOT recorded in history.');
    expect(formatMigrationReport(reports[1]!)).not.toContain('evidence');
  });
});
