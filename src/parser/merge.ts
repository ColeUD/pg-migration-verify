/**
 * Net effect of a migration file. Statements are applied in order to a key -> object map, so the
 * result says what the file leaves behind, not what each statement did along the way:
 * `CREATE TABLE` followed by `ALTER COLUMN ... SET NOT NULL` is one column with both its type and
 * NOT NULL; `CREATE` followed by `DROP` is one absent object.
 *
 * Insertion order is preserved (a `Map` keeps the first position of a key when it is overwritten),
 * so reports list objects in the order the migration introduced them.
 */
import { dependsOn, followRename, RELATION_KINDS, withFields } from '../dependents.js';
import type { ExpectedObject, FunctionObject, IndexObject, Rename, SourceRef } from '../model.js';
import { existenceOnly, refersToImpliedName } from '../keys.js';
import { keyed } from './effects.js';

/** Kinds that share the `relation:` key namespace with tables (pg_class). */
const RELATION_NAMESPACE_KINDS: ReadonlySet<ExpectedObject['kind']> = new Set([
  ...RELATION_KINDS,
  'index',
]);

export class NetEffect {
  #objects = new Map<string, ExpectedObject>();
  readonly #renames: Rename[] = [];

  /** The net expectations, one per key, in first-seen order. */
  get objects(): ExpectedObject[] {
    return [...this.#objects.values()];
  }

  /** Renames of objects this file did not (re-)create, in statement order. */
  get renames(): Rename[] {
    return [...this.#renames];
  }

  /**
   * Apply a created, altered or dropped object.
   * - present over present: field-wise merge, newer non-null attributes win, source stays the
   *   statement that created the object;
   * - absent over anything: the object is replaced, and everything this file said about objects
   *   that depend on it (columns, indexes, policies, enum values, ...) is removed with it;
   * - present over absent: re-created, replaces the absent entry and remembers the drop in
   *   `recreated`, so the timeline knows that earlier versions of the object are gone;
   * - IF NOT EXISTS over an object this file already created: nothing (see `#ifNotExists`).
   *
   * `cascade` matters only for `DROP SCHEMA ... CASCADE`, which also removes the schema's contents;
   * other dependents (see `dependsOn`) go with a drop either way, since it fails while they exist.
   */
  add(added: ExpectedObject, cascade = false): void {
    if (added.expect === 'absent') {
      this.#addAbsent(added, cascade);
      return;
    }
    const object = this.#ifNotExists(added);
    if (object === undefined) return;
    if (object.kind === 'function') this.#forgetUnqualifiedDrop(object.schema, object.name);
    const existing = this.#objects.get(object.key);
    let next = object;
    if (existing?.expect === 'present' && existing.kind === object.kind) {
      next = mergePresent(existing, object);
    } else if (existing?.expect === 'absent') {
      next = { ...object, recreated: existing.source };
    }
    this.#objects.set(object.key, next);
  }

  /**
   * Apply a rename or SET SCHEMA: `from` becomes absent and `to` present. When `from` was created
   * earlier in this file, `to` carries its known attributes (a renamed column keeps its type) and
   * the objects that belong to it follow it (a renamed table keeps its columns and policies).
   *
   * Columns of a renamed type and triggers calling a renamed function follow as well, because
   * Postgres refers to both by OID. `unqualifiedSchema` is where unqualified names resolve at
   * this point of the file; a bare type or function name is taken to mean that schema.
   *
   * Unless this file re-created the object first, the rename is also recorded in `renames`, so
   * that the timeline can apply it to earlier migrations' objects.
   *
   * Returns false when the new object cannot be described, which only happens for a function
   * renamed without an argument list that this file did not create.
   */
  rename(from: ExpectedObject, to: ExpectedObject, unqualifiedSchema: string): boolean {
    const known = this.#findKnown(from);
    const gone = known === undefined ? from : absentVersionOf(from, known);
    const renamed = withoutMarkers(
      known === undefined ? to : keyed({ ...known, ...changedFields(from, to), source: to.source }),
    );
    // A re-created object is not the one earlier migrations created; theirs was dropped.
    if (known?.recreated === undefined) {
      this.#renames.push({ from: gone, to: renamed, searchSchema: unqualifiedSchema });
    }

    // An unnamed index or constraint renamed by its generated name was keyed by its shape.
    if (known !== undefined && known.key !== gone.key) this.#objects.delete(known.key);
    this.#objects.set(gone.key, gone);
    if (renamed.kind === 'function' && renamed.argTypes === null) return false;
    // Renamed onto a name this file dropped earlier: re-created under that name.
    const previous = this.#objects.get(renamed.key);
    const target =
      previous?.expect === 'absent' ? { ...renamed, recreated: previous.source } : renamed;
    this.#objects.set(target.key, target);
    this.#followRename(gone, target, unqualifiedSchema);
    return true;
  }

  /**
   * IF NOT EXISTS: `object.conditional` names the object whose existence makes the statement do
   * nothing. Returns what to apply, or undefined when an earlier statement of this file created
   * that object, so the statement did nothing. When an earlier statement dropped it (or this very
   * statement certainly created it), the statement certainly ran and the object is no longer
   * conditional. Otherwise it stays conditional: whether it ran depends on earlier migrations,
   * which only the timeline sees.
   */
  #ifNotExists(object: ExpectedObject): ExpectedObject | undefined {
    if (object.conditional === undefined) return object;
    const guard = this.#objects.get(object.conditional);
    const existing = this.#objects.get(object.key);
    const createdEarlier = (o: ExpectedObject | undefined): boolean =>
      o?.expect === 'present' && !sameStatement(o.source, object.source);
    // The object itself existing proves that its table existed too (CREATE TABLE IF NOT EXISTS).
    if (createdEarlier(guard) || createdEarlier(existing)) return undefined;
    if (guard === undefined) return object;
    return guard.expect === 'absent' || guard.conditional === undefined
      ? withoutConditional(object)
      : object;
  }

  #addAbsent(object: ExpectedObject, cascade: boolean): void {
    let existing = this.#objects.get(object.key);
    if (existing === undefined) {
      // Dropped by the name Postgres generated for an unnamed index or constraint of this file.
      existing = this.#findByImpliedName(object);
      if (existing !== undefined) this.#objects.delete(existing.key);
    }
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
    const existing = this.#objects.get(from.key) ?? this.#findByImpliedName(from);
    if (existing?.expect !== 'present') return undefined;
    if (existing.kind === from.kind) return existing;
    // ALTER TABLE also renames indexes, views and sequences; they share the relation namespace.
    return RELATION_NAMESPACE_KINDS.has(existing.kind) && RELATION_KINDS.has(from.kind)
      ? existing
      : undefined;
  }

