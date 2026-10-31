/**
 * Net effect of a migration file. Statements are applied in order to a key -> object map, so the
 * result says what the file leaves behind, not what each statement did along the way:
 * `CREATE TABLE` followed by `ALTER COLUMN ... SET NOT NULL` is one column with both its type and
 * NOT NULL; `CREATE` followed by `DROP` is one absent object.
 *
 * Insertion order is preserved (a `Map` keeps the first position of a key when it is overwritten),
 * so reports list objects in the order the migration introduced them.
 */
import type {
  ConstraintObject,
  EnumValueObject,
  ExpectedObject,
  FunctionObject,
  IndexObject,
  RelationObject,
} from '../model.js';
import { parentKey } from '../keys.js';
import { keyed } from './effects.js';

const RELATION_KINDS: ReadonlySet<ExpectedObject['kind']> = new Set([
  'table',
  'view',
  'materialized_view',
  'sequence',
]);

/** Kinds that share the `relation:` key namespace with tables (pg_class). */
const RELATION_NAMESPACE_KINDS: ReadonlySet<ExpectedObject['kind']> = new Set([
  ...RELATION_KINDS,
  'index',
]);

export class NetEffect {
  #objects = new Map<string, ExpectedObject>();

  /** The net expectations, one per key, in first-seen order. */
  get objects(): ExpectedObject[] {
    return [...this.#objects.values()];
  }

  /**
   * Apply a created, altered or dropped object.
   * - present over present: field-wise merge, newer non-null attributes win, source stays the
   *   statement that created the object;
   * - absent over anything: the object is replaced, and everything this file said about objects
   *   that depend on it (columns, indexes, policies, enum values, ...) is removed with it;
   * - present over absent: re-created, replaces the absent entry.
   *
   * `cascade` matters only for `DROP SCHEMA ... CASCADE`, which also removes the schema's contents.
   */
  add(object: ExpectedObject, cascade = false): void {
    if (object.expect === 'absent') {
      this.#addAbsent(object, cascade);
      return;
    }
    if (object.kind === 'function') this.#forgetUnqualifiedDrop(object.schema, object.name);
    const existing = this.#objects.get(object.key);
    this.#objects.set(
      object.key,
      existing?.expect === 'present' && existing.kind === object.kind
        ? mergePresent(existing, object)
        : object,
    );
  }

  /**
   * Apply a rename or SET SCHEMA: `from` becomes absent and `to` present. When `from` was created
   * earlier in this file, `to` carries its known attributes (a renamed column keeps its type) and
   * the objects that belong to it follow it (a renamed table keeps its columns and policies).
   *
   * Returns false when the new object cannot be described, which only happens for a function
   * renamed without an argument list that this file did not create.
   */
  rename(from: ExpectedObject, to: ExpectedObject): boolean {
    const known = this.#findKnown(from);
    const gone = known === undefined ? from : absentVersionOf(from, known);
    const target =
      known === undefined ? to : keyed({ ...known, ...changedFields(from, to), source: to.source });

    this.#objects.set(gone.key, gone);
    if (target.kind === 'function' && target.argTypes === null) return false;
    this.#objects.set(target.key, target);
    this.#followRename(gone, target);
    return true;
  }

  #addAbsent(object: ExpectedObject, cascade: boolean): void {
    const existing = this.#objects.get(object.key);
    // DROP INDEX does not name the table; keep it when this file created the index.
    const absent =
      object.kind === 'index' && object.table === '' && existing?.kind === 'index'
        ? { ...object, table: existing.table }
        : object;
    this.#objects.set(absent.key, absent);
    this.#deleteWhere((o) => o !== absent && isRemovedWith(o, absent, cascade));
  }

  /** `DROP FUNCTION f` (no argument list) followed by `CREATE FUNCTION f(...)`: the re-create wins. */
  #forgetUnqualifiedDrop(schema: string, name: string): void {
    const key = `function:${schema}.${name}(*)`;
    if (this.#objects.get(key)?.expect === 'absent') this.#objects.delete(key);
  }

  /** The present in-file object a rename refers to, if this file created it. */
  #findKnown(from: ExpectedObject): ExpectedObject | undefined {
    if (from.kind === 'function' && from.argTypes === null) {
      // ALTER FUNCTION f RENAME (no argument list) is only valid when f is not overloaded.
      const candidates = this.objects.filter(
        (o) =>
          o.kind === 'function' &&
          o.expect === 'present' &&
          o.schema === from.schema &&
          o.name === from.name,
      );
      return candidates.length === 1 ? candidates[0] : undefined;
    }
    const existing = this.#objects.get(from.key);
    if (existing?.expect !== 'present') return undefined;
    if (existing.kind === from.kind) return existing;
    // ALTER TABLE also renames indexes, views and sequences; they share the relation namespace.
    return RELATION_NAMESPACE_KINDS.has(existing.kind) && RELATION_KINDS.has(from.kind)
      ? existing
      : undefined;
  }

  /** Move the objects that belong to a renamed object along with it. */
  #followRename(gone: ExpectedObject, target: ExpectedObject): void {
    if (isRelation(target) && isRelation(gone)) {
      const [oldSchema, oldName] = [gone.schema, gone.name];
      this.#transform((o) => {
        let moved = o;
        if (parentKey(o) === gone.key) {
          moved = withFields(o, { schema: target.schema, table: target.name });
        }
        return retargetReferences(moved, (ref) =>
          ref.schema === oldSchema && ref.table === oldName
            ? { ...ref, schema: target.schema, table: target.name }
            : ref,
        );
      });
    } else if (target.kind === 'type' && gone.kind === 'type') {
      this.#transform((o) =>
        o.kind === 'enum_value' && parentKey(o) === gone.key
          ? keyed<EnumValueObject>({ ...o, schema: target.schema, typeName: target.name })
          : o,
      );
    } else if (target.kind === 'schema' && gone.kind === 'schema') {
      this.#transform((o) => {
        const moved =
          o.kind !== 'schema' && o.schema === gone.name
            ? withFields(o, { schema: target.name })
            : o;
        return retargetReferences(moved, (ref) =>
          ref.schema === gone.name ? { ...ref, schema: target.name } : ref,
        );
      });
    } else if (target.kind === 'column' && gone.kind === 'column') {
      this.#renameColumnReferences(gone.schema, gone.table, gone.name, target.name);
    }
  }

  /** Indexes and constraints refer to columns by name; Postgres updates them on RENAME COLUMN. */
  #renameColumnReferences(schema: string, table: string, from: string, to: string): void {
    const swap = (columns: string[] | null): string[] | null =>
      columns?.map((c) => (c === from ? to : c)) ?? null;
    this.#transform((o) => {
      let moved = o;
      if (
        (o.kind === 'index' || o.kind === 'constraint') &&
        o.schema === schema &&
        o.table === table
      ) {
        moved = withFields(o, { columns: swap(o.columns) });
      }
      return retargetReferences(moved, (ref) =>
        ref.schema === schema && ref.table === table ? { ...ref, columns: swap(ref.columns) } : ref,
      );
    });
  }

  #deleteWhere(predicate: (o: ExpectedObject) => boolean): void {
    for (const [key, o] of this.#objects) if (predicate(o)) this.#objects.delete(key);
  }

  /** Replace objects (possibly changing their keys) without changing their order. */
  #transform(fn: (o: ExpectedObject) => ExpectedObject): void {
    const next = new Map<string, ExpectedObject>();
    for (const o of this.#objects.values()) {
      const replaced = fn(o);
      next.set(replaced.key, replaced);
    }
    this.#objects = next;
  }
}

