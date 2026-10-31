/**
 * What a DROP or a RENAME does to the objects that depend on the object it targets. Postgres
 * applies these effects itself (a dropped column takes its indexes along, a renamed table keeps
 * its policies, a foreign key follows its renamed target), so the expectations have to follow too.
 *
 * The rules are written once, as pure functions over a single object, and used in two places:
 * `NetEffect` (parser/merge.ts) applies them to the objects of the same file, and the timeline
 * (verify/timeline.ts) to the objects of earlier migrations. Splitting SQL across two migration
 * files must not change what is verified.
 */
import { objectKey, parentKey } from './keys.js';
import type {
  ConstraintObject,
  ExpectedObject,
  FunctionObject,
  RelationObject,
  TypeObject,
} from './model.js';
import { quoteIdent, splitSchemaQualifier } from './sql-ident.js';

export const RELATION_KINDS: ReadonlySet<ExpectedObject['kind']> = new Set([
  'table',
  'view',
  'materialized_view',
  'sequence',
]);

export function isRelation(o: ExpectedObject): o is RelationObject {
  return RELATION_KINDS.has(o.kind);
}

/**
 * Whether dropping `dropped` removes `o` with it. A DROP without CASCADE fails while dependents
 * exist, so once a drop succeeded, its dependents are gone either way and the cascade flag does
 * not matter here. (DROP SCHEMA is the exception: its contents are not "dependents" in this
 * sense, and callers handle it with the flag they know.)
 *
 * Only dependencies the parser can see are followed: views over a dropped table, functions with
 * an argument of a dropped type and the like are not.
 */
export function dependsOn(o: ExpectedObject, dropped: ExpectedObject): boolean {
  if (parentKey(o) === dropped.key) return true;
  switch (dropped.kind) {
    case 'table':
    case 'view':
    case 'materialized_view':
    case 'sequence':
      // A foreign key referencing the dropped table (DROP TABLE ... CASCADE).
      return (
        isForeignKey(o) &&
        o.references.schema === dropped.schema &&
        o.references.table === dropped.name
      );
    case 'column':
      // Indexes and constraints using the column, and foreign keys referencing it.
      return (
        ((o.kind === 'index' || o.kind === 'constraint') &&
          o.schema === dropped.schema &&
          o.table === dropped.table &&
          (o.columns ?? []).includes(dropped.name)) ||
        (isForeignKey(o) &&
          o.references.schema === dropped.schema &&
          o.references.table === dropped.table &&
          (o.references.columns ?? []).includes(dropped.name))
      );
    case 'function':
      return o.kind === 'trigger' && callsFunction(o.function, dropped, null);
    case 'type':
      // Columns of the type (DROP TYPE ... CASCADE), arrays of it included.
      return (
        o.kind === 'column' && o.dataType !== null && denotesType(o.dataType, dropped, o.schema)
      );
    default:
      return false;
  }
}

/**
 * `o` (a different object than the renamed one) after `gone` was renamed to `target`:
 * - relation: its columns, indexes, constraints, triggers, policies and RLS move along, and
 *   foreign keys referencing it point at the new name;
 * - column: index and constraint columns and foreign-key reference columns use the new name;
 * - type: enum values move along, and columns (and function signatures) of the type name it anew;
 * - function: triggers calling it call the new name (trigger functions take no arguments);
 * - schema: everything in it moves along.
 *
 * `unqualifiedSchema` is where unqualified names resolved when the rename ran: a bare type or
 * trigger function name is taken to mean that schema.
 */
export function followRename(
  o: ExpectedObject,
  gone: ExpectedObject,
  target: ExpectedObject,
  unqualifiedSchema: string,
): ExpectedObject {
  if (isRelation(target) && isRelation(gone)) {
    const moved =
      parentKey(o) === gone.key ? withFields(o, { schema: target.schema, table: target.name }) : o;
    return retargetReferences(moved, (ref) =>
      ref.schema === gone.schema && ref.table === gone.name
        ? { ...ref, schema: target.schema, table: target.name }
        : ref,
    );
  }
  if (target.kind === 'type' && gone.kind === 'type') {
    if (o.kind === 'enum_value' && parentKey(o) === gone.key) {
      return withFields(o, { schema: target.schema, typeName: target.name });
    }
    if (o.expect !== 'present') return o;
    const rename = (type: string): string =>
      renamedTypeReference(type, gone, target, unqualifiedSchema);
    if (o.kind === 'column' && o.dataType !== null) {
      const dataType = rename(o.dataType);
      return dataType === o.dataType ? o : { ...o, dataType };
    }
    if (o.kind === 'function' && o.argTypes !== null) {
      // The signature names the type, so the function's key changes with it.
      const argTypes = o.argTypes.map(rename);
      return argTypes.every((t, i) => t === o.argTypes?.[i]) ? o : withFields(o, { argTypes });
    }
    return o;
  }
  if (target.kind === 'function' && gone.kind === 'function') {
    if (o.kind !== 'trigger' || o.expect !== 'present' || o.function === null) return o;
    if (!callsFunction(o.function, gone, unqualifiedSchema)) return o;
    // The reference stays qualified or unqualified, as the trigger wrote it.
    const schema = o.function.schema === null ? null : target.schema;
    return { ...o, function: { schema, name: target.name } };
  }
  if (target.kind === 'schema' && gone.kind === 'schema') {
    const moved =
      o.kind !== 'schema' && o.schema === gone.name ? withFields(o, { schema: target.name }) : o;
    return retargetReferences(moved, (ref) =>
      ref.schema === gone.name ? { ...ref, schema: target.name } : ref,
    );
  }
  if (target.kind === 'column' && gone.kind === 'column') {
    const swap = (columns: string[] | null): string[] | null =>
      columns?.map((c) => (c === gone.name ? target.name : c)) ?? null;
    let moved = o;
    if (
      (o.kind === 'index' || o.kind === 'constraint') &&
      o.schema === gone.schema &&
      o.table === gone.table &&
      (o.columns ?? []).includes(gone.name)
    ) {
      // An unnamed index or constraint is keyed by its columns, so its key changes too.
      moved = withFields(o, { columns: swap(o.columns) });
    }
    return retargetReferences(moved, (ref) =>
      ref.schema === gone.schema && ref.table === gone.table
        ? { ...ref, columns: swap(ref.columns) }
        : ref,
    );
  }
  return o;
}

