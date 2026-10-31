/**
 * Expression text for display. pgsql-deparser is only used on expressions: its DDL output has
 * known bugs (lost quoting, dropped relations), and expressions are never string-compared with
 * the catalog anyway, only shown to the user or matched loosely.
 */
import type { IndexElem, Node } from 'libpg-query';
import { deparseSync } from 'pgsql-deparser';

/** Deparsed SQL for an expression node, or null if the deparser cannot handle it. */
export function deparseExpression(node: Node | undefined): string | null {
  if (node === undefined) return null;
  try {
    return deparseSync(node);
  } catch {
    return null;
  }
}

/**
 * An index key column as the catalog reader reports it: the plain column name, or the expression
 * wrapped in parentheses (`(lower(email))`). Null when the expression cannot be deparsed.
 */
export function indexElemText(elem: IndexElem): string | null {
  if (elem.name !== undefined) return elem.name;
  const expression = deparseExpression(elem.expr);
  return expression === null ? null : `(${expression})`;
}

/** Key columns of an index or exclusion constraint; null if any of them cannot be described. */
export function indexColumns(elems: (IndexElem | undefined)[]): string[] | null {
  const columns = elems.map((e) => (e === undefined ? null : indexElemText(e)));
  return columns.every((c): c is string => c !== null) ? columns : null;
}
