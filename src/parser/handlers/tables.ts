/**
 * Relations and their columns: CREATE TABLE, CREATE TABLE AS / MATERIALIZED VIEW, CREATE VIEW,
 * CREATE SEQUENCE and ALTER TABLE.
 */
import type {
  AlterTableCmd,
  AlterTableStmt,
  ColumnDef,
  Constraint,
  CreateSeqStmt,
  CreateStmt,
  CreateTableAsStmt,
  Node,
  RangeVar,
  ViewStmt,
} from 'libpg-query';
import type { RlsObject } from '../../model.js';
import {
  keyed,
  noteEffect,
  objectEffect,
  renameEffect,
  type Effect,
  type HandlerContext,
} from '../effects.js';
import { relationName, type QualifiedName } from '../names.js';
import { columnObject, constraintStub, indexStub, relationObject } from '../objects.js';
import { isSerialType, normalizeTypeName } from '../types.js';
import { constraintKind, constraintObject, notNullColumns } from './constraints.js';

const TEMPORARY = 't';

export function handleCreateStmt(node: CreateStmt, ctx: HandlerContext): Effect[] {
  if (isTemporary(node.relation)) {
    return [noteEffect(ctx, 'ignored', 'temporary table: it does not outlive the session')];
  }
  const table = relationName(node.relation, ctx.schema);
  const tableObject = relationObject('table', table, 'present', ctx.source);
  const effects: Effect[] = [objectEffect(tableObject)];

  const elements = node.tableElts ?? [];
  // Columns listed in a table-level PRIMARY KEY become NOT NULL.
  const primaryKeyColumns = new Set(
    elements.flatMap((e) =>
      'Constraint' in e && constraintKind(e.Constraint) === 'CONSTR_PRIMARY'
        ? notNullColumns(e.Constraint)
        : [],
    ),
  );

  for (const element of elements) {
    if ('ColumnDef' in element) {
      const def = element.ColumnDef;
      const inPrimaryKey = primaryKeyColumns.has(def.colname ?? '');
      effects.push(...columnDefinition(def, table, ctx, inPrimaryKey));
    } else if ('Constraint' in element) {
      const constraint = constraintObject(element.Constraint, table, ctx);
      if (constraint !== null) effects.push(objectEffect(constraint));
    } else if ('TableLikeClause' in element) {
      effects.push(
        noteEffect(
          ctx,
          'unverifiable',
          'columns copied with LIKE are not listed, so they are not checked',
        ),
      );
    }
  }

  if (node.partbound !== undefined) {
    effects.push(
      noteEffect(
        ctx,
        'unverifiable',
        'columns of a partition come from its parent table and are not checked',
      ),
    );
  } else if ((node.inhRelations ?? []).length > 0) {
    effects.push(
      noteEffect(
        ctx,
        'unverifiable',
        'inherited columns come from the parent table and are not checked',
      ),
    );
  }
  if (node.ofTypename !== undefined) {
    effects.push(
      noteEffect(
        ctx,
        'unverifiable',
        'columns of a typed table come from its type and are not checked',
      ),
    );
  }
  // CREATE TABLE IF NOT EXISTS skips everything it declares when the table exists.
  return node.if_not_exists === true ? conditionalOn(tableObject.key, effects) : effects;
}

export function handleCreateTableAs(node: CreateTableAsStmt, ctx: HandlerContext): Effect[] {
  const rel = node.into?.rel;
  if (isTemporary(rel)) {
    return [noteEffect(ctx, 'ignored', 'temporary table: it does not outlive the session')];
  }
  const kind = node.objtype === 'OBJECT_MATVIEW' ? 'materialized_view' : 'table';
  return [
    objectEffect(relationObject(kind, relationName(rel, ctx.schema), 'present', ctx.source)),
    noteEffect(ctx, 'unverifiable', 'columns come from a query and are not checked'),
  ];
}

export function handleViewStmt(node: ViewStmt, ctx: HandlerContext): Effect[] {
  if (isTemporary(node.view)) {
    return [noteEffect(ctx, 'ignored', 'temporary view: it does not outlive the session')];
  }
  return [
    objectEffect(
      relationObject('view', relationName(node.view, ctx.schema), 'present', ctx.source),
    ),
  ];
}

