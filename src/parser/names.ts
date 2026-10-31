/**
 * Name resolution: turn the parser's relation and qualified-name nodes into `{ schema, name }`.
 *
 * libpg-query already folds unquoted identifiers to lower case and strips quotes, so names come
 * out exactly as Postgres stores them. Unqualified names resolve to the statement's default
 * schema (the first entry of the migration's effective search_path).
 */
import type { Node, RangeVar } from 'libpg-query';
import { stringValues } from './ast.js';

export interface QualifiedName {
  schema: string;
  name: string;
}

/** Resolve a `RangeVar` (`app.todos`, `"Orders"`, `todos`) against the default schema. */
export function relationName(relation: RangeVar | undefined, defaultSchema: string): QualifiedName {
  return { schema: relation?.schemaname ?? defaultSchema, name: relation?.relname ?? '' };
}

/**
 * Resolve a dotted name given as parts (`['app', 'mood']`, `['mood']`). A three-part name has a
 * leading database name, which Postgres only allows for the current database, so it is dropped.
 */
export function resolveName(parts: string[], defaultSchema: string): QualifiedName {
  const name = parts.at(-1) ?? '';
  const schema = parts.length >= 2 ? (parts.at(-2) ?? defaultSchema) : defaultSchema;
  return { schema, name };
}

/** Resolve a list of `String` nodes, e.g. `CreateEnumStmt.typeName` or `CreateFunctionStmt.funcname`. */
export function resolveNameNodes(nodes: Node[] | undefined, defaultSchema: string): QualifiedName {
  return resolveName(stringValues(nodes), defaultSchema);
}

/**
 * Split `[schema?, table, member]` lists used by `DROP TRIGGER t ON s.tbl` and `DROP POLICY`, where
 * the last element names the trigger or policy and the rest is the table.
 */
export function resolveTableMember(
  parts: string[],
  defaultSchema: string,
): { table: QualifiedName; member: string } {
  return {
    table: resolveName(parts.slice(0, -1), defaultSchema),
    member: parts.at(-1) ?? '',
  };
}
