/**
 * Statement dispatch: route each parsed statement to the handler for its node type. Statements
 * without a handler still produce a note, so nothing in a migration is silently dropped.
 */
import type { Node } from 'libpg-query';
import type { SourceRef } from '../model.js';
import { unwrapNode, type NodeOf, type NodeType } from './ast.js';
import { analyzeDoBlock } from './do-block.js';
import { noteEffect, type Effect, type HandlerContext } from './effects.js';
import { handleDropStmt } from './handlers/drops.js';
import { handleCreateFunction } from './handlers/functions.js';
import { handleIndexStmt } from './handlers/indexes.js';
import {
  createdSchemaName,
  handleCreateExtension,
  handleCreateSchema,
  handleSelect,
  handleVariableSet,
  NOTE_ONLY_STATEMENTS,
} from './handlers/misc.js';
import { handleAlterPolicy, handleCreatePolicy } from './handlers/policies.js';
import { handleAlterObjectSchema, handleRenameStmt } from './handlers/renames.js';
import {
  handleAlterTable,
  handleCreateSeqStmt,
  handleCreateStmt,
  handleCreateTableAs,
  handleViewStmt,
} from './handlers/tables.js';
import { handleCreateTrigger } from './handlers/triggers.js';
import {
  handleAlterEnum,
  handleCompositeType,
  handleCreateDomain,
  handleCreateEnum,
  handleCreateRange,
  handleDefineStmt,
} from './handlers/types.js';

type Handlers = { [K in NodeType]?: (node: NodeOf<K>, ctx: HandlerContext) => Effect[] };

const HANDLERS: Handlers = {
  CreateStmt: handleCreateStmt,
  CreateTableAsStmt: handleCreateTableAs,
  ViewStmt: handleViewStmt,
  CreateSeqStmt: handleCreateSeqStmt,
  AlterTableStmt: handleAlterTable,
  IndexStmt: handleIndexStmt,
  CreateFunctionStmt: handleCreateFunction,
  CreateTrigStmt: handleCreateTrigger,
  CreatePolicyStmt: handleCreatePolicy,
  AlterPolicyStmt: handleAlterPolicy,
  CreateEnumStmt: handleCreateEnum,
  AlterEnumStmt: handleAlterEnum,
  CompositeTypeStmt: handleCompositeType,
  CreateDomainStmt: handleCreateDomain,
  CreateRangeStmt: handleCreateRange,
  DefineStmt: handleDefineStmt,
  DropStmt: handleDropStmt,
  RenameStmt: handleRenameStmt,
  AlterObjectSchemaStmt: handleAlterObjectSchema,
  CreateExtensionStmt: handleCreateExtension,
  VariableSetStmt: handleVariableSet,
  SelectStmt: handleSelect,
};

export interface StatementContext {
  /** Schema that unqualified names resolve to. */
  schema: string;
  source: SourceRef;
}

/** Describe the effects of one statement (and, for CREATE SCHEMA and DO, its nested statements). */
export function analyzeStatement(node: Node, context: StatementContext): Effect[] {
  const { type, value } = unwrapNode(node);
  const ctx: HandlerContext = { ...context, statementType: type };

  if ('CreateSchemaStmt' in node) {
    // Elements of CREATE SCHEMA s CREATE TABLE t ... are created inside s.
    const schema = createdSchemaName(node.CreateSchemaStmt);
    return [
      ...handleCreateSchema(node.CreateSchemaStmt, ctx),
      ...(node.CreateSchemaStmt.schemaElts ?? []).flatMap((element) =>
        analyzeStatement(element, { ...context, schema }),
      ),
    ];
  }
  if ('DoStmt' in node) return analyzeDoBlock(node.DoStmt, ctx, analyzeStatement);

  const handler = HANDLERS[type] as ((node: unknown, ctx: HandlerContext) => Effect[]) | undefined;
  if (handler !== undefined) return handler(value, ctx);
  const known = NOTE_ONLY_STATEMENTS[type];
  if (known !== undefined) return [noteEffect(ctx, known.category, known.reason)];
  return [noteEffect(ctx, 'unverifiable', `${type} is not supported yet`)];
}