export function handleCreateSeqStmt(node: CreateSeqStmt, ctx: HandlerContext): Effect[] {
  if (isTemporary(node.sequence)) {
    return [noteEffect(ctx, 'ignored', 'temporary sequence: it does not outlive the session')];
  }
  const name = relationName(node.sequence, ctx.schema);
  const sequence = relationObject('sequence', name, 'present', ctx.source);
  const effects = [objectEffect(sequence)];
  return node.if_not_exists === true ? conditionalOn(sequence.key, effects) : effects;
}

export function handleAlterTable(node: AlterTableStmt, ctx: HandlerContext): Effect[] {
  const table = relationName(node.relation, ctx.schema);
  const commands = (node.cmds ?? []).flatMap((c) =>
    'AlterTableCmd' in c ? [c.AlterTableCmd] : [],
  );
  const objtype = node.objtype ?? 'OBJECT_TABLE';
  if (objtype !== 'OBJECT_TABLE') {
    // ALTER VIEW / INDEX / SEQUENCE / MATERIALIZED VIEW: options and ownership, nothing to check.
    const what = objtype.replace('OBJECT_', '').replace('MATVIEW', 'MATERIALIZED VIEW');
    return commands.map((cmd) =>
      cmd.subtype === 'AT_ChangeOwner'
        ? noteEffect(ctx, 'unverifiable', 'ownership is not checked')
        : noteEffect(ctx, 'unverifiable', `ALTER ${what} ${subtypeName(cmd)} is not checked`),
    );
  }
  return commands.flatMap((cmd) => alterTableCommand(cmd, table, ctx));
}

function alterTableCommand(
  cmd: AlterTableCmd,
  table: QualifiedName,
  ctx: HandlerContext,
): Effect[] {
  const name = cmd.name ?? '';
  const columnEffect = (dataType: string | null, notNull: boolean | null): Effect =>
    objectEffect(columnObject(table, name, 'present', { dataType, notNull }, ctx.source));

  switch (cmd.subtype ?? 'AT_AddColumn') {
    case 'AT_AddColumn': {
      const def = columnDefOf(cmd.def);
      if (def === undefined) return [];
      const effects = columnDefinition(def, table, ctx, false);
      // ADD COLUMN IF NOT EXISTS skips the column and its constraints when the column exists.
      if (cmd.missing_ok !== true) return effects;
      const column = columnObject(table, def.colname ?? '', 'present', NO_ATTRIBUTES, ctx.source);
      return conditionalOn(column.key, effects);
    }
    case 'AT_DropColumn':
      return [
        objectEffect(
          columnObject(table, name, 'absent', { dataType: null, notNull: null }, ctx.source),
        ),
      ];
    case 'AT_AlterColumnType': {
      // USING expressions only convert existing data; the new type is what is checked.
      const typeName = columnDefOf(cmd.def)?.typeName;
      return [columnEffect(typeName === undefined ? null : normalizeTypeName(typeName), null)];
    }
    case 'AT_SetNotNull':
      return [columnEffect(null, true)];
    case 'AT_DropNotNull':
      return [columnEffect(null, false)];
    case 'AT_ColumnDefault':
      return [noteEffect(ctx, 'unverifiable', 'column defaults are not checked')];
    case 'AT_AddConstraint': {
      const c = constraintOf(cmd.def);
      return c === undefined ? [] : addedConstraint(c, table, ctx);
    }
    case 'AT_DropConstraint':
      return [objectEffect(constraintStub(table, name, 'absent', ctx.source))];
    case 'AT_EnableRowSecurity':
      return [objectEffect(rls(table, { enabled: true, forced: null }, ctx))];
    case 'AT_DisableRowSecurity':
      return [objectEffect(rls(table, { enabled: false, forced: null }, ctx))];
    case 'AT_ForceRowSecurity':
      return [objectEffect(rls(table, { enabled: null, forced: true }, ctx))];
    case 'AT_NoForceRowSecurity':
      return [objectEffect(rls(table, { enabled: null, forced: false }, ctx))];
    case 'AT_ChangeOwner':
      return [noteEffect(ctx, 'unverifiable', 'ownership is not checked')];
    default:
      return [noteEffect(ctx, 'unverifiable', `ALTER TABLE ${subtypeName(cmd)} is not checked`)];
  }
}

