import type {
  ConstraintType,
  PolicyCommand,
  RelationKind,
  TriggerEvent,
  TypeKind,
} from '../model.js';

/**
 * Decoders for pg_catalog's one-letter codes and bit masks. They are kept apart from the queries
 * so the mapping can be unit-tested without a server. Codes the queries filter out (or that a
 * future Postgres might add) throw rather than being guessed at: a wrong snapshot would make the
 * verifier report confident but false results.
 */

const RELATION_KINDS: Readonly<Record<string, RelationKind>> = {
  r: 'table',
  p: 'partitioned_table',
  v: 'view',
  m: 'materialized_view',
  S: 'sequence',
  f: 'foreign_table',
};

/** `pg_class.relkind` -> model kind; anything unlisted is `other` (the model reserves it). */
export function relationKind(relkind: string): RelationKind {
  return RELATION_KINDS[relkind] ?? 'other';
}

const CONSTRAINT_TYPES: Readonly<Record<string, ConstraintType>> = {
  p: 'primary_key',
  u: 'unique',
  f: 'foreign_key',
  c: 'check',
  x: 'exclusion',
};

/** `pg_constraint.contype` -> model type. The query only returns p, u, f, c and x. */
export function constraintType(contype: string): ConstraintType {
  return lookup(CONSTRAINT_TYPES, contype, 'pg_constraint.contype');
}

// pg_trigger.tgtype bits, from src/include/catalog/pg_trigger.h.
const TRIGGER_TYPE_ROW = 1 << 0;
const TRIGGER_TYPE_BEFORE = 1 << 1;
const TRIGGER_TYPE_INSERT = 1 << 2;
const TRIGGER_TYPE_DELETE = 1 << 3;
const TRIGGER_TYPE_UPDATE = 1 << 4;
const TRIGGER_TYPE_TRUNCATE = 1 << 5;
const TRIGGER_TYPE_INSTEAD = 1 << 6;

/** Events in the model's canonical order (INSERT, UPDATE, DELETE, TRUNCATE) with their bits. */
const TRIGGER_EVENTS: readonly (readonly [TriggerEvent, number])[] = [
  ['INSERT', TRIGGER_TYPE_INSERT],
  ['UPDATE', TRIGGER_TYPE_UPDATE],
  ['DELETE', TRIGGER_TYPE_DELETE],
  ['TRUNCATE', TRIGGER_TYPE_TRUNCATE],
];

export interface DecodedTriggerType {
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
  events: TriggerEvent[];
  forEachRow: boolean;
}

/** Decodes the `pg_trigger.tgtype` bit mask. Neither BEFORE nor INSTEAD set means AFTER. */
export function decodeTriggerType(tgtype: number): DecodedTriggerType {
  const timing =
    (tgtype & TRIGGER_TYPE_INSTEAD) !== 0
      ? 'INSTEAD OF'
      : (tgtype & TRIGGER_TYPE_BEFORE) !== 0
        ? 'BEFORE'
        : 'AFTER';
  return {
    timing,
    events: TRIGGER_EVENTS.filter(([, bit]) => (tgtype & bit) !== 0).map(([event]) => event),
    forEachRow: (tgtype & TRIGGER_TYPE_ROW) !== 0,
  };
}

const POLICY_COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  r: 'SELECT',
  a: 'INSERT',
  w: 'UPDATE',
  d: 'DELETE',
  '*': 'ALL',
};

/** `pg_policy.polcmd` -> model command. */
export function policyCommand(polcmd: string): PolicyCommand {
  return lookup(POLICY_COMMANDS, polcmd, 'pg_policy.polcmd');
}

const TYPE_KINDS: Readonly<Record<string, TypeKind>> = {
  e: 'enum',
  c: 'composite',
  d: 'domain',
  r: 'range',
  b: 'other',
};

/** `pg_type.typtype` -> model kind, for the kinds the TYPES query returns. */
export function typeKind(typtype: string): TypeKind {
  return lookup(TYPE_KINDS, typtype, 'pg_type.typtype');
}

function lookup<T>(table: Readonly<Record<string, T>>, code: string, column: string): T {
  const value = table[code];
  if (value === undefined) throw new Error(`unexpected ${column} value '${code}'`);
  return value;
}
