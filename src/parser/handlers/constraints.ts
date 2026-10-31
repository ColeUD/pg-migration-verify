/**
 * Table constraints, shared by CREATE TABLE (inline and table-level) and ALTER TABLE ADD
 * CONSTRAINT. NOT NULL, DEFAULT, identity and generated columns are column properties here, not
 * constraint objects; PRIMARY KEY and UNIQUE are reported as constraints only (Postgres creates
 * their indexes implicitly, and the verifier finds those through the constraint).
 *
 * An unnamed constraint also records the name Postgres generates for it (`impliedName`), so a
 * later DROP or RENAME CONSTRAINT by that name is recognized. `ADD CONSTRAINT c UNIQUE USING INDEX
 * i` renames index i to c; ALTER TABLE emits that rename next to the constraint (tables.ts).
 */
import type { Constraint, ConstrType, IndexElem } from 'libpg-query';
import type { ConstraintObject, ConstraintType, FkAction } from '../../model.js';
import { referencedColumns, stringValues } from '../ast.js';
import { keyed, type HandlerContext } from '../effects.js';
import { indexColumns } from '../expressions.js';
import { impliedConstraintName, indexElemName } from '../implied-name.js';
import { relationName, type QualifiedName } from '../names.js';

const CONSTRAINT_TYPES: Partial<Record<ConstrType, ConstraintType>> = {
  CONSTR_PRIMARY: 'primary_key',
  CONSTR_UNIQUE: 'unique',
  CONSTR_FOREIGN: 'foreign_key',
  CONSTR_CHECK: 'check',
  CONSTR_EXCLUSION: 'exclusion',
};

/** The constraint's contype (libpg-query always writes enums; the default is only defensive). */
export function constraintKind(c: Constraint): ConstrType {
  return c.contype ?? 'CONSTR_NULL';
}

/**
 * Describe a constraint on `table`. `column` is set for inline column constraints
 * (`id uuid PRIMARY KEY REFERENCES ...`), whose key columns are implicit. Returns null for
 * constraint kinds that are column properties rather than catalog constraints.
 */
export function constraintObject(
  c: Constraint,
  table: QualifiedName,
  ctx: HandlerContext,
  column?: string,
): ConstraintObject | null {
  const constraintType = CONSTRAINT_TYPES[constraintKind(c)];
  if (constraintType === undefined) return null;
  const implicit = column === undefined ? null : [column];

  let columns: string[] | null;
  let references: ConstraintObject['references'] = null;
  // The column names Postgres builds a generated name from (see impliedConstraintName).
  let nameColumns: string[] = [];
  switch (constraintType) {
    case 'primary_key':
    case 'unique':
      // `PRIMARY KEY USING INDEX idx` has no key list; the columns come from the index.
      columns = c.keys !== undefined ? stringValues(c.keys) : implicit;
      nameColumns = [...(columns ?? []), ...stringValues(c.including)];
      break;
    case 'foreign_key': {
      columns = c.fk_attrs !== undefined ? stringValues(c.fk_attrs) : implicit;
      nameColumns = columns ?? [];
      const target = relationName(c.pktable, ctx.schema);
      references = {
        schema: target.schema,
        table: target.name,
        // REFERENCES t without a column list means t's primary key, which only the database knows.
        columns: c.pk_attrs !== undefined ? stringValues(c.pk_attrs) : null,
        onDelete: fkAction(c.fk_del_action),
        onUpdate: fkAction(c.fk_upd_action),
      };
      break;
    }
    case 'check':
      columns = referencedColumns(c.raw_expr);
      nameColumns = columns;
      break;
    case 'exclusion': {
      // Each element is a List of [IndexElem, operator name].
      const elems = (c.exclusions ?? []).map((pair): IndexElem | undefined => {
        const first = 'List' in pair ? pair.List.items?.[0] : undefined;
        return first !== undefined && 'IndexElem' in first ? first.IndexElem : undefined;
      });
      columns = indexColumns(elems);
      nameColumns = [...elems.map(indexElemName), ...stringValues(c.including)];
      break;
    }
  }

  // `ADD UNIQUE USING INDEX i` without a constraint name names the constraint after the index.
  const name = c.conname ?? c.indexname ?? null;

  return keyed<ConstraintObject>({
    kind: 'constraint',
    expect: 'present',
    schema: table.schema,
    table: table.name,
    name,
    constraintType,
    columns,
    references,
    ...(name === null && {
      impliedName: impliedConstraintName(table.name, constraintType, nameColumns),
    }),
    source: ctx.source,
  });
}

/**
 * libpg-query's action codes are pg_constraint's `confdeltype`/`confupdtype` codes. An unwritten
 * action is NO ACTION, which the statement then asserts as much as a written one.
 */
const FK_ACTIONS: Readonly<Record<string, FkAction>> = {
  a: 'no_action',
  r: 'restrict',
  c: 'cascade',
  n: 'set_null',
  d: 'set_default',
};

function fkAction(code: string | undefined): FkAction {
  return FK_ACTIONS[code ?? 'a'] ?? 'no_action';
}

/**
 * Columns a constraint forces to NOT NULL: a primary key's columns, and PG18's
 * `ADD CONSTRAINT name NOT NULL col`.
 */
export function notNullColumns(c: Constraint, column?: string): string[] {
  const kind = constraintKind(c);
  if (kind !== 'CONSTR_PRIMARY' && kind !== 'CONSTR_NOTNULL') return [];
  if (c.keys !== undefined) return stringValues(c.keys);
  return column === undefined ? [] : [column];
}
