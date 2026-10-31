import { describe, expect, it } from 'vitest';
import {
  constraintType,
  decodeTriggerType,
  fkAction,
  policyCommand,
  relationKind,
  typeKind,
} from '../../../src/catalog/decode.js';

describe('relationKind', () => {
  it.each([
    ['r', 'table'],
    ['p', 'partitioned_table'],
    ['v', 'view'],
    ['m', 'materialized_view'],
    ['S', 'sequence'],
    ['f', 'foreign_table'],
    ['z', 'other'],
  ])('relkind %s -> %s', (code, kind) => {
    expect(relationKind(code)).toBe(kind);
  });
});

describe('constraintType', () => {
  it.each([
    ['p', 'primary_key'],
    ['u', 'unique'],
    ['f', 'foreign_key'],
    ['c', 'check'],
    ['x', 'exclusion'],
  ])('contype %s -> %s', (code, type) => {
    expect(constraintType(code)).toBe(type);
  });

  it('rejects PostgreSQL 18 NOT NULL constraints, which the query filters out', () => {
    expect(() => constraintType('n')).toThrow("unexpected pg_constraint.contype value 'n'");
  });
});

describe('fkAction', () => {
  it.each([
    ['a', 'no_action'],
    ['r', 'restrict'],
    ['c', 'cascade'],
    ['n', 'set_null'],
    ['d', 'set_default'],
  ])('confdeltype %s -> %s', (code, action) => {
    expect(fkAction(code)).toBe(action);
  });

  it('rejects an unknown code', () => {
    expect(() => fkAction('z')).toThrow("unexpected pg_constraint.confdeltype value 'z'");
  });
});

describe('decodeTriggerType', () => {
  // Bits: ROW 1, BEFORE 2, INSERT 4, DELETE 8, UPDATE 16, TRUNCATE 32, INSTEAD 64.
  it.each([
    [1 | 2 | 4 | 16, 'BEFORE', ['INSERT', 'UPDATE'], true],
    [4 | 8 | 32, 'AFTER', ['INSERT', 'DELETE', 'TRUNCATE'], false],
    [1 | 64 | 4, 'INSTEAD OF', ['INSERT'], true],
    [1 | 16, 'AFTER', ['UPDATE'], true],
    [2 | 32 | 16 | 8 | 4, 'BEFORE', ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'], false],
  ])('tgtype %i -> %s %j row=%s', (tgtype, timing, events, forEachRow) => {
    expect(decodeTriggerType(tgtype)).toEqual({ timing, events, forEachRow });
  });
});

describe('policyCommand', () => {
  it.each([
    ['r', 'SELECT'],
    ['a', 'INSERT'],
    ['w', 'UPDATE'],
    ['d', 'DELETE'],
    ['*', 'ALL'],
  ])('polcmd %s -> %s', (code, command) => {
    expect(policyCommand(code)).toBe(command);
  });

  it('rejects unknown codes', () => {
    expect(() => policyCommand('x')).toThrow(/pg_policy\.polcmd/);
  });
});

describe('typeKind', () => {
  it.each([
    ['e', 'enum'],
    ['c', 'composite'],
    ['d', 'domain'],
    ['r', 'range'],
    ['b', 'other'],
  ])('typtype %s -> %s', (code, kind) => {
    expect(typeKind(code)).toBe(kind);
  });

  it('rejects multiranges and pseudo types, which the query skips', () => {
    expect(() => typeKind('m')).toThrow(/pg_type\.typtype/);
    expect(() => typeKind('p')).toThrow(/pg_type\.typtype/);
  });
});