/** Newer non-null attributes win; identity and the original source stay. */
function mergePresent<T extends ExpectedObject>(older: T, newer: T): T {
  const merged: Record<string, unknown> = { ...older };
  for (const [field, value] of Object.entries(newer)) {
    if (field !== 'source' && value !== null) merged[field] = value;
  }
  return merged as T;
}

/** Fields a rename changes (name, schema, enum value ...), found by comparing the two stubs. */
function changedFields(from: ExpectedObject, to: ExpectedObject): Record<string, unknown> {
  const before = from as unknown as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(to)) {
    if (field === 'key' || field === 'source' || field === 'expect') continue;
    if (JSON.stringify(value) !== JSON.stringify(before[field])) changes[field] = value;
  }
  return changes;
}

/** The absent stub for a renamed object, completed with identity details only the file knew. */
function absentVersionOf(from: ExpectedObject, known: ExpectedObject): ExpectedObject {
  if (known.kind === 'index' && from.kind !== 'index') {
    return keyed<IndexObject>({
      kind: 'index',
      expect: 'absent',
      schema: known.schema,
      table: known.table,
      name: known.name,
      unique: null,
      method: null,
      columns: null,
      source: from.source,
    });
  }
  if (known.kind === 'index' && from.kind === 'index') {
    return keyed<IndexObject>({ ...from, table: known.table });
  }
  if (known.kind === 'function' && from.kind === 'function') {
    return keyed<FunctionObject>({ ...from, argTypes: known.argTypes });
  }
  if (from.kind !== known.kind && RELATION_KINDS.has(known.kind) && RELATION_KINDS.has(from.kind)) {
    return withFields(from, { kind: known.kind });
  }
  return from;
}

function isRelation(o: ExpectedObject): o is RelationObject {
  return RELATION_KINDS.has(o.kind);
}

/**
 * Copy an object with some fields replaced and its key recomputed. Callers only replace fields the
 * object's kind has (checked by the surrounding narrowing); the type system cannot follow that
 * through a spread over the ExpectedObject union, so this is the one untyped update.
 */
function withFields(o: ExpectedObject, fields: Record<string, unknown>): ExpectedObject {
  return keyed({ ...o, ...fields });
}

type Reference = NonNullable<ConstraintObject['references']>;

/** Apply `fn` to a foreign key's referenced table, if `o` is a foreign key. */
function retargetReferences(o: ExpectedObject, fn: (ref: Reference) => Reference): ExpectedObject {
  if (o.kind !== 'constraint' || o.references === null) return o;
  const references = fn(o.references);
  return references === o.references ? o : { ...o, references };
}

/** Whether dropping `dropped` also removes what this file said about `o`. */
function isRemovedWith(o: ExpectedObject, dropped: ExpectedObject, cascade: boolean): boolean {
  if (parentKey(o) === dropped.key) return true;
  switch (dropped.kind) {
    case 'function':
      // DROP FUNCTION f without an argument list drops the (single) f of any signature.
      return (
        dropped.argTypes === null &&
        o.kind === 'function' &&
        o.schema === dropped.schema &&
        o.name === dropped.name
      );
    case 'column':
      // Indexes and constraints on a dropped column are dropped automatically.
      return (
        (o.kind === 'index' || o.kind === 'constraint') &&
        o.schema === dropped.schema &&
        o.table === dropped.table &&
        (o.columns ?? []).includes(dropped.name)
      );
    case 'schema':
      return cascade && o.schema === dropped.name;
    default:
      return false;
  }
}