/**
 * The identity fields a rename changes (name, schema, enum value ...), found by comparing the
 * statement's old and new stubs. Attributes are not identity: the new stub asserts none.
 */
export function renamedIdentity(from: ExpectedObject, to: ExpectedObject): Record<string, unknown> {
  const before = from as unknown as Record<string, unknown>;
  const after = to as unknown as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const field of IDENTITY_FIELDS) {
    if (field in after && JSON.stringify(after[field]) !== JSON.stringify(before[field])) {
      changes[field] = after[field];
    }
  }
  return changes;
}

const IDENTITY_FIELDS = ['schema', 'name', 'table', 'typeName', 'value'] as const;

/**
 * Copy an object with some fields replaced and its key recomputed. Callers only replace fields the
 * object's kind has (checked by the surrounding narrowing); the type system cannot follow that
 * through a spread over the ExpectedObject union, so this is the one untyped update.
 */
export function withFields(o: ExpectedObject, fields: Record<string, unknown>): ExpectedObject {
  const updated: ExpectedObject = { ...o, ...fields };
  return { ...updated, key: objectKey(updated) };
}

type Reference = NonNullable<ConstraintObject['references']>;

/** Apply `fn` to a foreign key's referenced table, if `o` is a foreign key. */
function retargetReferences(o: ExpectedObject, fn: (ref: Reference) => Reference): ExpectedObject {
  if (o.kind !== 'constraint' || o.references === null) return o;
  const references = fn(o.references);
  return references === o.references ? o : { ...o, references };
}

function isForeignKey(
  o: ExpectedObject,
): o is ConstraintObject & { references: NonNullable<ConstraintObject['references']> } {
  return o.kind === 'constraint' && o.references !== null;
}

/**
 * Whether a trigger's function reference names `fn`. Trigger functions take no arguments, so only
 * a signature without arguments (or an unspecified one) can be meant. An unqualified reference
 * resolved through the search path: when that schema is unknown (`unqualifiedSchema` null), the
 * name alone decides.
 */
function callsFunction(
  ref: { schema: string | null; name: string } | null,
  fn: FunctionObject,
  unqualifiedSchema: string | null,
): boolean {
  if (ref === null || ref.name !== fn.name) return false;
  if (fn.argTypes !== null && fn.argTypes.length > 0) return false;
  if (ref.schema !== null) return ref.schema === fn.schema;
  return unqualifiedSchema === null || unqualifiedSchema === fn.schema;
}

/**
 * Whether a column type (`mood`, `public.mood[]`) names `type`. A bare name is taken to mean the
 * type in `unqualifiedSchema`.
 */
function denotesType(dataType: string, type: TypeObject, unqualifiedSchema: string): boolean {
  const { schema, rest } = splitSchemaQualifier(dataType.replace(ARRAY_SUFFIX, ''));
  if (rest !== quoteIdent(type.name)) return false;
  return schema === null ? unqualifiedSchema === type.schema : schema === quoteIdent(type.schema);
}

const ARRAY_SUFFIX = /(\[\d*\])+$/;

/**
 * A column or argument type (`mood`, `public.mood[]`), rewritten to name `target` when it denotes
 * the renamed type `gone`. A bare name denotes `gone` when `gone` lives in the schema unqualified
 * names resolve to; it stays bare, since a bare expected type matches the type in any schema.
 */
function renamedTypeReference(
  type: string,
  gone: TypeObject,
  target: TypeObject,
  unqualifiedSchema: string,
): string {
  const arraySuffix = ARRAY_SUFFIX.exec(type)?.[0] ?? '';
  const { schema, rest } = splitSchemaQualifier(type.slice(0, type.length - arraySuffix.length));
  if (rest !== quoteIdent(gone.name)) return type;
  if (schema === null) {
    return gone.schema === unqualifiedSchema ? `${quoteIdent(target.name)}${arraySuffix}` : type;
  }
  return schema === quoteIdent(gone.schema)
    ? `${quoteIdent(target.schema)}.${quoteIdent(target.name)}${arraySuffix}`
    : type;
}
