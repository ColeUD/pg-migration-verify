/** Enums (and their values), composite, domain, range and shell types. */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, keys, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

describe('enums', () => {
  it('CREATE TYPE ... AS ENUM gives the type and one object per value', () => {
    const result = parse(
      `create type public.job_status as enum ('queued', 'running', 'In Progress');`,
    );
    expect(result.objects.map(attributes)).toEqual([
      { kind: 'type', expect: 'present', schema: 'public', name: 'job_status', typeKind: 'enum' },
      {
        kind: 'enum_value',
        expect: 'present',
        schema: 'public',
        typeName: 'job_status',
        value: 'queued',
      },
      {
        kind: 'enum_value',
        expect: 'present',
        schema: 'public',
        typeName: 'job_status',
        value: 'running',
      },
      {
        kind: 'enum_value',
        expect: 'present',
        schema: 'public',
        typeName: 'job_status',
        value: 'In Progress',
      },
    ]);
  });

  it.each([
    ["alter type job_status add value 'failed'", 'failed'],
    ["alter type job_status add value if not exists 'failed' before 'done'", 'failed'],
    ["alter type public.job_status add value 'paused' after 'running'", 'paused'],
  ])('%s', (sql, value) => {
    expect(parse(sql).objects.map(attributes)).toEqual([
      { kind: 'enum_value', expect: 'present', schema: 'public', typeName: 'job_status', value },
    ]);
  });

  it('RENAME VALUE makes the old value absent and the new one present', () => {
    const result = parse("alter type job_status rename value 'queued' to 'pending';");
    expect(result.objects.map((o) => [o.key, o.expect])).toEqual([
      ['enum_value:public.job_status.queued', 'absent'],
      ['enum_value:public.job_status.pending', 'present'],
    ]);
  });

  it('ADD VALUE after CREATE TYPE in the same file extends the same enum', () => {
    const result = parse(`
      create type mood as enum ('happy');
      alter type mood add value 'sad';`);
    expect(keys(result)).toEqual([
      'type:public.mood',
      'enum_value:public.mood.happy',
      'enum_value:public.mood.sad',
    ]);
  });
});

describe('other user-defined types', () => {
  it.each([
    ['create type address as (street text, city text, zip varchar(10));', 'address', 'composite'],
    ["create domain email as citext check (value ~ '^[^@]+@[^@]+$');", 'email', 'domain'],
    ['create domain app.positive_int as integer check (value > 0);', 'positive_int', 'domain'],
    ['create type timerange as range (subtype = time);', 'timerange', 'range'],
    // A shell type is completed later by CREATE TYPE ... (INPUT = ...), so its kind is not asserted.
    ['create type opaque_thing;', 'opaque_thing', null],
  ])('%s', (sql, name, typeKind) => {
    const [type] = parse(sql).objects;
    expect(type).toMatchObject({ kind: 'type', expect: 'present', name, typeKind });
  });

  it('keeps the schema of a schema-qualified domain', () => {
    expect(keys(parse('create domain app.positive_int as integer check (value > 0);'))).toEqual([
      'type:app.positive_int',
    ]);
  });
});

describe('dropping and renaming types', () => {
  it('DROP TYPE removes the enum values this file created', () => {
    const result = parse(`
      create type mood as enum ('happy', 'sad');
      drop type mood;`);
    expect(result.objects.map((o) => [o.key, o.expect])).toEqual([['type:public.mood', 'absent']]);
  });

  it('ALTER TYPE ... RENAME TO moves the enum values to the new name', () => {
    const result = parse(`
      create type mood as enum ('happy');
      alter type mood rename to feeling;`);
    expect(result.objects.map((o) => [o.key, o.expect])).toEqual([
      ['type:public.mood', 'absent'],
      ['enum_value:public.feeling.happy', 'present'],
      ['type:public.feeling', 'present'],
    ]);
    expect(objectAt(result, 'type:public.feeling')).toMatchObject({ typeKind: 'enum' });
  });

  it('ALTER TYPE ... SET SCHEMA moves the enum values to the new schema', () => {
    const result = parse(`
      create type mood as enum ('happy');
      alter type mood set schema app;`);
    expect(result.objects.map((o) => [o.key, o.expect])).toEqual([
      ['type:public.mood', 'absent'],
      ['enum_value:app.mood.happy', 'present'],
      ['type:app.mood', 'present'],
    ]);
  });
});
