/**
 * Statement boundaries and SourceRefs: libpg-query reports UTF-8 byte offsets, a single syntax
 * error makes it reject a whole file, and reports must still point at the right line.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SourceRef } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { excerpt } from '../../../src/parser/source.js';
import { fixture, keys, noteSummaries, objectAt, parse, TEST_FILE } from './helpers.js';

beforeAll(loadParser);

describe('loadParser', () => {
  it('can be awaited repeatedly', async () => {
    await expect(Promise.all([loadParser(), loadParser()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
  });
});

describe('SourceRef', () => {
  it('records file, statement index, 1-based line and excerpt', () => {
    const result = parse('create table a (id int);\n\n\ncreate table b (id int);\n');
    expect(objectAt(result, 'relation:public.a').source).toEqual<SourceRef>({
      file: TEST_FILE,
      statementIndex: 0,
      line: 1,
      excerpt: 'create table a (id int)',
    });
    expect(objectAt(result, 'relation:public.b').source).toEqual<SourceRef>({
      file: TEST_FILE,
      statementIndex: 1,
      line: 4,
      excerpt: 'create table b (id int)',
    });
    expect(result.statementCount).toBe(2);
  });

  it('starts at the first keyword, skipping leading comments', () => {
    const result = parse('-- header\n/* block */\n  create table a (id int);');
    expect(objectAt(result, 'relation:public.a').source.line).toBe(3);
  });

  it('slices by UTF-8 bytes, so multibyte comments do not shift lines or excerpts', () => {
    const result = parse(fixture('multibyte-comments.sql'));
    const at = (key: string): [number, number, string] => {
      const { statementIndex, line, excerpt } = objectAt(result, key).source;
      return [statementIndex, line, excerpt];
    };
    expect(at('relation:public.notes')).toEqual([0, 2, 'create table public.notes (body text)']);
    expect(at('relation:public.tags')).toEqual([1, 4, 'create table public.tags (label text)']);
    expect(at('relation:public.notes_body_idx')).toEqual([
      2,
      6,
      'create index notes_body_idx on public.notes (body)',
    ]);
  });
});

describe('excerpt', () => {
  it('collapses whitespace', () => {
    expect(excerpt('create   table\n\t t (\n  id int\n)')).toBe('create table t ( id int )');
  });

  it('truncates long statements to 160 characters with an ellipsis', () => {
    const long = `create table t (${Array.from({ length: 40 }, (_, i) => `c${i.toString()} int`).join(', ')})`;
    const result = excerpt(long);
    expect(result).toHaveLength(160);
    expect(result.endsWith('...')).toBe(true);
    expect(long.startsWith(result.slice(0, -3))).toBe(true);
  });

  it('keeps short statements whole', () => {
    expect(excerpt('select 1')).toBe('select 1');
  });
});

describe('statement splitting', () => {
  it('does not split on semicolons inside strings, comments and dollar-quoted bodies', () => {
    const result = parse(`
      create function f() returns text language sql as $$ select 'a;b'; $$;
      -- a comment; with a semicolon
      create table t (note text default 'x;y'); /* also ; here */
    `);
    expect(result.statementCount).toBe(2);
    expect(keys(result)).toEqual([
      'function:public.f()',
      'relation:public.t',
      'column:public.t.note',
    ]);
  });

  it('returns nothing for an empty or comment-only file', () => {
    expect(parse('')).toEqual({ file: TEST_FILE, objects: [], notes: [], statementCount: 0 });
    expect(parse('  \n\t')).toEqual({ file: TEST_FILE, objects: [], notes: [], statementCount: 0 });
    expect(parse('-- nothing here\n/* or here */\n')).toEqual({
      file: TEST_FILE,
      objects: [],
      notes: [],
      statementCount: 0,
    });
  });

  it('accepts a last statement without a trailing semicolon', () => {
    const result = parse('create table a (id int);\ncreate table b (id int)');
    expect(objectAt(result, 'relation:public.b').source.excerpt).toBe('create table b (id int)');
  });

  it('handles Windows line endings', () => {
    const result = parse('create table a (id int);\r\n\r\ncreate table b (\r\n  id int\r\n);\r\n');
    const b = objectAt(result, 'relation:public.b').source;
    expect([b.line, b.excerpt]).toEqual([3, 'create table b ( id int )']);
  });

  it('ignores a UTF-8 byte order mark, which the Postgres lexer would reject', () => {
    const result = parse('﻿create table a (id int);\ncreate table b (id int);');
    expect(result.notes).toEqual([]);
    expect(objectAt(result, 'relation:public.a').source).toMatchObject({
      line: 1,
      excerpt: 'create table a (id int)',
    });
    expect(objectAt(result, 'relation:public.b').source.line).toBe(2);
  });
});

describe('a broken statement in the middle of a file', () => {
  const result = (): ReturnType<typeof parse> => parse(fixture('broken-statement.sql'));

  it('still analyzes every other statement', () => {
    expect(keys(result())).toEqual([
      'relation:public.projects',
      'column:public.projects.id',
      'constraint:public.projects.primary_key(id)',
      'relation:public.todos',
      'column:public.todos.id',
      'column:public.todos.title',
      // BEGIN ATOMIC bodies contain top-level semicolons; the splitter re-joins them.
      'function:public.answer()',
      'relation:public.todos_title_idx',
    ]);
    expect(result().statementCount).toBe(5);
  });

  it('reports a ParseError note with the line of the error', () => {
    const [note] = result().notes;
    expect(result().notes).toHaveLength(1);
    expect(note).toEqual({
      category: 'unverifiable',
      statementType: 'ParseError',
      reason: 'syntax error at or near "," (line 5)',
      source: {
        file: TEST_FILE,
        statementIndex: 1,
        line: 4,
        excerpt: 'create table public.broken ( id int,, name text )',
      },
    });
  });

  it('keeps statement indexes and lines of later statements correct', () => {
    const todos = objectAt(result(), 'relation:public.todos').source;
    expect([todos.statementIndex, todos.line]).toEqual([2, 9]);
    const index = objectAt(result(), 'relation:public.todos_title_idx').source;
    expect([index.statementIndex, index.line]).toEqual([4, 18]);
  });

  it('counts the error line in characters even after multibyte text', () => {
    const sql =
      '-- ✓✓✓ ünïcödé\ncreate table ok (id int);\ncreate table é (\n  a int,,\n  b int\n);';
    expect(noteSummaries(parse(sql))).toEqual([
      ['unverifiable', 'ParseError', 'syntax error at or near "," (line 4)'],
    ]);
  });

  it('reports several broken statements separately', () => {
    const result = parse(
      'create tabel a (id int);\ncreate table ok (id int);\nalter tabel b add c int;',
    );
    expect(keys(result)).toEqual(['relation:public.ok', 'column:public.ok.id']);
    expect(
      result.notes.map((n) => [n.statementType, n.source.statementIndex, n.source.line]),
    ).toEqual([
      ['ParseError', 0, 1],
      ['ParseError', 2, 3],
    ]);
  });

  it('turns an unterminated string (which defeats the lexer) into a single note', () => {
    const result = parse("create table a (id int);\ncreate table b (note text default 'oops);\n");
    expect(result.objects).toEqual([]);
    expect(result.statementCount).toBe(1);
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]?.statementType).toBe('ParseError');
    expect(result.notes[0]?.reason).toMatch(/unterminated quoted string/);
  });
});
