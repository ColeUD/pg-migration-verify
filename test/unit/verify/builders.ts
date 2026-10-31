/**
 * Typed builders for hand-written expectations and catalog snapshots, so verifier tests do not
 * depend on the SQL parser. Defaults describe the common case (schema `public`, expected present,
 * nothing optional asserted); each builder takes overrides for the fields a test cares about.
 */
import { objectKey } from '../../../src/keys.js';
import type {
  CatalogSnapshot,
  ColumnObject,
  ConstraintObject,
  EnumValueObject,
  Expectation,
  ExpectedObject,
  ExtensionObject,
  FunctionObject,
  IndexObject,
  Note,
  PolicyObject,
  RelationObject,
  RlsObject,
  SchemaObject,
  SourceRef,
  TriggerObject,
  TypeObject,
} from '../../../src/model.js';
import type { MigrationInput } from '../../../src/verify/index.js';

/** Fields every builder accepts. `file` is normally filled in by `migration()`. */
export interface Common {
  schema?: string;
  expect?: Expectation;
  line?: number;
  inDoBlock?: boolean;
}

function source(c: Common): SourceRef {
  return {
    file: 'unset.sql',
    statementIndex: 0,
    line: c.line ?? 1,
    excerpt: '-- synthetic',
    ...(c.inDoBlock === undefined ? {} : { inDoBlock: c.inDoBlock }),
  };
}

function base(c: Common): { schema: string; expect: Expectation; source: SourceRef } {
  return { schema: c.schema ?? 'public', expect: c.expect ?? 'present', source: source(c) };
}

export function schemaObj(name: string, c: Omit<Common, 'schema'> = {}): SchemaObject {
  return {
    ...base({ ...c, schema: name }),
    kind: 'schema',
    name,
    key: objectKey({ kind: 'schema', schema: name }),
  };
}

export function extension(name: string, c: Common = {}): ExtensionObject {
  return { ...base(c), kind: 'extension', name, key: objectKey({ kind: 'extension', name }) };
}

export function relation(
  kind: RelationObject['kind'],
  name: string,
  c: Common = {},
): RelationObject {
  const b = base(c);
  return { ...b, kind, name, key: objectKey({ kind, schema: b.schema, name }) };
}

export function table(name: string, c: Common = {}): RelationObject {
  return relation('table', name, c);
}

export function column(
  tableName: string,
  name: string,
  attrs: Partial<Pick<ColumnObject, 'dataType' | 'notNull'>> & Common = {},
): ColumnObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'column',
    table: tableName,
    name,
    dataType: attrs.dataType ?? null,
    notNull: attrs.notNull ?? null,
    key: objectKey({ kind: 'column', schema: b.schema, table: tableName, name }),
  };
}

export function index(
  tableName: string,
  name: string | null,
  attrs: Partial<Pick<IndexObject, 'unique' | 'method' | 'columns'>> & Common = {},
): IndexObject {
  const b = base(attrs);
  const columns = attrs.columns ?? null;
  return {
    ...b,
    kind: 'index',
    table: tableName,
    name,
    unique: attrs.unique ?? null,
    method: attrs.method ?? null,
    columns,
    key: objectKey({ kind: 'index', schema: b.schema, table: tableName, name, columns }),
  };
}

export function constraint(
  tableName: string,
  name: string | null,
  attrs: Partial<Pick<ConstraintObject, 'constraintType' | 'columns' | 'references'>> & Common = {},
): ConstraintObject {
  const b = base(attrs);
  const constraintType = attrs.constraintType ?? null;
  const columns = attrs.columns ?? null;
  return {
    ...b,
    kind: 'constraint',
    table: tableName,
    name,
    constraintType,
    columns,
    references: attrs.references ?? null,
    key: objectKey({
      kind: 'constraint',
      schema: b.schema,
      table: tableName,
      name,
      constraintType,
      columns,
    }),
  };
}

export function fn(
  name: string,
  argTypes: string[] | null,
  attrs: { isProcedure?: boolean } & Common = {},
): FunctionObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'function',
    name,
    argTypes,
    isProcedure: attrs.isProcedure ?? false,
    key: objectKey({ kind: 'function', schema: b.schema, name, argTypes }),
  };
}

export function trigger(
  tableName: string,
  name: string,
  attrs: Partial<Pick<TriggerObject, 'timing' | 'events' | 'forEachRow' | 'function'>> &
    Common = {},
): TriggerObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'trigger',
    table: tableName,
    name,
    timing: attrs.timing ?? null,
    events: attrs.events ?? null,
    forEachRow: attrs.forEachRow ?? null,
    function: attrs.function ?? null,
    key: objectKey({ kind: 'trigger', schema: b.schema, table: tableName, name }),
  };
}

export function rls(
  tableName: string,
  attrs: Partial<Pick<RlsObject, 'enabled' | 'forced'>> & Common = {},
): RlsObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'rls',
    table: tableName,
    enabled: attrs.enabled ?? null,
    forced: attrs.forced ?? null,
    key: objectKey({ kind: 'rls', schema: b.schema, table: tableName }),
  };
}

