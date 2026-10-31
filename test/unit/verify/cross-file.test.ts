/**
 * What a later migration's DROP or RENAME does to an earlier migration's objects, with the real
 * parser. Postgres applies the same effects whether the statements share a file or not, so the
 * timeline must too: the same SQL split across two files has to leave the same expectations.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExpectedObject, ParsedMigration } from '../../../src/model.js';
import { loadParser, parseMigration } from '../../../src/parser/index.js';
import { resolveObjects, type ResolvedObject } from '../../../src/verify/timeline.js';

beforeAll(loadParser);

const FILES = ['20240101000000_a.sql', '20240201000000_b.sql', '20240301000000_c.sql'];

function parseFiles(...sqls: string[]): ParsedMigration[] {
  return sqls.map((sql, i) => parseMigration(sql, { file: FILES[i] ?? `9${i}_x.sql` }));
}

/** The first file's objects resolved against the later files, by their resolved key. */
function resolveFirst(...sqls: string[]): Map<string, ResolvedObject> {
  const resolved = resolveObjects(parseFiles(...sqls), 0);
  return new Map(resolved.map((r) => [r.object.key, r]));
}

function checked(resolved: Map<string, ResolvedObject>, key: string): ExpectedObject {
  const found = resolved.get(key);
  expect(found, `no ${key}; have:\n  ${[...resolved.keys()].join('\n  ')}`).toBeDefined();
  expect(found?.supersededBy, key).toBeUndefined();
  return found!.object;
}

function superseded(resolved: Map<string, ResolvedObject>, key: string): string {
  const found = resolved.get(key);
  expect(found, `no ${key}; have:\n  ${[...resolved.keys()].join('\n  ')}`).toBeDefined();
  expect(found?.supersededBy, key).toBeDefined();
  return found!.supersededBy!.reason;
}

