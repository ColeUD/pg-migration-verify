/**
 * Small, typed helpers for reading libpg-query's JSON AST.
 *
 * The AST is protobuf JSON: every node is a single-key object such as `{ CreateStmt: {...} }`, and
 * default values (`false`, `0`, empty lists) are omitted. Helpers here always return a usable
 * default instead of `undefined` so handlers do not repeat `?? []` everywhere.
 */
import type { Node } from 'libpg-query';

type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/** Every node type name libpg-query can produce, e.g. `CreateStmt`, `ColumnRef`. */
export type NodeType = KeysOfUnion<Node>;

/** The payload type of a node, e.g. `NodeOf<'CreateStmt'>` is `CreateStmt`. */
export type NodeOf<K extends NodeType> =
  Extract<Node, Record<K, unknown>> extends Record<K, infer V> ? V : never;

/** Split `{ CreateStmt: {...} }` into its type name and payload. */
export function unwrapNode(node: Node): { type: NodeType; value: unknown } {
  const type = Object.keys(node)[0] as NodeType;
  return { type, value: (node as Record<string, unknown>)[type] };
}

/** The text of a `String` node, or undefined for any other node. */
export function stringValue(node: Node | undefined): string | undefined {
  return node !== undefined && 'String' in node ? (node.String.sval ?? '') : undefined;
}

/** Texts of a list of `String` nodes (qualified names, column lists); other nodes are skipped. */
export function stringValues(nodes: Node[] | undefined): string[] {
  return (nodes ?? []).flatMap((n) => {
    const s = stringValue(n);
    return s === undefined ? [] : [s];
  });
}

/** Integer value of an `A_Const` or `Integer` node (protobuf omits 0, so absent means 0). */
export function integerValue(node: Node): number | undefined {
  if ('A_Const' in node) {
    return node.A_Const.ival !== undefined ? (node.A_Const.ival.ival ?? 0) : undefined;
  }
  if ('Integer' in node) return node.Integer.ival ?? 0;
  return undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Column names referenced anywhere inside an expression, sorted and de-duplicated. Used for check
 * constraints, whose catalog entry (`conkey`) lists exactly the columns the expression mentions.
 * For a qualified reference (`t.col`) the last part is the column.
 */
export function referencedColumns(expression: unknown): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'ColumnRef' && isRecord(child) && Array.isArray(child.fields)) {
        const last: unknown = child.fields.at(-1);
        if (isRecord(last) && isRecord(last.String) && typeof last.String.sval === 'string') {
          found.add(last.String.sval);
        }
      } else {
        visit(child);
      }
    }
  };
  visit(expression);
  return [...found].sort();
}
