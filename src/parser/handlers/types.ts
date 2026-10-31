/** User-defined types: enums (and their values), composite, domain, range and base/shell types. */
import type {
  AlterEnumStmt,
  CompositeTypeStmt,
  CreateDomainStmt,
  CreateEnumStmt,
  CreateRangeStmt,
  DefineStmt,
} from 'libpg-query';
import { stringValues } from '../ast.js';
import {
  noteEffect,
  objectEffect,
  renameEffect,
  type Effect,
  type HandlerContext,
} from '../effects.js';
import { relationName, resolveNameNodes } from '../names.js';
import { enumValueObject, typeObject } from '../objects.js';

export function handleCreateEnum(node: CreateEnumStmt, ctx: HandlerContext): Effect[] {
  const name = resolveNameNodes(node.typeName, ctx.schema);
  return [
    objectEffect(typeObject(name, 'enum', 'present', ctx.source)),
    ...stringValues(node.vals).map((value) =>
      objectEffect(enumValueObject(name, value, 'present', ctx.source)),
    ),
  ];
}

/** ALTER TYPE ... ADD VALUE [IF NOT EXISTS] [BEFORE|AFTER], or RENAME VALUE. */
export function handleAlterEnum(node: AlterEnumStmt, ctx: HandlerContext): Effect[] {
  const name = resolveNameNodes(node.typeName, ctx.schema);
  const newValue = node.newVal ?? '';
  if (node.oldVal !== undefined) {
    return [
      renameEffect(
        enumValueObject(name, node.oldVal, 'absent', ctx.source),
        enumValueObject(name, newValue, 'present', ctx.source),
        ctx,
      ),
    ];
  }
  return [objectEffect(enumValueObject(name, newValue, 'present', ctx.source))];
}

export function handleCompositeType(node: CompositeTypeStmt, ctx: HandlerContext): Effect[] {
  return [
    objectEffect(
      typeObject(relationName(node.typevar, ctx.schema), 'composite', 'present', ctx.source),
    ),
  ];
}

export function handleCreateDomain(node: CreateDomainStmt, ctx: HandlerContext): Effect[] {
  return [
    objectEffect(
      typeObject(resolveNameNodes(node.domainname, ctx.schema), 'domain', 'present', ctx.source),
    ),
  ];
}

export function handleCreateRange(node: CreateRangeStmt, ctx: HandlerContext): Effect[] {
  return [
    objectEffect(
      typeObject(resolveNameNodes(node.typeName, ctx.schema), 'range', 'present', ctx.source),
    ),
  ];
}

/**
 * DefineStmt covers CREATE TYPE (base or shell type), AGGREGATE, OPERATOR, COLLATION and text
 * search objects. Only types are checked; the type's kind is not asserted since a shell type is
 * usually completed later.
 */
export function handleDefineStmt(node: DefineStmt, ctx: HandlerContext): Effect[] {
  if (node.kind !== 'OBJECT_TYPE') {
    const what = (node.kind ?? 'OBJECT_UNKNOWN').replace('OBJECT_', '').replaceAll('_', ' ');
    return [noteEffect(ctx, 'unverifiable', `CREATE ${what} is not supported yet`)];
  }
  return [
    objectEffect(
      typeObject(resolveNameNodes(node.defnames, ctx.schema), null, 'present', ctx.source),
    ),
  ];
}
