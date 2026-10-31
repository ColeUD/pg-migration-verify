import { dependsOn, followRename, renamedIdentity, withFields } from '../dependents.js';
import { describeObject, existenceOnly, parentKey, refersToImpliedName } from '../keys.js';
import type { ExpectedObject, ParsedMigration, Rename, Supersession } from '../model.js';
import { quoteIdent, splitSchemaQualifier } from '../sql-ident.js';
import { ATTRIBUTE_LABELS, isAttributeField } from './attributes.js';

/**
 * What a migration's object should look like in today's database, given every later migration.
 * Either an effective expectation to check, or the reason it cannot be checked any more.
 */
export interface ResolvedObject {
  /** The original object with later renames and non-null attribute changes applied. */
  object: ExpectedObject;
  /**
   * One entry per change a later migration made, e.g. `type updated by 0005_x.sql line 3` or
   * `renamed from column public.todos.title by 0006_y.sql line 1`.
   */
  notes: string[];
  supersededBy?: Supersession;
  /**
   * The states the object had before later migrations changed it, newest first: `changedBy` is
   * the migration whose change produced the next state. A database where that migration did not
   * run (yet) holds one of these, and the migration that made the change reports the difference.
   */
  earlier: EarlierState[];
}

export interface EarlierState {
  object: ExpectedObject;
  notes: string[];
  changedBy: string;
}

/**
 * Resolve every object of `migrations[index]` against the migrations after it (which must be in
 * apply order). A migration is only judged on what still holds today: a table dropped two
 * migrations later must not count as missing, a column whose type a later ALTER changed must be
 * checked against the new type, and an index on a column renamed later is checked with the new
 * column name.
 *
 * Earlier migrations matter only for IF NOT EXISTS: when one of them already created the object,
 * Postgres skipped the statement, so it asserts the object's existence and nothing else.
 *
 * For many reports over the same migrations, build one {@link Timeline} and reuse it.
 */
export function resolveObjects(
  migrations: readonly ParsedMigration[],
  index: number,
): ResolvedObject[] {
  return new Timeline(migrations).resolve(index);
}

/**
 * The migrations of a repository in apply order, indexed so that resolving an object only visits
 * the later migrations that can affect it. Every later object that can supersede or change an
 * object shares a token with it (its key, its table's key, a column it uses, a function it calls,
 * a type name, its schema), and migrations with renames are always visited. Resolving a whole
 * repository is then close to linear in the number of objects instead of quadratic.
 */
export class Timeline {
  readonly #migrations: readonly ParsedMigration[];
  readonly #byKey: Map<string, ExpectedObject>[];
  /** token -> indexes of the migrations with a later object carrying it, ascending. */
  readonly #positions = new Map<string, number[]>();
  readonly #withRenames: number[] = [];

  constructor(migrations: readonly ParsedMigration[]) {
    this.#migrations = migrations;
    this.#byKey = migrations.map((m) => new Map(m.objects.map((o) => [o.key, o])));
    migrations.forEach((migration, i) => {
      if (migration.renames.length > 0) this.#withRenames.push(i);
      for (const o of migration.objects) {
        for (const token of laterTokens(o)) {
          const list = this.#positions.get(token);
          if (list === undefined) this.#positions.set(token, [i]);
          else if (list.at(-1) !== i) list.push(i);
        }
      }
    });
  }