/**
 * A column from CREATE TABLE or ADD COLUMN, plus its inline constraints. NOT NULL is asserted
 * either way: a column without NOT NULL is expected to be nullable. PRIMARY KEY, identity and
 * serial columns are implicitly NOT NULL.
 */
function columnDefinition(
  def: ColumnDef,
  table: QualifiedName,
  ctx: HandlerContext,
  inPrimaryKey: boolean,
): Effect[] {
  const name = def.colname ?? '';
  const constraints = (def.constraints ?? []).flatMap((c) =>
    'Constraint' in c ? [c.Constraint] : [],
  );
  const kinds = constraints.map(constraintKind);
  const notNull =
    inPrimaryKey ||
    isSerialType(def.typeName) ||
    kinds.some((k) => k === 'CONSTR_NOTNULL' || k === 'CONSTR_PRIMARY' || k === 'CONSTR_IDENTITY');
  const dataType = def.typeName === undefined ? null : normalizeTypeName(def.typeName);

  const effects: Effect[] = [
    objectEffect(columnObject(table, name, 'present', { dataType, notNull }, ctx.source)),
  ];
  for (const c of constraints) {
    const constraint = constraintObject(c, table, ctx, name);
    if (constraint !== null) effects.push(objectEffect(constraint));
  }
  return effects;
}

/**
 * ADD CONSTRAINT; a primary key also makes its columns NOT NULL. `ADD CONSTRAINT c UNIQUE|PRIMARY
 * KEY USING INDEX i` renames index i to c (when the names differ), so that comes first.
 */
function addedConstraint(c: Constraint, table: QualifiedName, ctx: HandlerContext): Effect[] {
  const effects: Effect[] = [];
  if (c.indexname !== undefined && c.conname !== undefined && c.conname !== c.indexname) {
    // The index is in the table's schema: USING INDEX only takes an unqualified name.
    const index = (name: string, expect: 'present' | 'absent') =>
      indexStub({ schema: table.schema, name }, table.name, expect, ctx.source);
    effects.push(renameEffect(index(c.indexname, 'absent'), index(c.conname, 'present'), ctx));
  }
  const notNull: Effect[] = notNullColumns(c).map((name) =>
    objectEffect(
      columnObject(table, name, 'present', { dataType: null, notNull: true }, ctx.source),
    ),
  );
  effects.push(...notNull);
  const constraint = constraintObject(c, table, ctx);
  if (constraint !== null) {
    effects.push(objectEffect(constraint));
  } else if (notNull.length === 0) {
    const kind = constraintKind(c).replace('CONSTR_', '');
    effects.push(noteEffect(ctx, 'unverifiable', `${kind} constraints are not checked`));
  }
  return effects;
}

const NO_ATTRIBUTES = { dataType: null, notNull: null };

/** Mark every object among `effects` as skipped by IF NOT EXISTS when `guard` already exists. */
function conditionalOn(guard: string, effects: Effect[]): Effect[] {
  return effects.map((e) =>
    e.type === 'object' ? { ...e, object: { ...e.object, conditional: guard } } : e,
  );
}

function rls(
  table: QualifiedName,
  state: Pick<RlsObject, 'enabled' | 'forced'>,
  ctx: HandlerContext,
): RlsObject {
  return keyed<RlsObject>({
    kind: 'rls',
    expect: 'present',
    schema: table.schema,
    table: table.name,
    ...state,
    source: ctx.source,
  });
}

function isTemporary(rel: RangeVar | undefined): boolean {
  return rel?.relpersistence === TEMPORARY;
}

/** `AT_ReplicaIdentity` -> `ReplicaIdentity`, for notes. */
function subtypeName(cmd: AlterTableCmd): string {
  return (cmd.subtype ?? 'AT_AddColumn').replace(/^AT_/, '');
}

function columnDefOf(node: Node | undefined): ColumnDef | undefined {
  return node !== undefined && 'ColumnDef' in node ? node.ColumnDef : undefined;
}

function constraintOf(node: Node | undefined): Constraint | undefined {
  return node !== undefined && 'Constraint' in node ? node.Constraint : undefined;
}