describe('a later RENAME', () => {
  it('COLUMN: indexes, constraints and foreign keys on it are checked with the new name', () => {
    const r = resolveFirst(
      `create table r (id int primary key, email text unique, nick text, age int);
       create index r_email_idx on r (email);
       create index on r (nick, email);
       alter table r add constraint r_age_check check (age > 0);
       create table s (id int, r_id int references r (id), r_email text references r (email));`,
      `alter table r rename column email to mail;
       alter table r rename column id to r_key;
       alter table r rename column age to years;`,
    );
    expect(checked(r, 'column:public.r.mail')).toMatchObject({ dataType: 'text' });
    expect(checked(r, 'column:public.r.r_key')).toMatchObject({ dataType: 'integer' });
    expect(checked(r, 'relation:public.r_email_idx')).toMatchObject({ columns: ['mail'] });
    checked(r, 'index:public.r(nick,mail)');
    checked(r, 'constraint:public.r.unique(mail)');
    checked(r, 'constraint:public.r.primary_key(r_key)');
    expect(checked(r, 'constraint:public.r.r_age_check')).toMatchObject({ columns: ['years'] });
    expect(checked(r, 'constraint:public.s.foreign_key(r_id)')).toMatchObject({
      references: { schema: 'public', table: 'r', columns: ['r_key'] },
    });
    expect(checked(r, 'constraint:public.s.foreign_key(r_email)')).toMatchObject({
      references: { schema: 'public', table: 'r', columns: ['mail'] },
    });
    expect([...r.values()].filter((x) => x.supersededBy !== undefined)).toEqual([]);
    expect(r.get('column:public.r.mail')?.notes).toEqual([
      'renamed from column public.r.email by 20240201000000_b.sql line 1',
    ]);
  });

  it('TABLE: its columns, indexes, RLS and policies follow with their attributes', () => {
    const r = resolveFirst(
      `create table ztable (id int primary key, note text not null);
       create index ztable_note_idx on ztable (note);
       alter table ztable enable row level security;
       create policy "read z" on ztable for select to authenticated using (true);
       create table child (id int, z_id int references ztable (id));`,
      `alter table public.ztable rename to zebra;`,
    );
    checked(r, 'relation:public.zebra');
    expect(checked(r, 'column:public.zebra.note')).toMatchObject({
      dataType: 'text',
      notNull: true,
    });
    // An index keeps its own name; only its table changes.
    expect(checked(r, 'relation:public.ztable_note_idx')).toMatchObject({ table: 'zebra' });
    expect(checked(r, 'rls:public.zebra')).toMatchObject({ enabled: true });
    expect(checked(r, 'policy:public.zebra.read z')).toMatchObject({
      command: 'SELECT',
      roles: ['authenticated'],
    });
    checked(r, 'constraint:public.zebra.primary_key(id)');
    expect(checked(r, 'constraint:public.child.foreign_key(z_id)')).toMatchObject({
      references: { schema: 'public', table: 'zebra', columns: ['id'] },
    });
    expect(r.get('rls:public.zebra')?.notes).toEqual([
      'table public.ztable renamed to table public.zebra by 20240201000000_b.sql line 1',
    ]);
  });

  it('SET SCHEMA: the table and its columns are checked in the new schema', () => {
    const r = resolveFirst(
      `create table orders (id int primary key, total int not null);`,
      `create schema archive;
       alter table orders set schema archive;`,
    );
    checked(r, 'relation:archive.orders');
    expect(checked(r, 'column:archive.orders.total')).toMatchObject({ notNull: true });
  });

  it('TYPE and FUNCTION: columns of the type and triggers calling the function follow', () => {
    const r = resolveFirst(
      `create type mood as enum ('ok');
       create table posts (id int, m mood, ms public.mood[]);
       create function posts_touch() returns trigger language plpgsql as $$ begin return new; end $$;
       create trigger posts_touch before update on posts for each row execute function posts_touch();`,
      `alter type mood rename to feeling;
       alter function posts_touch() rename to touch_row;`,
    );
    expect(checked(r, 'column:public.posts.m')).toMatchObject({ dataType: 'feeling' });
    expect(checked(r, 'column:public.posts.ms')).toMatchObject({ dataType: 'public.feeling[]' });
    checked(r, 'enum_value:public.feeling.ok');
    checked(r, 'function:public.touch_row()');
    expect(checked(r, 'trigger:public.posts.posts_touch')).toMatchObject({
      function: { schema: null, name: 'touch_row' },
    });
  });

  it('follows a chain of renames across files', () => {
    const r = resolveFirst(
      `create table t (a int not null);
       create index t_a_idx on t (a);`,
      `alter table t rename column a to b;`,
      `alter table t rename column b to c;`,
    );
    expect(checked(r, 'column:public.t.c')).toMatchObject({ dataType: 'integer', notNull: true });
    expect(checked(r, 'relation:public.t_a_idx')).toMatchObject({ columns: ['c'] });
  });

  it('then a DROP of the new name: superseded by the drop', () => {
    const r = resolveFirst(
      `create table t (a int);`,
      `alter table t rename to u;`,
      `drop table u;`,
    );
    expect(superseded(r, 'relation:public.u')).toBe('dropped by 20240301000000_c.sql line 1');
    expect(superseded(r, 'column:public.u.a')).toBe(
      'table public.u dropped by 20240301000000_c.sql line 1',
    );
  });

  it('onto a name the same file dropped first: the renamed object is checked there', () => {
    const [, a, b] = resolveObjects(
      parseFiles(
        `create table t (a int not null, b text);`,
        `alter table t drop column b;
         alter table t rename column a to b;`,
      ),
      0,
    );
    // a is now called b, with a's type; the old b was dropped.
    expect(a?.supersededBy).toBeUndefined();
    expect(a?.object).toMatchObject({ key: 'column:public.t.b', dataType: 'integer' });
    expect(b?.supersededBy?.reason).toBe('dropped and re-created by 20240201000000_b.sql line 2');
  });

  it('of a table the later file dropped and re-created first: the earlier one is gone', () => {
    const r = resolveFirst(
      `create table t (a int);`,
      `drop table t;
       create table t (b int);
       alter table t rename to u;`,
    );
    expect(superseded(r, 'relation:public.t')).toBe('dropped by 20240201000000_b.sql line 3');
  });
});