  /** See {@link resolveObjects}. */
  resolve(index: number): ResolvedObject[] {
    const end = this.#migrations.length;
    return (this.#migrations[index]?.objects ?? []).map((o) => {
      const existing =
        o.conditional === undefined ? undefined : this.#priorObject(o.conditional, index);
      if (existing === undefined) return this.#resolve(o, index, end);
      if (o.key !== o.conditional) {
        // Declared by a CREATE TABLE or ADD COLUMN IF NOT EXISTS that did nothing.
        const reason = `skipped by IF NOT EXISTS: ${describeObject(existing)} already created by ${at(existing)}`;
        return {
          object: o,
          notes: [],
          supersededBy: supersession(existing, reason, existing.key),
          earlier: [],
        };
      }
      const resolved = this.#resolve(existenceOnly(o), index, end);
      return {
        ...resolved,
        notes: [
          `IF NOT EXISTS: already created by ${at(existing)}, so only its existence is checked`,
          ...resolved.notes,
        ],
      };
    });
  }

  /**
   * Present objects with this key that migrations before `index` declare, as each declared it
   * (not resolved): what the database may hold even if migration `index` never ran.
   */
  definedBefore(key: string, index: number): ExpectedObject[] {
    const positions = this.#positions.get(`k:${key}`) ?? [];
    return positions
      .filter((i) => i < index)
      .map((i) => this.#byKey[i]?.get(key))
      .filter((o): o is ExpectedObject => o?.expect === 'present');
  }

  /**
   * The object with this key as the migrations before `index` leave it, if it still exists after
   * them (as declared by the statement that created it), or undefined.
   */
  #priorObject(key: string, index: number): ExpectedObject | undefined {
    const positions = (this.#positions.get(`k:${key}`) ?? []).filter((i) => i < index);
    for (let p = positions.length - 1; p >= 0; p -= 1) {
      const j = positions[p] ?? 0;
      const found = this.#byKey[j]?.get(key);
      if (found === undefined) continue;
      if (found.expect === 'absent') return undefined;
      if (this.#resolve(found, j, index).supersededBy !== undefined) return undefined;
      // An IF NOT EXISTS re-declaration: the object may have been created further back.
      return found.conditional === undefined ? found : (this.#priorObject(key, j) ?? found);
    }
    return undefined;
  }

  /** `original` (from migration `index`) after the migrations from `index + 1` up to `end`. */
  #resolve(original: ExpectedObject, index: number, end: number): ResolvedObject {
    let object = original;
    let notes: string[] = [];
    const earlier: EarlierState[] = [];
    for (let m = this.#next(object, index + 1, end); m < end; m = this.#next(object, m + 1, end)) {
      const migration = this.#migrations[m];
      if (migration === undefined) break;
      const step = this.#apply(object, migration, this.#byKey[m] ?? new Map());
      if ('supersededBy' in step) {
        return {
          object: step.object,
          notes: [...notes, ...step.notes],
          supersededBy: step.supersededBy,
          earlier,
        };
      }
      // A change the same migration undoes (a column moved to a rebuilt type of the same name)
      // is no change.
      if (step.object !== object && JSON.stringify(step.object) !== JSON.stringify(object)) {
        earlier.unshift({ object, notes, changedBy: migration.file });
        object = step.object;
        notes = [...notes, ...step.notes];
      }
    }
    return { object, notes, earlier };
  }

  /** The first migration from `from` (before `end`) that can affect `o`, or `end`. */
  #next(o: ExpectedObject, from: number, end: number): number {
    let next = firstAtOrAfter(this.#withRenames, from) ?? end;
    for (const token of objectTokens(o)) {
      const position = firstAtOrAfter(this.#positions.get(token), from);
      if (position !== undefined && position < next) next = position;
    }
    return Math.min(next, end);
  }

  /**
   * One later migration's effect on `object`: first its renames (in statement order), then the
   * attributes it asserts about the object (its net objects describe the end of the file), then
   * whether it drops or rebuilds the object or something it depends on.
   */
  #apply(
    original: ExpectedObject,
    migration: ParsedMigration,
    byKey: ReadonlyMap<string, ExpectedObject>,
  ):
    | { object: ExpectedObject; notes: string[] }
    | { object: ExpectedObject; notes: string[]; supersededBy: Supersession } {
    let object = original;
    const notes: string[] = [];
    // Keys the object was renamed into by this migration: a "re-created" object there is this one.
    const renamedInto = new Set<string>();

    for (const rename of migration.renames) {
      if (object.expect === 'present' && isRenamedObject(object, rename.from)) {
        const before = object;
        object = renamedObject(object, rename);
        renamedInto.add(object.key);
        notes.push(`renamed from ${describeObject(before)} by ${at(rename.to)}`);
        continue;
      }
      const followed = followRename(object, rename.from, rename.to, rename.searchSchema);
      if (followed !== object) {
        object = followed;
        notes.push(
          `${describeObject(rename.from)} renamed to ${describeObject(rename.to)} by ${at(rename.to)}`,
        );
      }
    }

    const renamed = { object, notes: [...notes] };
    const later = byKey.get(object.key);
    if (
      later !== undefined &&
      later.expect === 'present' &&
      object.expect === 'present' &&
      later.kind === object.kind &&
      (later.recreated === undefined || renamedInto.has(later.key)) &&
      // IF NOT EXISTS over an object that still exists: Postgres skipped the statement.
      later.conditional === undefined
    ) {
      const merged = mergeAttributes(object, later);
      object = merged.object;
      notes.push(...merged.changed.map((label) => `${label} updated by ${at(later)}`));
    }

    // Whether a drop takes the object along depends on the end state of its attributes (a column
    // moved to a rebuilt type before the old type was dropped stays). A superseded object is
    // shown as it was before this migration's changes to it, which no longer matter.
    const reasserted = later?.expect === 'present';
    for (const candidate of migration.objects) {
      const cause = supersedeCause(object, candidate, reasserted, renamedInto);
      if (cause !== null) {
        return { ...renamed, supersededBy: supersession(candidate, cause, candidate.key) };
      }
    }
    return { object, notes };
  }
}

/**
 * Why `later` makes `o` impossible to check against its own migration, or null. `reasserted`
 * says whether `later`'s migration declares `o` again itself (after a rebuild, say).
 */
function supersedeCause(
  o: ExpectedObject,
  later: ExpectedObject,
  reasserted: boolean,
  renamedInto: ReadonlySet<string>,
): string | null {
  if (later.expect === 'absent') {
    if (later.key === o.key || refersToImpliedName(o, later) || dropsEveryOverload(later, o)) {
      return `dropped by ${at(later)}`;
    }
    // Postgres drops dependents with the object: columns and indexes with their table, indexes
    // and constraints with their column, triggers with their function, the contents of a schema
    // dropped with CASCADE.
    if (dependsOn(o, later) || (later.kind === 'schema' && isInSchema(o, later.name))) {
      return `${describeObject(later)} dropped by ${at(later)}`;
    }
    return null;
  }
  // Dropped (or renamed away) and created again in one file: a table rebuild, or an enum rebuilt
  // to remove a value. What the new definition leaves out is gone; what it repeats, it checks.
  if (later.recreated !== undefined && !renamedInto.has(later.key)) {
    if (later.key === o.key && o.expect === 'present') {
      return `dropped and re-created by ${at(later)}`;
    }
    if (
      later.key === parentKey(o) ||
      (later.kind === 'schema' && isInSchema(o, later.name)) ||
      // Other dependents went with the drop, unless the file declares them again afterwards
      // (a column moved over to the rebuilt type).
      (!reasserted && dependsOn(o, later))
    ) {
      return `${describeObject(later)} dropped and re-created by ${at(later)}`;
    }
  }
  if (later.key !== o.key) return null;
  if (o.expect === 'absent') return `re-created by ${at(later)}`;
  // Tables, views, sequences and indexes share one namespace: a view may replace a table.
  if (later.kind !== o.kind) return `replaced by ${describeObject(later)} in ${at(later)}`;
  return null;
}

/** `DROP FUNCTION f` without an argument list drops the only overload, whichever it is. */
function dropsEveryOverload(later: ExpectedObject, o: ExpectedObject): boolean {
  return (
    later.kind === 'function' &&
    later.argTypes === null &&
    o.kind === 'function' &&
    later.schema === o.schema &&
    later.name === o.name
  );
}

/** Whether dropping schema `schema` (with CASCADE) removes `o`. Extensions are database-wide. */
function isInSchema(o: ExpectedObject, schema: string): boolean {
  return o.kind !== 'extension' && o.kind !== 'schema' && o.schema === schema;
}

/** Whether a rename's old identity is `o` itself. */
function isRenamedObject(o: ExpectedObject, from: ExpectedObject): boolean {
  if (o.key === from.key || refersToImpliedName(o, from)) return true;
  // ALTER FUNCTION f RENAME without an argument list: the only overload.
  return dropsEveryOverload(from, o);
}

/** `o` under the new identity a rename gave it, keeping every attribute it had. */
function renamedObject(o: ExpectedObject, rename: Rename): ExpectedObject {
  const renamed = withFields(o, renamedIdentity(rename.from, rename.to));
  // A generated name only identifies an unnamed object; after the rename it has a real one.
  if ((renamed.kind === 'index' || renamed.kind === 'constraint') && renamed.name !== null) {
    const copy = { ...renamed };
    delete copy.impliedName;
    return copy;
  }
  return renamed;
}

/**
 * Overlay the attributes `later` asserts (non-null) on `current`. Identity fields are equal by
 * construction (same key) and are left alone. Returns the labels of attributes whose value
 * changed, and `current` itself when nothing did.
 */
function mergeAttributes(
  current: ExpectedObject,
  later: ExpectedObject,
): { object: ExpectedObject; changed: string[] } {
  const merged: Record<string, unknown> = { ...current };
  const changed: string[] = [];
  let anyChange = false;
  for (const [field, value] of Object.entries(later)) {
    if (value === null || value === undefined || UNMERGED_FIELDS.has(field)) continue;
    if (JSON.stringify(value) === JSON.stringify(merged[field])) continue;
    merged[field] = value;
    anyChange = true;
    // Display-only fields (policy expressions) follow along silently.
    if (isAttributeField(field)) changed.push(ATTRIBUTE_LABELS[field]);
  }
  // Same key and kind as `current`, with only attribute values replaced: still the same variant.
  return { object: anyChange ? (merged as unknown as ExpectedObject) : current, changed };
}

/**
 * Fields a later migration never changes: identity, and markers that describe the statement that
 * created the object (Postgres chooses a generated name once, at creation).
 */
const UNMERGED_FIELDS: ReadonlySet<string> = new Set([
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
  'impliedName',
  'recreated',
  'conditional',
]);

/**
 * Tokens under which a later object is found by the objects it can affect. Anything can be
 * altered or replaced through its key; only drops and rebuilds affect other objects.
 */
function laterTokens(o: ExpectedObject): string[] {
  const tokens = [`k:${o.key}`];
  if (o.expect === 'present' && o.recreated === undefined) return tokens;
  tokens.push(`p:${o.key}`);
  switch (o.kind) {
    case 'schema':
      tokens.push(`s:${o.name}`);
      break;
    case 'column':
      tokens.push(`c:${o.schema}.${o.table}.${o.name}`);
      break;
    case 'function':
      tokens.push(`f:${o.name}`);
      break;
    case 'type':
      tokens.push(`t:${quoteIdent(o.name)}`);
      break;
    case 'index':
    case 'constraint':
      // Dropped by the name Postgres generated for an unnamed one.
      if (o.name !== null) tokens.push(`n:${o.schema}.${o.name}`);
      break;
    default:
      break;
  }
  return tokens;
}

/** Tokens of everything that can supersede or change `o` (see {@link laterTokens}). */
function objectTokens(o: ExpectedObject): string[] {
  const tokens = [`k:${o.key}`, `s:${o.schema}`];
  const parent = parentKey(o);
  if (parent !== null) tokens.push(`p:${parent}`);
  switch (o.kind) {
    case 'index':
    case 'constraint':
      for (const c of o.columns ?? []) tokens.push(`c:${o.schema}.${o.table}.${c}`);
      if (o.impliedName !== undefined) tokens.push(`n:${o.schema}.${o.impliedName}`);
      if (o.kind === 'constraint' && o.references !== null) {
        const ref = o.references;
        tokens.push(`p:relation:${ref.schema}.${ref.table}`);
        for (const c of ref.columns ?? []) tokens.push(`c:${ref.schema}.${ref.table}.${c}`);
      }
      break;
    case 'trigger':
      if (o.function !== null) tokens.push(`f:${o.function.name}`);
      break;
    case 'function':
      tokens.push(`f:${o.name}`);
      break;
    case 'column':
      if (o.dataType !== null) {
        tokens.push(`t:${splitSchemaQualifier(o.dataType.replace(/(\[\d*\])+$/, '')).rest}`);
      }
      break;
    default:
      break;
  }
  return tokens;
}

/** The first value in an ascending list that is `from` or more (binary search). */
function firstAtOrAfter(list: readonly number[] | undefined, from: number): number | undefined {
  if (list === undefined) return undefined;
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if ((list[mid] ?? 0) < from) low = mid + 1;
    else high = mid;
  }
  return list[low];
}

function supersession(by: ExpectedObject, reason: string, byKey: string): Supersession {
  return { file: by.source.file, line: by.source.line, reason, byKey };
}

function at(o: ExpectedObject): string {
  return `${o.source.file} line ${o.source.line}`;
}
