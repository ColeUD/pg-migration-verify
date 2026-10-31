import { describeObject } from '../keys.js';
import type { ExpectedObject, FkAction } from '../model.js';
import { qualifiedName } from '../sql-ident.js';
import {
  columnListText,
  constraintTypeText,
  eventsText,
  fkActionText,
  functionRefText,
  nullabilityText,
  referencesText,
  rlsEnabledText,
  rlsForcedText,
  rolesText,
  triggerLevelText,
} from './attributes.js';

/**
 * `describeObject()` plus the asserted attributes in compact form, e.g.
 * `column public.todos.due_date (date, nullable)` or
 * `policy "owners read" on public.todos (for SELECT, to authenticated)`.
 * Used where the reader needs to know what was expected, not just which object: MISSING lines
 * and the expected-objects listing.
 */
export function describeExpected(o: ExpectedObject): string {
  const attributes = expectedAttributes(o);
  return attributes.length === 0
    ? describeObject(o)
    : `${describeObject(o)} (${attributes.join(', ')})`;
}

/** Attributes not already part of `describeObject()`; null (unasserted) ones are left out. */
function expectedAttributes(o: ExpectedObject): string[] {
  switch (o.kind) {
    case 'column':
      return present([o.dataType, o.notNull === null ? null : nullabilityText(o.notNull)]);
    case 'index':
      return present([
        // An unnamed index is described by its table and columns already.
        o.name === null
          ? null
          : phrase([
              o.table === '' ? null : `on ${qualifiedName(o.schema, o.table)}`,
              o.columns === null ? null : columnListText(o.columns),
            ]),
        o.unique === true ? 'unique' : null,
        o.method === null ? null : `using ${o.method}`,
      ]);
    case 'constraint':
      return present([
        // An unnamed constraint is described by its type and columns already.
        o.name === null
          ? null
          : phrase([
              o.constraintType === null ? null : constraintTypeText(o.constraintType),
              o.columns === null ? null : columnListText(o.columns),
            ]),
        o.references === null ? null : `references ${referencesText(o.references)}`,
        // NO ACTION is the default; only a chosen action is worth reading.
        actionText('on delete', o.references?.onDelete ?? null),
        actionText('on update', o.references?.onUpdate ?? null),
      ]);
    case 'trigger':
      return present([
        phrase([o.timing, o.events === null ? null : eventsText(o.events)]),
        o.forEachRow === null ? null : `for each ${triggerLevelText(o.forEachRow)}`,
        o.function === null ? null : `executes ${functionRefText(o.function)}`,
      ]);
    case 'rls':
      return present([
        o.enabled === null ? null : rlsEnabledText(o.enabled),
        o.forced === null ? null : rlsForcedText(o.forced),
      ]);
    case 'policy':
      return present([
        o.permissive === false ? 'restrictive' : null,
        o.command === null ? null : `for ${o.command}`,
        // Last, so the comma-separated role list cannot be confused with the other attributes.
        o.roles === null ? null : `to ${rolesText(o.roles)}`,
      ]);
    case 'type':
      // describeObject() already says "enum type".
      return present([o.typeKind === null || o.typeKind === 'enum' ? null : o.typeKind]);
    default:
      return [];
  }
}

function present(parts: (string | null)[]): string[] {
  return parts.filter((p): p is string => p !== null);
}

/** Space-joined asserted parts, e.g. `BEFORE INSERT OR UPDATE`; null when none is asserted. */
function phrase(parts: (string | null)[]): string | null {
  const words = present(parts);
  return words.length === 0 ? null : words.join(' ');
}

function actionText(clause: string, action: FkAction | null): string | null {
  return action === null || action === 'no_action' ? null : `${clause} ${fkActionText(action)}`;
}
