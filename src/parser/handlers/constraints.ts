/**
 * Table constraints, shared by CREATE TABLE (inline and table-level) and ALTER TABLE ADD
 * CONSTRAINT. NOT NULL, DEFAULT, identity and generated columns are column properties here, not
 * constraint objects; PRIMARY KEY and UNIQUE are reported as constraints only (Postgres creates
 * their indexes implicitly, and the verifier finds those through the constraint).
 */
import type { Constraint, ConstrType } from 'libpg-query';
import type { ConstraintObject, ConstraintType } from '../../model.js';
import { referencedColumns, stringValues } from '../ast.js';
import { keyed, type HandlerContext } from '../effects.js';
import { indexColumns } from '../expressions.js';
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
  switch (constraintType) {
    case 'primary_key':
    case 'unique':
      // `PRIMARY KEY USING INDEX idx` has no key list; the columns come from the index.
      columns = c.keys !== undefined ? stringValues(c.keys) : implicit;
      break;
    case 'foreign_key': {
      columns = c.fk_attrs !== undefined ? stringValues(c.fk_attrs) : implicit;
      const target = relationName(c.pktable, ctx.schema);
      references = {
        schema: target.schema,
        table: target.name,
        // REFERENCES t without a column list means t's primary key, which only the database knows.
        columns: c.pk_attrs !== undefined ? stringValues(c.pk_attrs) : null,
      };
      break;
    }
    case 'check':
      columns = referencedColumns(c.raw_expr);
      break;
    case 'exclusion':
      // Each element is a List of [IndexElem, operator name].
      columns = indexColumns(
        (c.exclusions ?? []).map((pair) => {
          const first = 'List' in pair ? pair.List.items?.[0] : undefined;
          return first !== undefined && 'IndexElem' in first ? first.IndexElem : undefined;
        }),
      );
      break;
  }

  return keyed<ConstraintObject>({
    kind: 'constraint',
    expect: 'present',
    schema: table.schema,
    table: table.name,
    name: c.conname ?? null,
    constraintType,
    columns,
    references,
    source: ctx.source,
  });
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
