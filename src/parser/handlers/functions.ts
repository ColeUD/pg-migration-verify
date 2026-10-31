/**
 * CREATE [OR REPLACE] FUNCTION / PROCEDURE. Only the identity (schema, name, argument types) is
 * expected; bodies are never looked at, since they are opaque text to Postgres until called.
 */
import type {
  CreateFunctionStmt,
  FunctionParameter,
  FunctionParameterMode,
  Node,
  ObjectWithArgs,
} from 'libpg-query';
import { stringValues } from '../ast.js';
import { noteEffect, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { resolveName, type QualifiedName } from '../names.js';
import { functionObject } from '../objects.js';
import { normalizeTypeName } from '../types.js';

/** Parameter modes that are part of the identity signature (`pg_proc.proargtypes`). */
const IDENTITY_MODES: ReadonlySet<FunctionParameterMode> = new Set([
  'FUNC_PARAM_DEFAULT',
  'FUNC_PARAM_IN',
  'FUNC_PARAM_INOUT',
  'FUNC_PARAM_VARIADIC',
]);

export function handleCreateFunction(node: CreateFunctionStmt, ctx: HandlerContext): Effect[] {
  const name = resolveName(stringValues(node.funcname), ctx.schema);
  const params = (node.parameters ?? []).flatMap((p) =>
    'FunctionParameter' in p ? [p.FunctionParameter] : [],
  );
  const argTypes = identityArgTypes(params);
  if (argTypes === null) {
    return [
      noteEffect(
        ctx,
        'unverifiable',
        'an argument type uses %TYPE, so the function signature cannot be known from the SQL alone',
      ),
    ];
  }
  return [
    objectEffect(functionObject(name, argTypes, node.is_procedure ?? false, 'present', ctx.source)),
  ];
}

/** Argument types of IN, INOUT and VARIADIC parameters, without typmods; null if any is unknown. */
export function identityArgTypes(params: FunctionParameter[]): string[] | null {
  const types = params
    .filter((p) => IDENTITY_MODES.has(p.mode ?? 'FUNC_PARAM_DEFAULT'))
    .map((p) =>
      p.argType === undefined ? null : normalizeTypeName(p.argType, { withTypmod: false }),
    );
  return types.every((t): t is string => t !== null) ? types : null;
}

/**
 * Identity of a function reference (`DROP FUNCTION f(int)`, `ALTER FUNCTION f(text) RENAME`).
 * argTypes is null when no argument list was written (`DROP FUNCTION f`).
 */
export function referencedFunction(
  ref: ObjectWithArgs,
  defaultSchema: string,
): { name: QualifiedName; argTypes: string[] | null } {
  const name = resolveName(stringValues(ref.objname), defaultSchema);
  if (ref.args_unspecified === true) return { name, argTypes: null };
  const types = (ref.objargs ?? []).map((a: Node) =>
    'TypeName' in a ? normalizeTypeName(a.TypeName, { withTypmod: false }) : null,
  );
  return { name, argTypes: types.every((t): t is string => t !== null) ? types : null };
}
