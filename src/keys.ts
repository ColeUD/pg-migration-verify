import type { ExpectedObject } from './model.js';
import { qualifiedName, quoteIdent, quoteKeyColumn } from './sql-ident.js';

/** Fields an object needs for its identity; everything else about it is an attribute. */
export type ObjectIdentity =
  | { kind: 'schema'; schema: string }
  | { kind: 'extension'; name: string }
  | { kind: 'table' | 'view' | 'materialized_view' | 'sequence'; schema: string; name: string }
  | { kind: 'column'; schema: string; table: string; name: string }
  | {
      kind: 'index';
      schema: string;
      table: string;
      name: string | null;
      columns: string[] | null;
    }
  | {
      kind: 'constraint';
      schema: string;
      table: string;
      name: string | null;
      constraintType: string | null;
      columns: string[] | null;
    }
  | { kind: 'function'; schema: string; name: string; argTypes: string[] | null }
  | { kind: 'trigger'; schema: string; table: string; name: string }
  | { kind: 'rls'; schema: string; table: string }
  | { kind: 'policy'; schema: string; table: string; name: string }
  | { kind: 'type'; schema: string; name: string }
  | { kind: 'enum_value'; schema: string; typeName: string; value: string };

/**
 * Stable key for a database object. Two expectations with the same key talk about the same object,
 * which is how the parser merges statements within a file and the verifier detects later
 * migrations that alter, drop or rename it.
 *
 * Index names are unique per schema (not per table), so index keys omit the table. Unnamed indexes
 * and constraints are keyed by their table and columns.
 */
export function objectKey(o: ObjectIdentity): string {
  switch (o.kind) {
    case 'schema':
      return `schema:${o.schema}`;
    case 'extension':
      return `extension:${o.name}`;
    case 'table':
    case 'view':
    case 'materialized_view':
    case 'sequence':
      // Tables, views, sequences and indexes share one namespace (pg_class).
      return `relation:${o.schema}.${o.name}`;
    case 'column':
      return `column:${o.schema}.${o.table}.${o.name}`;
    case 'index':
      return o.name !== null
        ? `relation:${o.schema}.${o.name}`
        : `index:${o.schema}.${o.table}(${(o.columns ?? []).join(',')})`;
    case 'constraint':
      return o.name !== null
        ? `constraint:${o.schema}.${o.table}.${o.name}`
        : `constraint:${o.schema}.${o.table}.${o.constraintType ?? '?'}(${(o.columns ?? []).join(',')})`;
    case 'function':
      return `function:${o.schema}.${o.name}(${o.argTypes === null ? '*' : o.argTypes.join(',')})`;
    case 'trigger':
      return `trigger:${o.schema}.${o.table}.${o.name}`;
    case 'rls':
      return `rls:${o.schema}.${o.table}`;
    case 'policy':
      return `policy:${o.schema}.${o.table}.${o.name}`;
    case 'type':
      return `type:${o.schema}.${o.name}`;
    case 'enum_value':
      return `enum_value:${o.schema}.${o.typeName}.${o.value}`;
  }
}

/** Key of the table (or type, for enum values) an object belongs to, used for cascading drops. */
export function parentKey(o: ExpectedObject): string | null {
  switch (o.kind) {
    case 'column':
    case 'index':
    case 'constraint':
    case 'trigger':
    case 'rls':
    case 'policy':
      return `relation:${o.schema}.${o.table}`;
    case 'enum_value':
      return `type:${o.schema}.${o.typeName}`;
    default:
      return null;
  }
}

/**
 * Human-readable one-line name, e.g. `column public.profiles.avatar_url`. Identifiers are quoted
 * like `quote_ident()` (`column app."Todo Items"."projectId"`), so a name with spaces or capitals
 * stays unambiguous and can be pasted back into SQL. Policy names are always quoted: they are
 * usually sentences.
 */
export function describeObject(o: ExpectedObject): string {
  switch (o.kind) {
    case 'schema':
      return `schema ${quoteIdent(o.name)}`;
    case 'extension':
      return `extension ${quoteIdent(o.name)}`;
    case 'table':
    case 'view':
    case 'sequence':
      return `${o.kind} ${qualifiedName(o.schema, o.name)}`;
    case 'materialized_view':
      return `materialized view ${qualifiedName(o.schema, o.name)}`;
    case 'column':
      return `column ${qualifiedName(o.schema, o.table)}.${quoteIdent(o.name)}`;
    case 'index':
      return o.name !== null
        ? `index ${qualifiedName(o.schema, o.name)}`
        : `index on ${qualifiedName(o.schema, o.table)} ${keyColumnsText(o.columns)}`;
    case 'constraint':
      return o.name !== null
        ? `constraint ${quoteIdent(o.name)} on ${qualifiedName(o.schema, o.table)}`
        : `${(o.constraintType ?? 'constraint').replace('_', ' ')} on ${qualifiedName(o.schema, o.table)} ${keyColumnsText(o.columns)}`;
    case 'function':
      return `${o.isProcedure ? 'procedure' : 'function'} ${qualifiedName(o.schema, o.name)}(${o.argTypes === null ? '...' : o.argTypes.join(', ')})`;
    case 'trigger':
      return `trigger ${quoteIdent(o.name)} on ${qualifiedName(o.schema, o.table)}`;
    case 'rls':
      return `row level security on ${qualifiedName(o.schema, o.table)}`;
    case 'policy':
      return `policy "${o.name.replaceAll('"', '""')}" on ${qualifiedName(o.schema, o.table)}`;
    case 'type':
      return `${o.typeKind === 'enum' ? 'enum type' : 'type'} ${qualifiedName(o.schema, o.name)}`;
    case 'enum_value':
      return `enum value ${qualifiedName(o.schema, o.typeName)}.'${o.value.replaceAll("'", "''")}'`;
  }
}

function keyColumnsText(columns: readonly string[] | null): string {
  return `(${(columns ?? []).map(quoteKeyColumn).join(', ')})`;
}
