/** CREATE INDEX. Partial-index predicates and INCLUDE columns are not part of the expectation. */
import type { IndexElem, IndexStmt, Node } from 'libpg-query';
import type { IndexObject } from '../../model.js';
import { keyed, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { indexColumns } from '../expressions.js';
import { impliedIndexName, indexElemName } from '../implied-name.js';
import { relationName } from '../names.js';

export function handleIndexStmt(node: IndexStmt, ctx: HandlerContext): Effect[] {
  // An index always lives in its table's schema.
  const table = relationName(node.relation, ctx.schema);
  const elems = indexElems(node.indexParams);
  const name = node.idxname ?? null;
  const index = keyed<IndexObject>({
    kind: 'index',
    expect: 'present',
    schema: table.schema,
    table: table.name,
    name,
    unique: node.unique ?? false,
    method: node.accessMethod ?? 'btree',
    columns: indexColumns(elems),
    // Postgres names an unnamed index after its key and INCLUDE columns.
    ...(name === null && {
      impliedName: impliedIndexName(
        table.name,
        [...elems, ...indexElems(node.indexIncludingParams)].map(indexElemName),
      ),
    }),
    source: ctx.source,
  });
  // CREATE INDEX IF NOT EXISTS (which needs a name) does nothing when the name is taken.
  return [objectEffect(node.if_not_exists === true ? { ...index, conditional: index.key } : index)];
}

function indexElems(params: Node[] | undefined): (IndexElem | undefined)[] {
  return (params ?? []).map((p) => ('IndexElem' in p ? p.IndexElem : undefined));
}
