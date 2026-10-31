/**
 * The names Postgres generates for unnamed indexes and constraints, ported from `makeObjectName`,
 * `ChooseIndexName`, `ChooseIndexColumnNames` and `ChooseIndexNameAddition` (indexcmds.c),
 * `FigureColnameInternal` (parse_target.c), the foreign key naming in tablecmds.c and the check
 * constraint naming in heap.c.
 *
 * Unnamed objects are still matched with the catalog by shape (table, type, columns); the
 * generated name only lets the parser and the timeline recognize a later statement that refers to
 * the object by it (`ALTER TABLE profiles DROP CONSTRAINT profiles_username_key`), which is how
 * `supabase db diff` and most people write such drops. When the name is taken Postgres appends a
 * number (`profiles_username_key1`); that is not predicted, so such a drop is simply not matched.
 */
import type { IndexElem, Node } from 'libpg-query';
import type { ConstraintType } from '../model.js';
import { stringValue, stringValues } from './ast.js';

/** Postgres' NAMEDATALEN: names are at most 63 bytes. */
const NAMEDATALEN = 64;

const CONSTRAINT_LABELS: Record<Exclude<ConstraintType, 'check'>, string> = {
  primary_key: 'pkey',
  unique: 'key',
  exclusion: 'excl',
  foreign_key: 'fkey',
};

/** `CREATE [UNIQUE] INDEX ON t (...)`: `t_<columns>_idx`, INCLUDE columns among the columns. */
export function impliedIndexName(table: string, columnNames: readonly string[]): string {
  return makeObjectName(table, nameAddition(distinctColumnNames(columnNames)), 'idx');
}

/**
 * The generated name of an unnamed constraint on `table`.
 * - `columnNames`: for primary keys, unique and exclusion constraints the index column names
 *   (key and INCLUDE columns, see {@link indexElemName}); for foreign keys the referencing
 *   columns; for check constraints the distinct columns the expression references.
 */
export function impliedConstraintName(
  table: string,
  type: ConstraintType,
  columnNames: readonly string[],
): string {
  switch (type) {
    case 'primary_key':
      return makeObjectName(table, null, CONSTRAINT_LABELS.primary_key);
    case 'unique':
    case 'exclusion':
      return makeObjectName(
        table,
        nameAddition(distinctColumnNames(columnNames)),
        CONSTRAINT_LABELS[type],
      );
    case 'foreign_key':
      return makeObjectName(table, nameAddition(columnNames), CONSTRAINT_LABELS.foreign_key);
    case 'check':
      // heap.c: the column's name only when the expression references exactly one column.
      return makeObjectName(
        table,
        columnNames.length === 1 ? (columnNames[0] ?? null) : null,
        'check',
      );
  }
}

/**
 * The name Postgres gives an index column: the column itself, or for an expression a name
 * figured from it (`lower(email)` -> `lower`), falling back to `expr`.
 */
export function indexElemName(elem: IndexElem | undefined): string {
  if (elem === undefined) return 'expr';
  return elem.indexcolname ?? elem.name ?? figureColname(elem.expr).name ?? 'expr';
}

/**
 * `makeObjectName`: `name1_name2_label`, cutting the longer of name1 and name2 one byte at a time
 * until the whole fits in 63 bytes, and never in the middle of a UTF-8 character.
 */
export function makeObjectName(name1: string, name2: string | null, label: string): string {
  const bytes1 = Buffer.from(name1, 'utf8');
  const bytes2 = name2 === null ? null : Buffer.from(name2, 'utf8');
  let length1 = bytes1.length;
  let length2 = bytes2?.length ?? 0;
  const overhead = (bytes2 === null ? 0 : 1) + Buffer.byteLength(label, 'utf8') + 1;
  const available = NAMEDATALEN - 1 - overhead;
  while (length1 + length2 > available) {
    if (length1 > length2) length1 -= 1;
    else length2 -= 1;
  }
  const part1 = clip(bytes1, length1);
  const part2 = bytes2 === null ? '' : `_${clip(bytes2, length2)}`;
  return `${part1}${part2}_${label}`;
}

/** `pg_mbcliplen` for UTF-8: the longest prefix of at most `limit` bytes that ends on a character. */
function clip(bytes: Buffer, limit: number): string {
  let end = Math.min(limit, bytes.length);
  while (end > 0 && end < bytes.length && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString('utf8');
}

/**
 * `ChooseIndexNameAddition` / `ChooseForeignKeyConstraintNameAddition`: the names joined with
 * `_`, stopping once the result reaches NAMEDATALEN (makeObjectName cuts it to size).
 */
function nameAddition(names: readonly string[]): string {
  let addition = '';
  for (const name of names) {
    addition = addition === '' ? name : `${addition}_${name}`;
    if (Buffer.byteLength(addition, 'utf8') >= NAMEDATALEN) break;
  }
  return addition;
}

/** `ChooseIndexColumnNames`: a repeated name gets a number (`expr`, `expr1`, `expr2`). */
function distinctColumnNames(names: readonly string[]): string[] {
  const chosen: string[] = [];
  for (const name of names) {
    let candidate = name;
    for (let i = 1; chosen.includes(candidate); i += 1) {
      const suffix = String(i);
      candidate = clip(Buffer.from(name, 'utf8'), NAMEDATALEN - 1 - suffix.length) + suffix;
    }
    chosen.push(candidate);
  }
  return chosen;
}

/**
 * `FigureColnameInternal`: a column name for an expression, and how sure it is (2 = a real name,
 * 1 = a fallback such as a cast's type name, 0 = none). Covers the node types that can appear
 * in an index expression; anything else gets no name (`expr`).
 */
function figureColname(node: Node | undefined): { name: string | null; strength: number } {
  const none = { name: null, strength: 0 };
  if (node === undefined) return none;
  if ('ColumnRef' in node) {
    const last = stringValue(node.ColumnRef.fields?.at(-1));
    return last === undefined ? none : { name: last, strength: 2 };
  }
  if ('A_Indirection' in node) {
    const field = stringValues(node.A_Indirection.indirection).at(-1);
    return field !== undefined
      ? { name: field, strength: 2 }
      : figureColname(node.A_Indirection.arg);
  }
  if ('FuncCall' in node) {
    const name = stringValues(node.FuncCall.funcname).at(-1);
    return name === undefined ? none : { name, strength: 2 };
  }
  if ('A_Expr' in node) {
    return node.A_Expr.kind === 'AEXPR_NULLIF' ? { name: 'nullif', strength: 2 } : none;
  }
  if ('TypeCast' in node) {
    const inner = figureColname(node.TypeCast.arg);
    if (inner.strength > 1) return inner;
    const typeName = stringValues(node.TypeCast.typeName?.names).at(-1);
    return typeName === undefined ? inner : { name: typeName, strength: 1 };
  }
  if ('CollateClause' in node) return figureColname(node.CollateClause.arg);
  if ('CaseExpr' in node) {
    const inner = figureColname(node.CaseExpr.defresult);
    return inner.strength > 1 ? inner : { name: 'case', strength: 1 };
  }
  if ('A_ArrayExpr' in node) return { name: 'array', strength: 1 };
  if ('RowExpr' in node) return { name: 'row', strength: 1 };
  if ('CoalesceExpr' in node) return { name: 'coalesce', strength: 2 };
  if ('MinMaxExpr' in node) {
    const op = node.MinMaxExpr.op;
    if (op === 'IS_GREATEST') return { name: 'greatest', strength: 2 };
    if (op === 'IS_LEAST') return { name: 'least', strength: 2 };
  }
  return none;
}
