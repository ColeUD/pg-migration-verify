/**
 * Builders for expected objects that are shared between handlers. Objects built from a DROP or a
 * RENAME are "stubs": identity only, every attribute null (= not asserted). The merge fills in what
 * the same file said earlier, e.g. a renamed column keeps the type it was created with.
 */
import type {
  ColumnObject,
  ConstraintObject,
  EnumValueObject,
  Expectation,
  ExtensionObject,
  FunctionObject,
  IndexObject,
  PolicyObject,
  RelationObject,
  SchemaObject,
  SourceRef,
  TriggerObject,
  TypeKind,
  TypeObject,
} from '../model.js';
import type { ObjectType } from 'libpg-query';
import { keyed } from './effects.js';
import type { QualifiedName } from './names.js';

/** Statement object types (DROP TABLE, ALTER VIEW ... RENAME) that map to a relation kind. */
export const RELATION_OBJECT_TYPES: Partial<Record<ObjectType, RelationObject['kind']>> = {
  OBJECT_TABLE: 'table',
  OBJECT_VIEW: 'view',
  OBJECT_MATVIEW: 'materialized_view',
  OBJECT_SEQUENCE: 'sequence',
};

export function relationObject(
  kind: RelationObject['kind'],
  name: QualifiedName,
  expect: Expectation,
  source: SourceRef,
): RelationObject {
  return keyed<RelationObject>({ kind, expect, schema: name.schema, name: name.name, source });
}

export function columnObject(
  table: QualifiedName,
  name: string,
  expect: Expectation,
  attributes: Pick<ColumnObject, 'dataType' | 'notNull'>,
  source: SourceRef,
): ColumnObject {
  return keyed<ColumnObject>({
    kind: 'column',
    expect,
    schema: table.schema,
    table: table.name,
    name,
    ...attributes,
    source,
  });
}

/** `table` is '' when the statement does not say (DROP INDEX, ALTER INDEX ... RENAME). */
export function indexStub(
  name: QualifiedName,
  table: string,
  expect: Expectation,
  source: SourceRef,
): IndexObject {
  return keyed<IndexObject>({
    kind: 'index',
    expect,
    schema: name.schema,
    table,
    name: name.name,
    unique: null,
    method: null,
    columns: null,
    source,
  });
}

export function constraintStub(
  table: QualifiedName,
  name: string,
  expect: Expectation,
  source: SourceRef,
): ConstraintObject {
  return keyed<ConstraintObject>({
    kind: 'constraint',
    expect,
    schema: table.schema,
    table: table.name,
    name,
    constraintType: null,
    columns: null,
    references: null,
    source,
  });
}

export function triggerStub(
  table: QualifiedName,
  name: string,
  expect: Expectation,
  source: SourceRef,
): TriggerObject {
  return keyed<TriggerObject>({
    kind: 'trigger',
    expect,
    schema: table.schema,
    table: table.name,
    name,
    timing: null,
    events: null,
    forEachRow: null,
    function: null,
    source,
  });
}

export function policyStub(
  table: QualifiedName,
  name: string,
  expect: Expectation,
  source: SourceRef,
): PolicyObject {
  return keyed<PolicyObject>({
    kind: 'policy',
    expect,
    schema: table.schema,
    table: table.name,
    name,
    command: null,
    permissive: null,
    roles: null,
    using: null,
    withCheck: null,
    source,
  });
}

export function typeObject(
  name: QualifiedName,
  typeKind: TypeKind | null,
  expect: Expectation,
  source: SourceRef,
): TypeObject {
  return keyed<TypeObject>({
    kind: 'type',
    expect,
    schema: name.schema,
    name: name.name,
    typeKind,
    source,
  });
}

export function enumValueObject(
  type: QualifiedName,
  value: string,
  expect: Expectation,
  source: SourceRef,
): EnumValueObject {
  return keyed<EnumValueObject>({
    kind: 'enum_value',
    expect,
    schema: type.schema,
    typeName: type.name,
    value,
    source,
  });
}

export function functionObject(
  name: QualifiedName,
  argTypes: string[] | null,
  isProcedure: boolean,
  expect: Expectation,
  source: SourceRef,
): FunctionObject {
  return keyed<FunctionObject>({
    kind: 'function',
    expect,
    schema: name.schema,
    name: name.name,
    argTypes,
    isProcedure,
    source,
  });
}

/** A schema object's `schema` is its own name. */
export function schemaObject(name: string, expect: Expectation, source: SourceRef): SchemaObject {
  return keyed<SchemaObject>({ kind: 'schema', expect, schema: name, name, source });
}

export function extensionObject(
  name: string,
  schema: string,
  expect: Expectation,
  source: SourceRef,
): ExtensionObject {
  return keyed<ExtensionObject>({ kind: 'extension', expect, schema, name, source });
}
