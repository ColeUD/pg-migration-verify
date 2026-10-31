/**
 * DROP statements become `absent` expectations. IF EXISTS changes nothing: either way the object
 * must not exist afterwards. Dependent objects (a dropped table's columns and policies) are
 * handled by the net-effect merge, not here.
 */
import type { DropStmt, Node, ObjectType } from 'libpg-query';
import type { ExpectedObject } from '../../model.js';
import { stringValue, stringValues } from '../ast.js';
import { noteEffect, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { resolveName, resolveTableMember } from '../names.js';
import {
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

export function handleDropStmt(node: DropStmt, ctx: HandlerContext): Effect[] {
  const removeType = node.removeType ?? 'OBJECT_TABLE';
  const cascade = node.behavior === 'DROP_CASCADE';
  const absent = (node.objects ?? []).map((o) => dropped(removeType, o, ctx));
  if (absent.every((o): o is ExpectedObject => o !== null)) {
    return absent.map((object) => objectEffect(object, cascade));
  }
  const what = removeType.replace('OBJECT_', '').replaceAll('_', ' ');
  return [noteEffect(ctx, 'unverifiable', `DROP ${what} is not checked`)];
}

/** The absent expectation for one dropped name, or null for object types that are not checked. */
function dropped(removeType: ObjectType, object: Node, ctx: HandlerContext): ExpectedObject | null {
  const parts = 'List' in object ? stringValues(object.List.items) : [];
  const relationKind = RELATION_OBJECT_TYPES[removeType];
  if (relationKind !== undefined) {
    return relationObject(relationKind, resolveName(parts, ctx.schema), 'absent', ctx.source);
  }

  switch (removeType) {
    case 'OBJECT_INDEX':
      // DROP INDEX does not say which table; the merge fills it in when this file created it.
      return indexStub(resolveName(parts, ctx.schema), '', 'absent', ctx.source);
    case 'OBJECT_TYPE':
    case 'OBJECT_DOMAIN': {
      const names = 'TypeName' in object ? stringValues(object.TypeName.names) : [];
      const kind = removeType === 'OBJECT_DOMAIN' ? 'domain' : null;
      return typeObject(resolveName(names, ctx.schema), kind, 'absent', ctx.source);
    }
    case 'OBJECT_FUNCTION':
    case 'OBJECT_PROCEDURE': {
      if (!('ObjectWithArgs' in object)) return null;
      const ref = referencedFunction(object.ObjectWithArgs, ctx.schema);
      const isProcedure = removeType === 'OBJECT_PROCEDURE';
      return functionObject(ref.name, ref.argTypes, isProcedure, 'absent', ctx.source);
    }
    case 'OBJECT_TRIGGER': {
      const { table, member } = resolveTableMember(parts, ctx.schema);
      return triggerStub(table, member, 'absent', ctx.source);
    }
    case 'OBJECT_POLICY': {
      const { table, member } = resolveTableMember(parts, ctx.schema);
      return policyStub(table, member, 'absent', ctx.source);
    }
    case 'OBJECT_SCHEMA':
      return schemaObject(stringValue(object) ?? '', 'absent', ctx.source);
    case 'OBJECT_EXTENSION':
      // An extension's identity is its name; the schema it was installed in is not stated here.
      return extensionObject(stringValue(object) ?? '', ctx.schema, 'absent', ctx.source);
    default:
      return null;
  }
}
