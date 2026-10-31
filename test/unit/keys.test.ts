import { describe, expect, it } from 'vitest';
import { describeObject } from '../../src/keys.js';
import type { ExpectedObject } from '../../src/model.js';

/** An object as the parser would emit it; `describeObject` only reads identity fields. */
function obj(
  fields: DistributiveOmit<ExpectedObject, 'key' | 'expect' | 'source'>,
): ExpectedObject {
  return {
    ...fields,
    key: '',
    expect: 'present',
    source: { file: 'x.sql', statementIndex: 0, line: 1, excerpt: '' },
  };
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

describe('describeObject', () => {
  it.each<[ExpectedObject, string]>([
    [obj({ kind: 'schema', schema: 'App', name: 'App' }), 'schema "App"'],
    [obj({ kind: 'table', schema: 'public', name: 'todos' }), 'table public.todos'],
    [
      obj({ kind: 'materialized_view', schema: 'app', name: 'Daily Stats' }),
      'materialized view app."Daily Stats"',
    ],
    [
      obj({
        kind: 'column',
        schema: 'app',
        table: 'Todo Items',
        name: 'projectId',
        dataType: null,
        notNull: null,
      }),
      'column app."Todo Items"."projectId"',
    ],
    [
      obj({
        kind: 'index',
        schema: 'app',
        table: 'Todo Items',
        name: null,
        unique: null,
        method: null,
        columns: ['projectId', '(lower("Title"))'],
      }),
      'index on app."Todo Items" ("projectId", (lower("Title")))',
    ],
    [
      obj({
        kind: 'constraint',
        schema: 'public',
        table: 'todos',
        name: null,
        constraintType: 'primary_key',
        columns: ['id'],
        references: null,
      }),
      'primary key on public.todos (id)',
    ],
    [
      obj({
        kind: 'function',
        schema: 'public',
        name: 'Archive',
        argTypes: ['bigint'],
        isProcedure: true,
      }),
      'procedure public."Archive"(bigint)',
    ],
    [
      obj({
        kind: 'policy',
        schema: 'public',
        table: 'todos',
        name: 'Say "hi"',
        command: null,
        permissive: null,
        roles: null,
        using: null,
        withCheck: null,
      }),
      'policy "Say ""hi""" on public.todos',
    ],
    [
      obj({ kind: 'enum_value', schema: 'public', typeName: 'Mood', value: "it's ok" }),
      `enum value public."Mood".'it''s ok'`,
    ],
  ])('%#: %s', (o, text) => {
    expect(describeObject(o)).toBe(text);
  });
});
