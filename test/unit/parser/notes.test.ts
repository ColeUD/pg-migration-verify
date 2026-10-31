/**
 * Nothing in a migration is silently dropped: statements that cannot become catalog checks
 * produce a note saying why (`unverifiable`), or that they have no lasting effect (`ignored`).
 */
import { parseSync } from 'libpg-query';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Note } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { analyzeStatement } from '../../../src/parser/statements.js';
import { fixture, noteSummaries, parse, TEST_FILE } from './helpers.js';

beforeAll(loadParser);

const PRIVILEGES = 'privileges are not checked';
const DATA = 'data change, not a schema object';
const ROLES = 'roles are cluster-wide and are not checked';
const NO_EFFECT = 'no lasting schema effect';

describe('notes', () => {
  it.each<[string, Note['category'], string, string]>([
    ['grant select on todos to authenticated', 'unverifiable', 'GrantStmt', PRIVILEGES],
    ['revoke all on todos from anon', 'unverifiable', 'GrantStmt', PRIVILEGES],
    ['grant execute on function f(int) to authenticated', 'unverifiable', 'GrantStmt', PRIVILEGES],
    ['grant authenticated to app_user', 'unverifiable', 'GrantRoleStmt', PRIVILEGES],
    [
      'alter default privileges in schema public grant select on tables to anon',
      'unverifiable',
      'AlterDefaultPrivilegesStmt',
      PRIVILEGES,
    ],
    [
      "comment on table todos is 'Things to do'",
      'unverifiable',
      'CommentStmt',
      'comments are not checked',
    ],
    [
      "comment on column todos.title is 'Title'",
      'unverifiable',
      'CommentStmt',
      'comments are not checked',
    ],
    [
      'create publication app_pub for table todos',
      'unverifiable',
      'CreatePublicationStmt',
      'publications are not checked',
    ],
    [
      'alter publication supabase_realtime add table todos',
      'unverifiable',
      'AlterPublicationStmt',
      'publications are not checked',
    ],
    [
      "insert into storage.buckets (id, name) values ('avatars', 'avatars')",
      'unverifiable',
      'InsertStmt',
      DATA,
    ],
    ['update todos set done = true where id = 1', 'unverifiable', 'UpdateStmt', DATA],
    ['delete from todos where done', 'unverifiable', 'DeleteStmt', DATA],
    [
      "copy todos (id, title) from '/seed/todos.csv' with (format csv)",
      'unverifiable',
      'CopyStmt',
      DATA,
    ],
    ['truncate todos restart identity', 'unverifiable', 'TruncateStmt', DATA],
    ['call archive_done(now())', 'unverifiable', 'CallStmt', DATA],
    [
      'merge into todos t using staged s on t.id = s.id when matched then update set title = s.title',
      'unverifiable',
      'MergeStmt',
      DATA,
    ],
    [
      'select 1',
      'unverifiable',
      'SelectStmt',
      'SELECT statements have no schema effect that can be checked',
    ],
    [
      "select cron.schedule('nightly', '0 3 * * *', 'select 1')",
      'unverifiable',
      'SelectStmt',
      'SELECT statements have no schema effect that can be checked',
    ],
    [
      'alter function f(int) security definer',
      'unverifiable',
      'AlterFunctionStmt',
      'function attributes are not checked',
    ],
    [
      'alter sequence s restart with 10',
      'unverifiable',
      'AlterSeqStmt',
      'sequence options are not checked',
    ],
    [
      'alter function f(int) owner to postgres',
      'unverifiable',
      'AlterOwnerStmt',
      'ownership is not checked',
    ],
    [
      'alter type mood owner to postgres',
      'unverifiable',
      'AlterOwnerStmt',
      'ownership is not checked',
    ],
    ['create role app_user nologin', 'unverifiable', 'CreateRoleStmt', ROLES],
    ['alter role app_user with login', 'unverifiable', 'AlterRoleStmt', ROLES],
    [
      'alter role authenticator set statement_timeout = 8000',
      'unverifiable',
      'AlterRoleSetStmt',
      ROLES,
    ],
    ['drop role if exists app_user', 'unverifiable', 'DropRoleStmt', ROLES],
    ['begin', 'ignored', 'TransactionStmt', NO_EFFECT],
    ['commit', 'ignored', 'TransactionStmt', NO_EFFECT],
    ['set statement_timeout = 0', 'ignored', 'VariableSetStmt', NO_EFFECT],
    ['show search_path', 'ignored', 'VariableShowStmt', NO_EFFECT],
    ["notify pgrst, 'reload schema'", 'ignored', 'NotifyStmt', NO_EFFECT],
    ['lock table todos in access exclusive mode', 'ignored', 'LockStmt', NO_EFFECT],
    ['vacuum analyze todos', 'ignored', 'VacuumStmt', NO_EFFECT],
    ['analyze todos', 'ignored', 'VacuumStmt', NO_EFFECT],
    ['checkpoint', 'ignored', 'CheckPointStmt', NO_EFFECT],
    ['discard all', 'ignored', 'DiscardStmt', NO_EFFECT],
    [
      'create temp table scratch (id int)',
      'ignored',
      'CreateStmt',
      'temporary table: it does not outlive the session',
    ],
    [
      'create rule no_delete as on delete to todos do instead nothing',
      'unverifiable',
      'RuleStmt',
      'RuleStmt is not supported yet',
    ],
    [
      'create cast (text as int) with inout',
      'unverifiable',
      'CreateCastStmt',
      'CreateCastStmt is not supported yet',
    ],
    [
      'create aggregate my_sum (int) (sfunc = int4pl, stype = int)',
      'unverifiable',
      'DefineStmt',
      'CREATE AGGREGATE is not supported yet',
    ],
    [
      'refresh materialized view stats',
      'unverifiable',
      'RefreshMatViewStmt',
      'RefreshMatViewStmt is not supported yet',
    ],
    [
      "alter table todos alter column status set default 'open'",
      'unverifiable',
      'AlterTableStmt',
      'column defaults are not checked',
    ],
  ])('%s -> %s %s', (sql, category, statementType, reason) => {
    const result = parse(sql);
    expect(result.objects).toEqual([]);
    expect(noteSummaries(result)).toEqual([[category, statementType, reason]]);
    expect(result.notes[0]?.source).toMatchObject({ file: TEST_FILE, statementIndex: 0, line: 1 });
  });
});

describe('coverage of a 78-statement corpus of tricky migration SQL', () => {
  it('every statement yields at least one object or note', () => {
    const sql = fixture('kitchen-sink.sql');
    const statements = parseSync(sql).stmts ?? [];
    expect(statements).toHaveLength(78);
    const silent = statements.flatMap((raw, statementIndex) => {
      const source = { file: TEST_FILE, statementIndex, line: 1, excerpt: '' };
      const effects = analyzeStatement(raw.stmt!, { schema: 'public', source });
      return effects.length === 0 ? [Object.keys(raw.stmt!)[0]] : [];
    });
    expect(silent).toEqual([]);
  });

  it('parses the whole corpus without parse errors', () => {
    const result = parse(fixture('kitchen-sink.sql'));
    expect(result.statementCount).toBe(78);
    expect(result.notes.filter((n) => n.statementType === 'ParseError')).toEqual([]);
  });
});
