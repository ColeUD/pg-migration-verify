/**
 * DO blocks: static SQL inside the PL/pgSQL body is analyzed like top-level SQL and flagged
 * `inDoBlock`; dynamic SQL and unparsable bodies become notes.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { SourceRef } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { fixture, keys, noteSummaries, objectAt, parse, TEST_FILE } from './helpers.js';

beforeAll(loadParser);

describe('DO blocks', () => {
  const result = (): ReturnType<typeof parse> => parse(fixture('do-blocks.sql'));

  it('analyzes the "create type if not exists" pattern without noting the existence check', () => {
    expect(keys(result()).slice(0, 4)).toEqual([
      'type:public.task_priority',
      'enum_value:public.task_priority.low',
      'enum_value:public.task_priority.medium',
      'enum_value:public.task_priority.high',
    ]);
    expect(result().notes.filter((n) => n.source.statementIndex === 0)).toEqual([]);
  });

  it('flags objects from a DO block and points at the DO statement', () => {
    expect(objectAt(result(), 'type:public.task_priority').source).toEqual<SourceRef>({
      file: TEST_FILE,
      statementIndex: 0,
      line: 2,
      excerpt: "create type public.task_priority as enum ('low', 'medium', 'high')",
      inDoBlock: true,
    });
  });

  it('finds statements inside nested BEGIN ... EXCEPTION blocks', () => {
    expect(objectAt(result(), 'column:public.todos.priority')).toMatchObject({
      expect: 'present',
      dataType: 'public.task_priority',
      notNull: true,
      source: { statementIndex: 1, line: 10, inDoBlock: true },
    });
  });

  it('notes dynamic SQL, which cannot be known without running it', () => {
    expect(noteSummaries(result())).toEqual([
      ['unverifiable', 'DoStmt', 'dynamic SQL inside DO block (EXECUTE) cannot be checked'],
    ]);
    expect(result().notes[0]?.source.line).toBe(18);
    expect(result().statementCount).toBe(3);
  });

  it('accepts an explicit LANGUAGE plpgsql and other dollar-quote tags', () => {
    const r = parse('do language plpgsql $body$ begin create table t (id int); end $body$;');
    expect(keys(r)).toEqual(['relation:public.t', 'column:public.t.id']);
  });

  it('still works when the body contains the tag used to wrap it for parsing', () => {
    const r = parse("do $do$ begin raise notice '$pmv$'; create table t (id int); end $do$;");
    expect(keys(r)).toEqual(['relation:public.t', 'column:public.t.id']);
  });

  it('reports statements inside the block with their own statement type', () => {
    const r = parse(`do $$ begin
      grant select on todos to anon;
      perform pg_notify('x', 'y');
    end $$;`);
    expect(noteSummaries(r)).toEqual([['unverifiable', 'GrantStmt', 'privileges are not checked']]);
    expect(r.notes[0]?.source.inDoBlock).toBe(true);
  });

  it('notes EXECUTE in FOR ... IN EXECUTE loops too', () => {
    const r = parse(`do $$ declare r record; begin
      for r in execute 'select 1' loop create table t (id int); end loop;
    end $$;`);
    expect(keys(r)).toEqual(['relation:public.t', 'column:public.t.id']);
    expect(noteSummaries(r)).toEqual([
      ['unverifiable', 'DoStmt', 'dynamic SQL inside DO block (EXECUTE) cannot be checked'],
    ]);
  });

  it.each([
    [
      'a block with nothing to check',
      "do $$ begin raise notice 'hello'; end $$;",
      'DO block contains no statements that can be checked',
    ],
    [
      'another language',
      "do language plpython3u $$ plpy.notice('hi') $$;",
      'DO blocks in language plpython3u are not analyzed',
    ],
    [
      'a body that does not parse',
      'do $$ begin if true then create table t (id int); end $$;',
      'DO block body could not be parsed: syntax error at end of input',
    ],
  ])('notes %s', (_label, sql, reason) => {
    const r = parse(sql);
    expect(r.objects).toEqual([]);
    expect(noteSummaries(r)).toEqual([['unverifiable', 'DoStmt', reason]]);
  });
});
