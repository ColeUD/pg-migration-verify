/** CREATE INDEX. Partial-index predicates and INCLUDE columns are not part of the expectation. */
import type { IndexStmt } from 'libpg-query';
import type { IndexObject } from '../../model.js';
import { keyed, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { indexColumns } from '../expressions.js';
import { relationName } from '../names.js';

export function handleIndexStmt(node: IndexStmt, ctx: HandlerContext): Effect[] {
  // An index always lives in its table's schema.
  const table = relationName(node.relation, ctx.schema);
  const elems = (node.indexParams ?? []).map((p) => ('IndexElem' in p ? p.IndexElem : undefined));
  return [
    objectEffect(
      keyed<IndexObject>({
        kind: 'index',
        expect: 'present',
        schema: table.schema,
        table: table.name,
        name: node.idxname ?? null,
        unique: node.unique ?? false,
        method: node.accessMethod ?? 'btree',
        columns: indexColumns(elems),
        source: ctx.source,
      }),
    ),
  ];
}
