/**
 * RENAME and SET SCHEMA. Both become a pair of stubs (old identity absent, new identity present);
 * the net-effect merge carries over what the file knew about the old object and moves its
 * dependents (a renamed table keeps its columns, a renamed type keeps its enum values).
 */
import type { AlterObjectSchemaStmt, Node, ObjectType, RangeVar, RenameStmt } from 'libpg-query';
import type { Expectation, ExpectedObject, SourceRef } from '../../model.js';
import { stringValue, stringValues } from '../ast.js';
import {
  noteEffect,
  objectEffect,
  renameEffect,
  type Effect,
  type HandlerContext,
} from '../effects.js';
import { relationName, resolveName, type QualifiedName } from '../names.js';
import {
  columnObject,
  constraintStub,
  extensionObject,
  functionObject,
  indexStub,
  policyStub,
  RELATION_OBJECT_TYPES,
  relationObject,
  schemaObject,
  triggerStub,
  typeObject,
} from '../objects.js';
import { referencedFunction } from './functions.js';

/** A renamed or moved object: its current name, and how to build its stub under any name. */
interface Target {
  name: QualifiedName;
  stub: (name: QualifiedName, expect: Expectation) => ExpectedObject;
}

export function handleRenameStmt(node: RenameStmt, ctx: HandlerContext): Effect[] {
  const renameType = node.renameType ?? 'OBJECT_TABLE';
  const oldName = node.subname ?? '';
  const newName = node.newname ?? '';

  // Objects that belong to a table are renamed within it (ALTER TABLE t RENAME COLUMN a TO b).
  const member = memberStub(renameType, relationName(node.relation, ctx.schema), ctx.source);
  if (member !== undefined) {
    return [renameEffect(member(oldName, 'absent'), member(newName, 'present'), ctx)];
  }
  if (renameType === 'OBJECT_SCHEMA') {
    return [
      renameEffect(
        schemaObject(oldName, 'absent', ctx.source),
        schemaObject(newName, 'present', ctx.source),
        ctx,
      ),
    ];
  }
  const target = targetOf(renameType, node.relation, node.object, ctx);
  if (target === undefined) {
    return [
      noteEffect(ctx, 'unverifiable', `renaming ${objectTypeName(renameType)} is not checked`),
    ];
  }
  return [
    renameEffect(
      target.stub(target.name, 'absent'),
      target.stub({ ...target.name, name: newName }, 'present'),
      ctx,
    ),
  ];
}

/** ALTER ... SET SCHEMA: the same object under another schema. */
export function handleAlterObjectSchema(
  node: AlterObjectSchemaStmt,
  ctx: HandlerContext,
): Effect[] {
  const objectType = node.objectType ?? 'OBJECT_TABLE';
  const newSchema = node.newschema ?? '';
  if (objectType === 'OBJECT_EXTENSION') {
    // An extension is identified by its name alone, so moving it only changes an attribute.
    const name = stringValue(node.object) ?? '';
    return [objectEffect(extensionObject(name, newSchema, 'present', ctx.source))];
  }
  const target = targetOf(objectType, node.relation, node.object, ctx);
  if (target === undefined) {
    return [noteEffect(ctx, 'unverifiable', `moving ${objectTypeName(objectType)} is not checked`)];
  }
  return [
    renameEffect(
      target.stub(target.name, 'absent'),
      target.stub({ ...target.name, schema: newSchema }, 'present'),
      ctx,
    ),
  ];
}

/** Columns, constraints, triggers and policies: renamed within their table. */
function memberStub(
  renameType: ObjectType,
  table: QualifiedName,
  source: SourceRef,
): ((name: string, expect: Expectation) => ExpectedObject) | undefined {
  switch (renameType) {
    case 'OBJECT_COLUMN':
      return (name, expect) =>
        columnObject(table, name, expect, { dataType: null, notNull: null }, source);
    case 'OBJECT_TABCONSTRAINT':
      return (name, expect) => constraintStub(table, name, expect, source);
    case 'OBJECT_TRIGGER':
      return (name, expect) => triggerStub(table, name, expect, source);
    case 'OBJECT_POLICY':
      return (name, expect) => policyStub(table, name, expect, source);
    default:
      return undefined;
  }
}

/**
 * Relations are named by a RangeVar (tables, views, sequences, indexes); types, domains and
 * functions by a name list or a signature.
 */
function targetOf(
  objectType: ObjectType,
  relation: RangeVar | undefined,
  object: Node | undefined,
  ctx: HandlerContext,
): Target | undefined {
  const source = ctx.source;
  if (relation !== undefined) {
    const name = relationName(relation, ctx.schema);
    if (objectType === 'OBJECT_INDEX') {
      // The statement does not name the index's table; the merge knows it if this file created it.
      return { name, stub: (n, expect) => indexStub(n, '', expect, source) };
    }
    const kind = RELATION_OBJECT_TYPES[objectType];
    return kind === undefined
      ? undefined
      : { name, stub: (n, expect) => relationObject(kind, n, expect, source) };
  }
  if (object === undefined) return undefined;

  switch (objectType) {
    case 'OBJECT_TYPE':
    case 'OBJECT_DOMAIN': {
      const parts = 'List' in object ? stringValues(object.List.items) : [];
      const kind = objectType === 'OBJECT_DOMAIN' ? 'domain' : null;
      return {
        name: resolveName(parts, ctx.schema),
        stub: (n, expect) => typeObject(n, kind, expect, source),
      };
    }
    case 'OBJECT_FUNCTION':
    case 'OBJECT_PROCEDURE': {
      if (!('ObjectWithArgs' in object)) return undefined;
      const ref = referencedFunction(object.ObjectWithArgs, ctx.schema);
      const isProcedure = objectType === 'OBJECT_PROCEDURE';
      return {
        name: ref.name,
        stub: (n, expect) => functionObject(n, ref.argTypes, isProcedure, expect, source),
      };
    }
    default:
      return undefined;
  }
}

/** `OBJECT_FOREIGN_TABLE` -> `foreign table`, for notes. */
function objectTypeName(objectType: ObjectType): string {
  return objectType.replace('OBJECT_', '').replaceAll('_', ' ').toLowerCase();
}