describe('a later DROP takes dependents along', () => {
  it('DROP COLUMN: indexes and constraints using the column', () => {
    const r = resolveFirst(
      `create table orders (id int primary key, legacy_code text, amount int, other int);
       create index orders_legacy_code_idx on orders (legacy_code);
       create index on orders (other, amount);
       create index orders_other_idx on orders (other);
       alter table orders add constraint orders_legacy_code_key unique (legacy_code);
       alter table orders add constraint orders_amount_check check (amount > 0);
       alter table orders add constraint orders_mix_check check (amount > other);
       create table other_orders (legacy_code text);
       create index other_orders_legacy_code_idx on other_orders (legacy_code);`,
      `alter table public.orders drop column legacy_code;
       alter table public.orders drop column amount;`,
    );
    const legacy = 'column public.orders.legacy_code dropped by 20240201000000_b.sql line 1';
    const amount = 'column public.orders.amount dropped by 20240201000000_b.sql line 2';
    expect(superseded(r, 'relation:public.orders_legacy_code_idx')).toBe(legacy);
    expect(superseded(r, 'constraint:public.orders.orders_legacy_code_key')).toBe(legacy);
    expect(superseded(r, 'constraint:public.orders.orders_amount_check')).toBe(amount);
    expect(superseded(r, 'constraint:public.orders.orders_mix_check')).toBe(amount);
    expect(superseded(r, 'index:public.orders(other,amount)')).toBe(amount);
    // On another column, or a same-named column of another table: still checked.
    checked(r, 'relation:public.orders_other_idx');
    checked(r, 'relation:public.other_orders_legacy_code_idx');
  });

  it('DROP TABLE: foreign keys of other tables that reference it', () => {
    const r = resolveFirst(
      `create table pa (id int primary key);
       create table pb (id int primary key);
       create table ch (id int, pa_id int references pa (id), pb_id int references pb (id));`,
      `drop table pa cascade;`,
    );
    expect(superseded(r, 'constraint:public.ch.foreign_key(pa_id)')).toBe(
      'table public.pa dropped by 20240201000000_b.sql line 1',
    );
    checked(r, 'constraint:public.ch.foreign_key(pb_id)');
    checked(r, 'column:public.ch.pa_id');
  });

  it.each(['drop function tgf() cascade;', 'drop function tgf cascade;'])(
    'DROP FUNCTION: triggers that execute it (%s)',
    (drop) => {
      const r = resolveFirst(
        `create table tt (id int);
         create function tgf() returns trigger language plpgsql as $$ begin return new; end $$;
         create function other_fn() returns trigger language plpgsql as $$ begin return new; end $$;
         create trigger tgt before update on tt for each row execute function tgf();
         create trigger other_t before update on tt for each row execute function other_fn();`,
        drop,
      );
      expect(superseded(r, 'trigger:public.tt.tgt')).toMatch(/^function public\.tgf\(.*\) dropped/);
      checked(r, 'trigger:public.tt.other_t');
    },
  );

  it('DROP TYPE: columns of the type, arrays included', () => {
    const r = resolveFirst(
      `create type col_t as enum ('a');
       create type keep_t as enum ('b');
       create table dt (id int, s col_t, ss public.col_t[], k keep_t);`,
      `drop type col_t cascade;`,
    );
    expect(superseded(r, 'column:public.dt.s')).toBe(
      'type public.col_t dropped by 20240201000000_b.sql line 1',
    );
    superseded(r, 'column:public.dt.ss');
    checked(r, 'column:public.dt.k');
  });

  it('but not a column the file moved to a rebuilt type before dropping the old one', () => {
    const r = resolveFirst(
      `create type task_status as enum ('todo', 'blocked');
       create table tasks (id int, status task_status not null);`,
      `alter type task_status rename to task_status_old;
       create type task_status as enum ('todo');
       alter table tasks alter column status type task_status using status::text::task_status;
       drop type task_status_old;`,
    );
    expect(checked(r, 'column:public.tasks.status')).toMatchObject({
      dataType: 'task_status',
      notNull: true,
    });
    expect(r.get('column:public.tasks.status')?.notes).toEqual([]);
  });
});

