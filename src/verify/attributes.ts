import type { ConstraintType, RelationKind, TriggerEvent } from '../model.js';
import { qualifiedName, quoteKeyColumn } from '../sql-ident.js';

/**
 * Display names of the asserted attributes of expected objects, keyed by model field. The same
 * label names a `Difference` found by the comparator and a note left by the timeline when a later
 * migration changes the attribute, so the two read alike in a report. Fields absent from this map
 * are identity (part of the key) or display-only (policy expressions) and are never reported.
 */
export const ATTRIBUTE_LABELS = {
  dataType: 'type',
  notNull: 'nullability',
  unique: 'unique',
  method: 'method',
  columns: 'columns',
  constraintType: 'constraint type',
  references: 'references',
  isProcedure: 'kind',
  timing: 'timing',
  events: 'events',
  forEachRow: 'level',
  function: 'function',
  enabled: 'row level security',
  forced: 'forced',
  command: 'command',
  permissive: 'mode',
  roles: 'roles',
  typeKind: 'type kind',
} as const;

export type AttributeField = keyof typeof ATTRIBUTE_LABELS;

export function isAttributeField(field: string): field is AttributeField {
  return Object.hasOwn(ATTRIBUTE_LABELS, field);
}

// Small value formatters shared by the comparator (difference values) and the formatters
// (expected-attribute summaries), so both spell the same value the same way.

export function nullabilityText(notNull: boolean): string {
  return notNull ? 'not null' : 'nullable';
}

export function columnListText(columns: readonly string[]): string {
  return `(${columns.map(quoteKeyColumn).join(', ')})`;
}

export function constraintTypeText(type: ConstraintType): string {
  return type.replace('_', ' ');
}

export function relationKindText(kind: RelationKind | 'materialized_view'): string {
  return kind.replace('_', ' ');
}

export function referencesText(ref: {
  schema: string;
  table: string;
  columns: readonly string[] | null;
}): string {
  const table = qualifiedName(ref.schema, ref.table);
  return ref.columns === null ? table : `${table} ${columnListText(ref.columns)}`;
}

/** Events in canonical order, the way Postgres prints them: `INSERT OR UPDATE`. */
export function eventsText(events: readonly TriggerEvent[]): string {
  return sortEvents(events).join(' OR ');
}

export function sortEvents(events: readonly TriggerEvent[]): TriggerEvent[] {
  const order: readonly TriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
  return [...new Set(events)].sort((a, b) => order.indexOf(a) - order.indexOf(b));
}

export function triggerLevelText(forEachRow: boolean): string {
  return forEachRow ? 'row' : 'statement';
}

/** A trigger function as written: unqualified when the migration did not name a schema. */
export function functionRefText(fn: { schema: string | null; name: string }): string {
  return qualifiedName(fn.schema, fn.name);
}

export function permissiveText(permissive: boolean): string {
  return permissive ? 'permissive' : 'restrictive';
}

export function rlsEnabledText(enabled: boolean): string {
  return enabled ? 'enabled' : 'disabled';
}

export function rlsForcedText(forced: boolean): string {
  return forced ? 'forced' : 'not forced';
}

export function rolesText(roles: readonly string[]): string {
  return [...roles].sort().join(', ');
}