export function policy(
  tableName: string,
  name: string,
  attrs: Partial<Pick<PolicyObject, 'command' | 'permissive' | 'roles' | 'using' | 'withCheck'>> &
    Common = {},
): PolicyObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'policy',
    table: tableName,
    name,
    command: attrs.command ?? null,
    permissive: attrs.permissive ?? null,
    roles: attrs.roles ?? null,
    using: attrs.using ?? null,
    withCheck: attrs.withCheck ?? null,
    key: objectKey({ kind: 'policy', schema: b.schema, table: tableName, name }),
  };
}

export function type(
  name: string,
  attrs: Partial<Pick<TypeObject, 'typeKind'>> & Common = {},
): TypeObject {
  const b = base(attrs);
  return {
    ...b,
    kind: 'type',
    name,
    typeKind: attrs.typeKind ?? null,
    key: objectKey({ kind: 'type', schema: b.schema, name }),
  };
}

export function enumValue(typeName: string, value: string, c: Common = {}): EnumValueObject {
  const b = base(c);
  return {
    ...b,
    kind: 'enum_value',
    typeName,
    value,
    key: objectKey({ kind: 'enum_value', schema: b.schema, typeName, value }),
  };
}

export function note(
  statementType: string,
  reason: string,
  attrs: { category?: Note['category'] } & Common = {},
): Note {
  return {
    category: attrs.category ?? 'unverifiable',
    statementType,
    reason,
    source: source(attrs),
  };
}

/**
 * A migration file named `fileName` (e.g. `20240101000000_init.sql`) whose parsed objects and
 * notes are the given ones, with every source re-pointed at this file.
 */
export function migration(
  fileName: string,
  objects: ExpectedObject[],
  notes: Note[] = [],
): MigrationInput {
  const match = /^(\d+)_?(.*)\.sql$/.exec(fileName);
  if (match === null) throw new Error(`bad migration file name ${fileName}`);
  const withFile = <T extends { source: SourceRef }>(x: T): T => ({
    ...x,
    source: { ...x.source, file: fileName },
  });
  return {
    file: {
      version: match[1] ?? '',
      name: match[2] ?? '',
      fileName,
      path: `/repo/supabase/migrations/${fileName}`,
      checksum: '0'.repeat(64),
    },
    parsed: {
      file: fileName,
      objects: objects.map(withFile),
      notes: notes.map(withFile),
      statementCount: objects.length + notes.length,
    },
  };
}

/** A snapshot covering `public` with nothing in it; pass the rows a test needs. */
export function snapshot(rows: Partial<CatalogSnapshot> = {}): CatalogSnapshot {
  return {
    serverVersionNum: 170004,
    coveredSchemas: ['public'],
    schemas: ['public'],
    extensions: [],
    relations: [],
    columns: [],
    indexes: [],
    constraints: [],
    functions: [],
    triggers: [],
    policies: [],
    types: [],
    enumValues: [],
    ...rows,
  };
}

type Rows<K extends keyof CatalogSnapshot> = CatalogSnapshot[K] extends (infer T)[] ? T : never;

/** Catalog row builders with the usual defaults (schema `public`). */
export const cat = {
  table(name: string, attrs: Partial<Rows<'relations'>> = {}): Rows<'relations'> {
    return { schema: 'public', name, kind: 'table', rlsEnabled: false, rlsForced: false, ...attrs };
  },
  column(
    tableName: string,
    name: string,
    dataType: string,
    attrs: Partial<Rows<'columns'>> = {},
  ): Rows<'columns'> {
    return { schema: 'public', table: tableName, name, dataType, notNull: false, ...attrs };
  },
  index(
    tableName: string,
    name: string,
    columns: string[],
    attrs: Partial<Rows<'indexes'>> = {},
  ): Rows<'indexes'> {
    return {
      schema: 'public',
      table: tableName,
      name,
      unique: false,
      primary: false,
      method: 'btree',
      columns,
      ...attrs,
    };
  },
  constraint(
    tableName: string,
    name: string,
    type: Rows<'constraints'>['type'],
    columns: string[],
    attrs: Partial<Rows<'constraints'>> = {},
  ): Rows<'constraints'> {
    return { schema: 'public', table: tableName, name, type, columns, references: null, ...attrs };
  },
  fn(name: string, argTypes: string[], attrs: Partial<Rows<'functions'>> = {}): Rows<'functions'> {
    return { schema: 'public', name, argTypes, isProcedure: false, ...attrs };
  },
  trigger(
    tableName: string,
    name: string,
    attrs: Partial<Rows<'triggers'>> = {},
  ): Rows<'triggers'> {
    return {
      schema: 'public',
      table: tableName,
      name,
      timing: 'BEFORE',
      events: ['UPDATE'],
      forEachRow: true,
      function: { schema: 'public', name: 'set_updated_at' },
      ...attrs,
    };
  },
  policy(tableName: string, name: string, attrs: Partial<Rows<'policies'>> = {}): Rows<'policies'> {
    return {
      schema: 'public',
      table: tableName,
      name,
      command: 'ALL',
      permissive: true,
      roles: ['public'],
      ...attrs,
    };
  },
  type(name: string, attrs: Partial<Rows<'types'>> = {}): Rows<'types'> {
    return { schema: 'public', name, typeKind: 'enum', ...attrs };
  },
};