describe('the same SQL in one file or split across two', () => {
  /** Where an expectation came from, not what it expects. */
  const NOT_COMPARED = new Set(['source', 'recreated', 'impliedName']);

  /** Effective expectations: what is left to check, keyed, without sources and notes. */
  function effective(objects: readonly ExpectedObject[]): Record<string, unknown> {
    return Object.fromEntries(
      objects.map((o) => [
        o.key,
        Object.fromEntries(Object.entries(o).filter(([field]) => !NOT_COMPARED.has(field))),
      ]),
    );
  }

  /** One file: its net objects. Two files: the first file resolved, plus the second's objects. */
  function asOneFile(statements: readonly string[]): Record<string, unknown> {
    const [only] = parseFiles(statements.join('\n'));
    return effective(only!.objects.filter((o) => o.expect === 'present'));
  }

  function splitAt(statements: readonly string[], at: number): Record<string, unknown> {
    const files = parseFiles(statements.slice(0, at).join('\n'), statements.slice(at).join('\n'));
    const first = resolveObjects(files, 0)
      .filter((r) => r.supersededBy === undefined && r.object.expect === 'present')
      .map((r) => r.object);
    const second = files[1]!.objects.filter((o) => o.expect === 'present');
    // The later file's own declaration wins where both describe the same object.
    const merged = { ...effective(first) };
    for (const [key, value] of Object.entries(effective(second))) {
      merged[key] =
        key in merged ? { ...(merged[key] as object), ...dropNulls(value as object) } : value;
    }
    return merged;
  }

  function dropNulls(o: object): object {
    return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null));
  }

  it.each([
    {
      name: 'drop an indexed and checked column',
      sql: [
        'create table t (id int primary key, a int, b int);',
        'create index t_a_idx on t (a);',
        'create index on t (b);',
        'alter table t add constraint t_b_check check (b > 0);',
        'alter table t drop column a;',
        'alter table t drop column b;',
      ],
    },
    {
      name: 'rename a column with a unique constraint, an index and an incoming foreign key',
      sql: [
        'create table u (id int primary key, a int unique);',
        'create index u_a_idx on u (a);',
        'create table v (id int primary key, u_a int references u (a));',
        'alter table u rename column a to c;',
      ],
    },
    {
      name: 'rename a table with an incoming foreign key',
      sql: [
        'create table p (id int primary key);',
        'create table q (id int primary key, p_id int references p (id));',
        'alter table p rename to p2;',
      ],
    },
    {
      name: 'move a table with an incoming foreign key to another schema',
      sql: [
        'create table p (id int primary key);',
        'create table q (id int primary key, p_id int references p (id));',
        'create schema archive;',
        'alter table p set schema archive;',
      ],
    },
    {
      name: 'rename an enum type used by a column',
      sql: [
        "create type mood as enum ('ok');",
        'create table d (id int, m mood);',
        'alter type mood rename to feeling;',
      ],
    },
    {
      name: 'drop a parent table with CASCADE',
      sql: [
        'create table p (id int primary key);',
        'create table q (id int primary key, p_id int references p (id));',
        'drop table p cascade;',
      ],
    },
  ])('$name', ({ sql }) => {
    const whole = asOneFile(sql);
    for (let at = 1; at < sql.length; at += 1) {
      expect(splitAt(sql, at), `split before statement ${at + 1}`).toEqual(whole);
    }
  });
});
