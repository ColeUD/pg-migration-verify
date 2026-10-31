/** CREATE [OR REPLACE] [CONSTRAINT] TRIGGER. */
import type { CreateTrigStmt } from 'libpg-query';
import type { TriggerEvent, TriggerObject } from '../../model.js';
import { stringValues } from '../ast.js';
import { keyed, objectEffect, type Effect, type HandlerContext } from '../effects.js';
import { relationName } from '../names.js';

/** `TRIGGER_TYPE_*` bits from Postgres' `pg_trigger.h`, in the order events are reported. */
const EVENT_BITS: readonly [TriggerEvent, number][] = [
  ['INSERT', 4],
  ['UPDATE', 16],
  ['DELETE', 8],
  ['TRUNCATE', 32],
];
const TIMING_BEFORE = 2;
const TIMING_INSTEAD = 64;

export function handleCreateTrigger(node: CreateTrigStmt, ctx: HandlerContext): Effect[] {
  // A trigger lives in its table's schema.
  const table = relationName(node.relation, ctx.schema);
  const timingBits = node.timing ?? 0;
  const eventBits = node.events ?? 0;
  const fn = stringValues(node.funcname);
  return [
    objectEffect(
      keyed<TriggerObject>({
        kind: 'trigger',
        expect: 'present',
        schema: table.schema,
        table: table.name,
        name: node.trigname ?? '',
        // Protobuf omits 0, which is AFTER.
        timing:
          (timingBits & TIMING_BEFORE) !== 0
            ? 'BEFORE'
            : (timingBits & TIMING_INSTEAD) !== 0
              ? 'INSTEAD OF'
              : 'AFTER',
        events: EVENT_BITS.filter(([, bit]) => (eventBits & bit) !== 0).map(([event]) => event),
        forEachRow: node.row ?? false,
        function: { schema: fn.length > 1 ? (fn.at(-2) ?? null) : null, name: fn.at(-1) ?? '' },
        source: ctx.source,
      }),
    ),
  ];
}