  /** The present unnamed index or constraint that `named` refers to by its generated name. */
  #findByImpliedName(named: ExpectedObject): ExpectedObject | undefined {
    for (const o of this.#objects.values()) {
      if (o.expect === 'present' && refersToImpliedName(o, named)) return o;
    }
    return undefined;
  }

  /** Move the objects that belong to a renamed object along with it (see `followRename`). */
  #followRename(gone: ExpectedObject, target: ExpectedObject, unqualifiedSchema: string): void {
    this.#transform((o) => (o === target ? o : followRename(o, gone, target, unqualifiedSchema)));
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

/**
 * Newer non-null attributes win; identity and the original source stay. A definite statement over
 * an IF NOT EXISTS one (`CREATE TABLE IF NOT EXISTS`, then `ALTER COLUMN ... TYPE`) asserts only
 * what it says itself, since the conditional statement may have been skipped.
 */
function mergePresent<T extends ExpectedObject>(older: T, newer: T): T {
  const base =
    older.conditional !== undefined && newer.conditional === undefined
      ? withoutConditional(existenceOnly(older))
      : older;
  const merged: Record<string, unknown> = { ...base };
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

/** Whether two objects come from the same statement (statements in a DO block share an index). */
function sameStatement(a: SourceRef, b: SourceRef): boolean {
  return a.statementIndex === b.statementIndex && a.excerpt === b.excerpt;
}

function withoutConditional<T extends ExpectedObject>(o: T): T {
  const copy: T = { ...o };
  delete copy.conditional;
  return copy;
}

/** A renamed object under its new name: no generated name, not re-created, not conditional. */
function withoutMarkers(o: ExpectedObject): ExpectedObject {
  const copy: ExpectedObject = { ...o };
  delete copy.recreated;
  delete copy.conditional;
  if (copy.kind === 'index' || copy.kind === 'constraint') delete copy.impliedName;
  return copy;
}

/** Whether dropping `dropped` also removes what this file said about `o`. */
function isRemovedWith(o: ExpectedObject, dropped: ExpectedObject, cascade: boolean): boolean {
  if (dependsOn(o, dropped)) return true;
  switch (dropped.kind) {
    case 'function':
      // DROP FUNCTION f without an argument list drops the (single) f of any signature.
      return (
        dropped.argTypes === null &&
        o.kind === 'function' &&
        o.schema === dropped.schema &&
        o.name === dropped.name
      );
    case 'schema':
      return cascade && o.schema === dropped.name;
    default:
      return false;
  }
}
