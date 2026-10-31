import { describeObject, parentKey } from '../keys.js';
import type { ExpectedObject, ParsedMigration } from '../model.js';
import { ATTRIBUTE_LABELS, isAttributeField } from './attributes.js';

/**
 * What a migration's object should look like in today's database, given every later migration.
 * Either an effective expectation to check, or the reason it cannot be checked any more.
 */
export interface ResolvedObject {
  /** The original object with later non-null attribute changes merged in. */
  object: ExpectedObject;
  /** One entry per attribute a later migration changed, e.g. `type updated by 0005_x.sql line 3`. */
  notes: string[];
  supersededBy?: { file: string; reason: string };
}

/**
 * Resolve every object of `migrations[index]` against the migrations after it (which must be in
 * version order). A migration is only judged on what still holds today: a table dropped two
 * migrations later must not count as missing, and a column whose type a later ALTER changed must be
 * checked against the new type.
 */
export function resolveObjects(
  migrations: readonly ParsedMigration[],
  index: number,
): ResolvedObject[] {
  const later = migrations.slice(index + 1);
  return (migrations[index]?.objects ?? []).map((o) => resolveObject(o, later));
}

function resolveObject(
  original: ExpectedObject,
  laterMigrations: readonly ParsedMigration[],
): ResolvedObject {
  let object = original;
  const notes: string[] = [];
  for (const migration of laterMigrations) {
    for (const later of migration.objects) {
      const reason = supersedeReason(object, later);
      if (reason !== null) {
        return { object, notes, supersededBy: { file: later.source.file, reason } };
      }
      if (later.key === object.key && later.expect === 'present' && object.expect === 'present') {
        const merged = mergeAttributes(object, later);
        object = merged.object;
        notes.push(...merged.changed.map((label) => `${label} updated by ${at(later)}`));
      }
    }
  }
  return { object, notes };
}

/** Why `later` makes `o` impossible to check against its own migration, or null. */
function supersedeReason(o: ExpectedObject, later: ExpectedObject): string | null {
  if (later.expect === 'absent') {
    if (later.key === o.key) return `dropped or renamed by ${at(later)}`;
    if (later.key === parentKey(o))
      return `${describeObject(later)} dropped or renamed by ${at(later)}`;
    // `DROP SCHEMA ... CASCADE` takes everything in it along.
    if (
      later.kind === 'schema' &&
      o.kind !== 'extension' &&
      o.kind !== 'schema' &&
      later.name === o.schema
    ) {
      return `${describeObject(later)} dropped by ${at(later)}`;
    }
    // `DROP FUNCTION f` without an argument list drops the only overload, whichever it is.
    if (
      later.kind === 'function' &&
      later.argTypes === null &&
      o.kind === 'function' &&
      later.schema === o.schema &&
      later.name === o.name
    ) {
      return `dropped by ${at(later)}`;
    }
    return null;
  }
  if (later.key !== o.key) return null;
  if (o.expect === 'absent') return `re-created by ${at(later)}`;
  // Tables, views, sequences and indexes share one namespace: a view may replace a table.
  if (later.kind !== o.kind) return `replaced by ${describeObject(later)} in ${at(later)}`;
  return null;
}

/**
 * Overlay the attributes `later` asserts (non-null) on `current`. Identity fields are equal by
 * construction (same key) and are left alone. Returns the labels of attributes whose value changed.
 */
function mergeAttributes(
  current: ExpectedObject,
  later: ExpectedObject,
): { object: ExpectedObject; changed: string[] } {
  const merged: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  for (const [field, value] of Object.entries(later)) {
    if (value === null || value === undefined || IDENTITY_FIELDS.has(field)) continue;
    if (JSON.stringify(value) === JSON.stringify(merged[field])) continue;
    merged[field] = value;
    // Display-only fields (policy expressions) follow along silently.
    if (isAttributeField(field)) changed.push(ATTRIBUTE_LABELS[field]);
  }
  // Same key and kind as `current`, with only attribute values replaced: still the same variant.
  return { object: merged as unknown as ExpectedObject, changed };
}

const IDENTITY_FIELDS: ReadonlySet<string> = new Set([
  'kind',
  'key',
  'expect',
  'schema',
  'source',
  'name',
  'table',
  'typeName',
  'value',
  'argTypes',
]);

function at(o: ExpectedObject): string {
  return `${o.source.file} line ${o.source.line}`;
}
