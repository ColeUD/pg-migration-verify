/**
 * Schemas, extensions, search_path changes, and the statements that only produce notes.
 */
import type {
  CreateExtensionStmt,
  CreateSchemaStmt,
  Node,
  SelectStmt,
  VariableSetStmt,
} from 'libpg-query';
import type { Note } from '../../model.js';
import type { NodeType } from '../ast.js';
import { stringValue } from '../ast.js';
import { noteEffect, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { extensionObject, schemaObject } from '../objects.js';

export function handleCreateSchema(node: CreateSchemaStmt, ctx: HandlerContext): Effect[] {
  return [objectEffect(schemaObject(createdSchemaName(node), 'present', ctx.source))];
}

/** `CREATE SCHEMA AUTHORIZATION joe` creates a schema named after the role. */
export function createdSchemaName(node: CreateSchemaStmt): string {
  return node.schemaname ?? node.authrole?.rolename ?? '';
}

export function handleCreateExtension(node: CreateExtensionStmt, ctx: HandlerContext): Effect[] {
  const schemaOption = (node.options ?? []).find(
    (o) => 'DefElem' in o && o.DefElem.defname === 'schema',
  );
  const schema =
    schemaOption !== undefined && 'DefElem' in schemaOption
      ? (stringValue(schemaOption.DefElem.arg) ?? ctx.schema)
      : ctx.schema;
  return [objectEffect(extensionObject(node.extname ?? '', schema, 'present', ctx.source))];
}

/**
 * `SET [LOCAL] search_path` changes where later unqualified names are created. Any other SET has
 * no lasting schema effect.
 */
export function handleVariableSet(node: VariableSetStmt, ctx: HandlerContext): Effect[] {
  const kind = node.kind ?? 'VAR_SET_VALUE';
  if (kind === 'VAR_RESET_ALL' || (node.name === 'search_path' && kind !== 'VAR_SET_VALUE')) {
    return searchPathEffects(null, ctx);
  }
  if (node.name !== 'search_path') return [noteEffect(ctx, 'ignored', NO_LASTING_EFFECT)];
  const values = (node.args ?? []).flatMap((a) =>
    'A_Const' in a && a.A_Const.sval !== undefined ? [a.A_Const.sval.sval ?? ''] : [],
  );
  return searchPathEffects(values, ctx);
}

/**
 * `SELECT [pg_catalog.]set_config('search_path', '...', is_local)`, which `pg_dump` and
 * `supabase db dump` emit at the top of every file, works like SET search_path. Every other SELECT
 * has no schema effect.
 */
export function handleSelect(node: SelectStmt, ctx: HandlerContext): Effect[] {
  const value = searchPathFromSetConfig(node);
  if (value !== undefined) {
    return searchPathEffects(
      value.split(',').map((s) => s.trim().replace(/^"(.*)"$/, '$1')),
      ctx,
    );
  }
  return [
    noteEffect(ctx, 'unverifiable', 'SELECT statements have no schema effect that can be checked'),
  ];
}

function searchPathFromSetConfig(node: SelectStmt): string | undefined {
  const targets = node.targetList ?? [];
  const only = targets.length === 1 ? targets[0] : undefined;
  const value = only !== undefined && 'ResTarget' in only ? only.ResTarget.val : undefined;
  if (value === undefined || !('FuncCall' in value)) return undefined;
  const call = value.FuncCall;
  const fn = stringValue(call.funcname?.at(-1));
  const [setting, settingValue] = (call.args ?? []).map(constantText);
  return fn === 'set_config' && setting === 'search_path' ? settingValue : undefined;
}

function constantText(node: Node): string | undefined {
  return 'A_Const' in node && node.A_Const.sval !== undefined
    ? (node.A_Const.sval.sval ?? '')
    : undefined;
}

/**
 * The first schema in the path (other than `$user`, which usually does not exist) is where
 * unqualified CREATE statements put objects. `values = null` resets to the default. An empty path
 * makes unqualified CREATEs fail, so the default schema is left as it is.
 */
function searchPathEffects(values: string[] | null, ctx: HandlerContext): Effect[] {
  if (values === null) {
    return [
      { type: 'search_path', schema: null },
      noteEffect(
        ctx,
        'ignored',
        'search_path reset: unqualified names resolve to the default schema again',
      ),
    ];
  }
  const schema = values.find((v) => v !== '$user' && v !== '');
  if (schema === undefined) {
    return [
      noteEffect(ctx, 'ignored', 'search_path has no usable schema; the default schema is kept'),
    ];
  }
  return [
    { type: 'search_path', schema },
    noteEffect(
      ctx,
      'ignored',
      `search_path set: later unqualified names resolve to schema ${schema}`,
    ),
  ];
}

const NO_LASTING_EFFECT = 'no lasting schema effect';
const DATA_CHANGE = 'data change, not a schema object';
const PRIVILEGES = 'privileges are not checked';
const ROLES = 'roles are cluster-wide and are not checked';

/** Statements that never produce expected objects, and why. */
export const NOTE_ONLY_STATEMENTS: Partial<
  Record<NodeType, { category: Note['category']; reason: string }>
> = {
  GrantStmt: { category: 'unverifiable', reason: PRIVILEGES },
  GrantRoleStmt: { category: 'unverifiable', reason: PRIVILEGES },
  AlterDefaultPrivilegesStmt: { category: 'unverifiable', reason: PRIVILEGES },
  CommentStmt: { category: 'unverifiable', reason: 'comments are not checked' },
  CreatePublicationStmt: { category: 'unverifiable', reason: 'publications are not checked' },
  AlterPublicationStmt: { category: 'unverifiable', reason: 'publications are not checked' },
  InsertStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  UpdateStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  DeleteStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  MergeStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  CopyStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  TruncateStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  CallStmt: { category: 'unverifiable', reason: DATA_CHANGE },
  AlterFunctionStmt: { category: 'unverifiable', reason: 'function attributes are not checked' },
  AlterSeqStmt: { category: 'unverifiable', reason: 'sequence options are not checked' },
  AlterOwnerStmt: { category: 'unverifiable', reason: 'ownership is not checked' },
  CreateRoleStmt: { category: 'unverifiable', reason: ROLES },
  AlterRoleStmt: { category: 'unverifiable', reason: ROLES },
  AlterRoleSetStmt: { category: 'unverifiable', reason: ROLES },
  DropRoleStmt: { category: 'unverifiable', reason: ROLES },
  TransactionStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  VariableShowStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  NotifyStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  LockStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  VacuumStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  CheckPointStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
  DiscardStmt: { category: 'ignored', reason: NO_LASTING_EFFECT },
};
