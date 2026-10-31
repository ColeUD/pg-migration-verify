/**
 * What a statement handler returns. Handlers are pure: they look at one statement and describe
 * its effects; `NetEffect` (merge.ts) applies them in order to build the file's net result. Keeping
 * handlers free of shared state makes each one testable on its own and keeps the order-dependent
 * logic (merging, cascades, renames) in one place.
 */
import type { ExpectedObject, Note, SourceRef } from '../model.js';
import { objectKey, type ObjectIdentity } from '../keys.js';

export type Effect =
  /** The statement creates, alters or drops an object. */
  | { type: 'object'; object: ExpectedObject; cascade?: boolean }
  /** RENAME / SET SCHEMA: `from` becomes absent, `to` present, carrying what is known about `from`. */
  | { type: 'rename'; from: ExpectedObject; to: ExpectedObject; statementType: string }
  | { type: 'note'; note: Note }
  /** `SET search_path`: unqualified names in later statements resolve to `schema` (null = reset). */
  | { type: 'search_path'; schema: string | null };

/** Everything a handler needs to know about the statement it is looking at. */
export interface HandlerContext {
  /** Schema that unqualified names resolve to. */
  schema: string;
  source: SourceRef;
  /** libpg-query node name of the statement, used for notes. */
  statementType: string;
}

/**
 * Build an expected object with its key derived from its identity fields, so keys can never drift
 * from the fields they describe. Also used to re-key objects after a rename.
 */
export function keyed<T extends ExpectedObject>(fields: Omit<T, 'key'>): T {
  const identity = fields as unknown as ObjectIdentity;
  return { ...fields, key: objectKey(identity) } as T;
}

export function renameEffect(
  from: ExpectedObject,
  to: ExpectedObject,
  ctx: HandlerContext,
): Effect {
  return { type: 'rename', from, to, statementType: ctx.statementType };
}

export function objectEffect(object: ExpectedObject, cascade = false): Effect {
  return cascade ? { type: 'object', object, cascade } : { type: 'object', object };
}

export function noteEffect(
  ctx: HandlerContext,
  category: Note['category'],
  reason: string,
): Effect {
  return {
    type: 'note',
    note: { category, statementType: ctx.statementType, reason, source: ctx.source },
  };
}
