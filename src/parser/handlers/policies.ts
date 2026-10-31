/** CREATE POLICY and ALTER POLICY (row level security policies). */
import type { AlterPolicyStmt, CreatePolicyStmt, Node } from 'libpg-query';
import type { PolicyCommand, PolicyObject } from '../../model.js';
import { keyed, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { deparseExpression } from '../expressions.js';
import { relationName } from '../names.js';

const COMMANDS: Readonly<Record<string, PolicyCommand>> = {
  all: 'ALL',
  select: 'SELECT',
  insert: 'INSERT',
  update: 'UPDATE',
  delete: 'DELETE',
};

export function handleCreatePolicy(node: CreatePolicyStmt, ctx: HandlerContext): Effect[] {
  const table = relationName(node.table, ctx.schema);
  return [
    objectEffect(
      keyed<PolicyObject>({
        kind: 'policy',
        expect: 'present',
        schema: table.schema,
        table: table.name,
        name: node.policy_name ?? '',
        command: COMMANDS[node.cmd_name ?? 'all'] ?? null,
        // AS RESTRICTIVE is the only way to get `permissive: false`, which protobuf then omits.
        permissive: node.permissive ?? false,
        roles: roleNames(node.roles),
        using: deparseExpression(node.qual),
        withCheck: deparseExpression(node.with_check),
        source: ctx.source,
      }),
    ),
  ];
}

/** ALTER POLICY only asserts what it changes; everything else stays as created. */
export function handleAlterPolicy(node: AlterPolicyStmt, ctx: HandlerContext): Effect[] {
  const table = relationName(node.table, ctx.schema);
  return [
    objectEffect(
      keyed<PolicyObject>({
        kind: 'policy',
        expect: 'present',
        schema: table.schema,
        table: table.name,
        name: node.policy_name ?? '',
        command: null,
        permissive: null,
        roles: node.roles === undefined ? null : roleNames(node.roles),
        using: deparseExpression(node.qual),
        withCheck: deparseExpression(node.with_check),
        source: ctx.source,
      }),
    ),
  ];
}

/** Sorted role names; PUBLIC (also the default when there is no TO clause) is `public`. */
function roleNames(roles: Node[] | undefined): string[] {
  const names = (roles ?? []).flatMap((r) => {
    if (!('RoleSpec' in r)) return [];
    switch (r.RoleSpec.roletype) {
      case 'ROLESPEC_PUBLIC':
        return ['public'];
      case 'ROLESPEC_CURRENT_USER':
        return ['current_user'];
      case 'ROLESPEC_SESSION_USER':
        return ['session_user'];
      case 'ROLESPEC_CURRENT_ROLE':
        return ['current_role'];
      default:
        return [r.RoleSpec.rolename ?? ''];
    }
  });
  return names.length === 0 ? ['public'] : names.sort();
}
