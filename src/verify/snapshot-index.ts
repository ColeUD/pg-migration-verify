import type { CatalogSnapshot } from '../model.js';

type Row<K extends keyof CatalogSnapshot> = CatalogSnapshot[K] extends readonly (infer T)[]
  ? T
  : never;

export type CatalogRelation = Row<'relations'>;
export type CatalogColumn = Row<'columns'>;
export type CatalogIndex = Row<'indexes'>;
export type CatalogConstraint = Row<'constraints'>;
export type CatalogFunction = Row<'functions'>;
export type CatalogTrigger = Row<'triggers'>;
export type CatalogPolicy = Row<'policies'>;
export type CatalogType = Row<'types'>;

/**
 * Lookup tables over a {@link CatalogSnapshot}. A snapshot is a set of flat arrays (easy to produce
 * from SQL and to write by hand in tests); verifying a long migration history looks objects up
 * thousands of times, so the arrays are indexed once per verification run.
 */
export class SnapshotIndex {
  readonly #covered: ReadonlySet<string>;
  readonly #schemas: ReadonlySet<string>;
  readonly #extensions: ReadonlySet<string>;
  readonly #relations: ReadonlyMap<string, CatalogRelation>;
  readonly #columns: ReadonlyMap<string, CatalogColumn>;
  readonly #indexes: ReadonlyMap<string, CatalogIndex>;
  readonly #indexesByTable: ReadonlyMap<string, CatalogIndex[]>;
  readonly #constraints: ReadonlyMap<string, CatalogConstraint>;
  readonly #constraintsByTable: ReadonlyMap<string, CatalogConstraint[]>;
  readonly #functions: ReadonlyMap<string, CatalogFunction[]>;
  readonly #triggers: ReadonlyMap<string, CatalogTrigger>;
  readonly #policies: ReadonlyMap<string, CatalogPolicy>;
  readonly #types: ReadonlyMap<string, CatalogType>;
  readonly #enumValues: ReadonlySet<string>;

  constructor(snapshot: CatalogSnapshot) {
    this.#covered = new Set(snapshot.coveredSchemas);
    this.#schemas = new Set(snapshot.schemas);
    this.#extensions = new Set(snapshot.extensions.map((e) => e.name));
    this.#relations = indexBy(snapshot.relations, (r) => k(r.schema, r.name));
    this.#columns = indexBy(snapshot.columns, (c) => k(c.schema, c.table, c.name));
    this.#indexes = indexBy(snapshot.indexes, (i) => k(i.schema, i.name));
    this.#indexesByTable = groupBy(snapshot.indexes, (i) => k(i.schema, i.table));
    this.#constraints = indexBy(snapshot.constraints, (c) => k(c.schema, c.table, c.name));
    this.#constraintsByTable = groupBy(snapshot.constraints, (c) => k(c.schema, c.table));
    this.#functions = groupBy(snapshot.functions, (f) => k(f.schema, f.name));
    this.#triggers = indexBy(snapshot.triggers, (t) => k(t.schema, t.table, t.name));
    this.#policies = indexBy(snapshot.policies, (p) => k(p.schema, p.table, p.name));
    this.#types = indexBy(snapshot.types, (t) => k(t.schema, t.name));
    this.#enumValues = new Set(snapshot.enumValues.map((v) => k(v.schema, v.typeName, v.value)));
  }

  /** Whether the snapshot loaded this schema's objects (absence elsewhere proves nothing). */
  covers(schema: string): boolean {
    return this.#covered.has(schema);
  }

  hasSchema(name: string): boolean {
    return this.#schemas.has(name);
  }

  hasExtension(name: string): boolean {
    return this.#extensions.has(name);
  }

  relation(schema: string, name: string): CatalogRelation | undefined {
    return this.#relations.get(k(schema, name));
  }

  column(schema: string, table: string, name: string): CatalogColumn | undefined {
    return this.#columns.get(k(schema, table, name));
  }

  /** Index names are unique per schema, so no table is needed. */
  index(schema: string, name: string): CatalogIndex | undefined {
    return this.#indexes.get(k(schema, name));
  }

  indexesOn(schema: string, table: string): readonly CatalogIndex[] {
    return this.#indexesByTable.get(k(schema, table)) ?? [];
  }

  constraint(schema: string, table: string, name: string): CatalogConstraint | undefined {
    return this.#constraints.get(k(schema, table, name));
  }

  constraintsOn(schema: string, table: string): readonly CatalogConstraint[] {
    return this.#constraintsByTable.get(k(schema, table)) ?? [];
  }

  /** Every overload with this schema and name. */
  functions(schema: string, name: string): readonly CatalogFunction[] {
    return this.#functions.get(k(schema, name)) ?? [];
  }

  trigger(schema: string, table: string, name: string): CatalogTrigger | undefined {
    return this.#triggers.get(k(schema, table, name));
  }

  policy(schema: string, table: string, name: string): CatalogPolicy | undefined {
    return this.#policies.get(k(schema, table, name));
  }

  type(schema: string, name: string): CatalogType | undefined {
    return this.#types.get(k(schema, name));
  }

  hasEnumValue(schema: string, typeName: string, value: string): boolean {
    return this.#enumValues.has(k(schema, typeName, value));
  }
}

/** Composite map key; NUL cannot occur in Postgres identifiers, so keys never collide. */
function k(...parts: string[]): string {
  return parts.join('\u0000');
}

function indexBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T> {
  return new Map(rows.map((row) => [key(row), row]));
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group === undefined) groups.set(id, [row]);
    else group.push(row);
  }
  return groups;
}
