import type {
  ColumnObject,
  ConstraintObject,
  ConstraintType,
  Difference,
  ExpectedObject,
  FunctionObject,
  IndexObject,
  PolicyObject,
  RelationObject,
  RlsObject,
  TriggerObject,
  TypeObject,
} from '../model.js';
import { quoteIdent } from '../sql-ident.js';
import {
  ATTRIBUTE_LABELS,
  columnListText,
  fkActionText,
  constraintTypeText,
  eventsText,
  functionRefText,
  nullabilityText,
  permissiveText,
  referencesText,
  relationKindText,
  rlsEnabledText,
  rlsForcedText,
  rolesText,
  sortEvents,
  triggerLevelText,
} from './attributes.js';
import type {
  CatalogConstraint,
  CatalogFunction,
  CatalogIndex,
  CatalogRelation,
  SnapshotIndex,
} from './snapshot-index.js';
import { typeListsEqual, typesEqual } from './types-equal.js';

/** The result of comparing one effective expectation with the catalog. */
export interface Comparison {
  status: 'match' | 'missing' | 'different' | 'unexpected';
  differences: Difference[];
  /** Diagnostic hints, e.g. other overloads of a missing function. */
  notes: string[];
}

/**
 * Compare one expectation with the catalog. Attributes that are null in the expectation were not
 * asserted by any migration and are not compared.
 *
 * Throws when the object's schema is not covered by the snapshot: absence there would prove
 * nothing, and reporting `missing` would be a false alarm. Callers load `requiredSchemas()`.
 */
export function compareObject(o: ExpectedObject, catalog: SnapshotIndex): Comparison {
  // Extensions are database-wide and looked up by name only.
  if (o.kind !== 'extension' && !catalog.covers(o.schema)) {
    throw new Error(
      `Schema "${o.schema}" is not covered by the catalog snapshot (needed for ${o.key}); ` +
        'load every schema returned by requiredSchemas().',
    );
  }
  if (o.expect === 'absent') {
    return result(exists(o, catalog) ? 'unexpected' : 'match');
  }
  return comparePresent(o, catalog);
}

function comparePresent(o: ExpectedObject, catalog: SnapshotIndex): Comparison {
  switch (o.kind) {
    case 'schema':
      return result(catalog.hasSchema(o.name) ? 'match' : 'missing');
    case 'extension':
      return result(catalog.hasExtension(o.name) ? 'match' : 'missing');
    case 'table':
    case 'view':
    case 'materialized_view':
    case 'sequence':
      return compareRelation(o, catalog);
    case 'column':
      return compareColumn(o, catalog);
    case 'index':
      return compareIndex(o, catalog);
    case 'constraint':
      return compareConstraint(o, catalog);
    case 'function':
      return compareFunction(o, catalog);
    case 'trigger':
      return compareTrigger(o, catalog);
    case 'rls':
      return compareRls(o, catalog);
    case 'policy':
      return comparePolicy(o, catalog);
    case 'type':
      return compareType(o, catalog);
    case 'enum_value':
      return result(catalog.hasEnumValue(o.schema, o.typeName, o.value) ? 'match' : 'missing');
  }
}

function compareRelation(o: RelationObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.relation(o.schema, o.name);
  if (found === undefined) return result('missing');
  return compared(
    relationKindMatches(o.kind, found.kind)
      ? []
      : [diff('kind', relationKindText(o.kind), relationKindText(found.kind))],
  );
}

function compareColumn(o: ColumnObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.column(o.schema, o.table, o.name);
  if (found === undefined) return result('missing');
  const differences: Difference[] = [];
  if (o.dataType !== null && !typesEqual(o.dataType, found.dataType)) {
    differences.push(diff(ATTRIBUTE_LABELS.dataType, o.dataType, found.dataType));
  }
  if (o.notNull !== null && o.notNull !== found.notNull) {
    differences.push(
      diff(ATTRIBUTE_LABELS.notNull, nullabilityText(o.notNull), nullabilityText(found.notNull)),
    );
  }
  return compared(differences);
}

function compareIndex(o: IndexObject, catalog: SnapshotIndex): Comparison {
  if (o.name !== null) {
    const found = catalog.index(o.schema, o.name);
    if (found === undefined) return result('missing');
    const differences = indexDifferences(o, found);
    // An empty table means the migration did not say (ALTER INDEX ... RENAME): nothing to compare.
    if (o.table !== '' && found.table !== o.table) {
      differences.unshift(diff('table', o.table, found.table));
    }
    return compared(differences);
  }
  // Unnamed: Postgres picked the name, so any index on the table with the same key columns counts.
  const sameColumns = catalog
    .indexesOn(o.schema, o.table)
    .filter((idx) => o.columns === null || indexColumnsMatch(o.columns, idx.columns));
  if (sameColumns.some((idx) => indexDifferences(o, idx).length === 0)) return result('match');
  const closest = sameColumns[0];
  return closest === undefined ? result('missing') : compared(indexDifferences(o, closest));
}

/** Differences in the attributes an index is not identified by (the table is checked apart). */
function indexDifferences(o: IndexObject, found: CatalogIndex): Difference[] {
  const differences: Difference[] = [];
  if (o.unique !== null && o.unique !== found.unique) {
    differences.push(diff(ATTRIBUTE_LABELS.unique, String(o.unique), String(found.unique)));
  }
  if (o.method !== null && o.method !== found.method) {
    differences.push(diff(ATTRIBUTE_LABELS.method, o.method, found.method));
  }
  if (o.columns !== null && !indexColumnsMatch(o.columns, found.columns)) {
    differences.push(
      diff(ATTRIBUTE_LABELS.columns, columnListText(o.columns), columnListText(found.columns)),
    );
  }
  return differences;
}

/**
 * Expression key columns (`(lower(email))`) are deparsed differently by the parser and by
 * `pg_get_indexdef`, so they only need to be expressions on both sides; plain columns must match.
 */
function indexColumnsMatch(expected: readonly string[], actual: readonly string[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((column, i) => {
      const other = actual[i] ?? '';
      return isExpression(column) ? isExpression(other) : column === other;
    })
  );
}

function isExpression(column: string): boolean {
  return column.startsWith('(');
}

function compareConstraint(o: ConstraintObject, catalog: SnapshotIndex): Comparison {
  if (o.name !== null) {
    const found = catalog.constraint(o.schema, o.table, o.name);
    if (found === undefined) return result('missing');
    const differences: Difference[] = [];
    if (o.constraintType !== null && o.constraintType !== found.type) {
      differences.push(
        diff(
          ATTRIBUTE_LABELS.constraintType,
          constraintTypeText(o.constraintType),
          constraintTypeText(found.type),
        ),
      );
    }
    return compared([...differences, ...constraintShapeDifferences(o, found)]);
  }
  // Unnamed: any constraint of the same type on the same columns counts.
  const sameShape = catalog
    .constraintsOn(o.schema, o.table)
    .filter(
      (c) =>
        (o.constraintType === null || o.constraintType === c.type) &&
        (o.columns === null || constraintColumnsMatch(c.type, o.columns, c.columns)),
    );
  if (sameShape.some((c) => constraintShapeDifferences(o, c).length === 0)) {
    return result('match');
  }
  const closest = sameShape[0];
  return closest === undefined
    ? result('missing')
    : compared(constraintShapeDifferences(o, closest));
}

function constraintShapeDifferences(o: ConstraintObject, found: CatalogConstraint): Difference[] {
  const differences: Difference[] = [];
  if (o.columns !== null && !constraintColumnsMatch(found.type, o.columns, found.columns)) {
    differences.push(
      diff(ATTRIBUTE_LABELS.columns, columnListText(o.columns), columnListText(found.columns)),
    );
  }
  if (o.references !== null && !referencesMatch(o.references, found.references)) {
    differences.push(
      diff(
        ATTRIBUTE_LABELS.references,
        referencesText(o.references),
        found.references === null ? 'none' : referencesText(found.references),
      ),
    );
  } else if (o.references !== null) {
    differences.push(...actionDifferences(o.references, found.references));
  }
  return differences;
}

/**
 * Key order matters for primary keys, unique and foreign keys (it decides index order and column
 * pairing). For a check constraint the columns are just those its expression mentions.
 */
function constraintColumnsMatch(
  type: ConstraintType,
  expected: readonly string[],
  actual: readonly string[],
): boolean {
  if (type === 'check') {
    const set = new Set(actual);
    return new Set(expected).size === set.size && expected.every((c) => set.has(c));
  }
  return sameList(expected, actual);
}

/** ON DELETE / ON UPDATE of a foreign key, where the expectation asserts them. */
function actionDifferences(
  expected: NonNullable<ConstraintObject['references']>,
  actual: CatalogConstraint['references'],
): Difference[] {
  if (actual === null) return [];
  const differences: Difference[] = [];
  if (expected.onDelete !== null && expected.onDelete !== actual.onDelete) {
    differences.push(
      diff('on delete', fkActionText(expected.onDelete), fkActionText(actual.onDelete)),
    );
  }
  if (expected.onUpdate !== null && expected.onUpdate !== actual.onUpdate) {
    differences.push(
      diff('on update', fkActionText(expected.onUpdate), fkActionText(actual.onUpdate)),
    );
  }
  return differences;
}

function referencesMatch(
  expected: NonNullable<ConstraintObject['references']>,
  actual: CatalogConstraint['references'],
): boolean {
  return (
    actual !== null &&
    expected.schema === actual.schema &&
    expected.table === actual.table &&
    (expected.columns === null || sameList(expected.columns, actual.columns))
  );
}

function compareFunction(o: FunctionObject, catalog: SnapshotIndex): Comparison {
  const overloads = catalog.functions(o.schema, o.name);
  const found = overloads.find((f) => functionMatches(o, f));
  if (found === undefined) {
    // A changed signature leaves the old overload behind: naming it makes the cause obvious.
    const notes =
      overloads.length === 0
        ? []
        : [`found other signatures: ${overloads.map(signatureText).sort().join(', ')}`];
    return { status: 'missing', differences: [], notes };
  }
  return compared(
    o.isProcedure === found.isProcedure
      ? []
      : [
          diff(
            ATTRIBUTE_LABELS.isProcedure,
            routineKind(o.isProcedure),
            routineKind(found.isProcedure),
          ),
        ],
  );
}

/** argTypes null (`DROP FUNCTION f` without a list) stands for every overload. */
function functionMatches(o: FunctionObject, f: CatalogFunction): boolean {
  return o.argTypes === null || typeListsEqual(o.argTypes, f.argTypes);
}

function signatureText(f: CatalogFunction): string {
  return `${quoteIdent(f.name)}(${f.argTypes.join(', ')})`;
}

function routineKind(isProcedure: boolean): string {
  return isProcedure ? 'procedure' : 'function';
}

function compareTrigger(o: TriggerObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.trigger(o.schema, o.table, o.name);
  if (found === undefined) return result('missing');
  const differences: Difference[] = [];
  if (o.timing !== null && o.timing !== found.timing) {
    differences.push(diff(ATTRIBUTE_LABELS.timing, o.timing, found.timing));
  }
  if (o.events !== null && !sameList(sortEvents(o.events), sortEvents(found.events))) {
    differences.push(diff(ATTRIBUTE_LABELS.events, eventsText(o.events), eventsText(found.events)));
  }
  if (o.forEachRow !== null && o.forEachRow !== found.forEachRow) {
    differences.push(
      diff(
        ATTRIBUTE_LABELS.forEachRow,
        triggerLevelText(o.forEachRow),
        triggerLevelText(found.forEachRow),
      ),
    );
  }
  // An unqualified function name resolved through the search path, so any schema matches.
  if (
    o.function !== null &&
    (o.function.name !== found.function.name ||
      (o.function.schema !== null && o.function.schema !== found.function.schema))
  ) {
    differences.push(
      diff(ATTRIBUTE_LABELS.function, functionRefText(o.function), functionRefText(found.function)),
    );
  }
  return compared(differences);
}

function compareRls(o: RlsObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.relation(o.schema, o.table);
  if (found === undefined) return result('missing');
  const differences: Difference[] = [];
  if (o.enabled !== null && o.enabled !== found.rlsEnabled) {
    differences.push(
      diff(ATTRIBUTE_LABELS.enabled, rlsEnabledText(o.enabled), rlsEnabledText(found.rlsEnabled)),
    );
  }
  if (o.forced !== null && o.forced !== found.rlsForced) {
    differences.push(
      diff(ATTRIBUTE_LABELS.forced, rlsForcedText(o.forced), rlsForcedText(found.rlsForced)),
    );
  }
  return compared(differences);
}

function comparePolicy(o: PolicyObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.policy(o.schema, o.table, o.name);
  if (found === undefined) return result('missing');
  const differences: Difference[] = [];
  if (o.command !== null && o.command !== found.command) {
    differences.push(diff(ATTRIBUTE_LABELS.command, o.command, found.command));
  }
  if (o.permissive !== null && o.permissive !== found.permissive) {
    differences.push(
      diff(
        ATTRIBUTE_LABELS.permissive,
        permissiveText(o.permissive),
        permissiveText(found.permissive),
      ),
    );
  }
  if (o.roles !== null && rolesText(o.roles) !== rolesText(found.roles)) {
    differences.push(diff(ATTRIBUTE_LABELS.roles, rolesText(o.roles), rolesText(found.roles)));
  }
  return compared(differences);
}

function compareType(o: TypeObject, catalog: SnapshotIndex): Comparison {
  const found = catalog.type(o.schema, o.name);
  if (found === undefined) return result('missing');
  return compared(
    o.typeKind === null || o.typeKind === found.typeKind
      ? []
      : [diff(ATTRIBUTE_LABELS.typeKind, o.typeKind, found.typeKind)],
  );
}

/** Whether something matching an `absent` expectation still exists. */
function exists(o: ExpectedObject, catalog: SnapshotIndex): boolean {
  switch (o.kind) {
    case 'schema':
      return catalog.hasSchema(o.name);
    case 'extension':
      return catalog.hasExtension(o.name);
    case 'table':
    case 'view':
    case 'materialized_view':
    case 'sequence': {
      const found = catalog.relation(o.schema, o.name);
      return found !== undefined && relationKindMatches(o.kind, found.kind);
    }
    case 'column':
      return catalog.column(o.schema, o.table, o.name) !== undefined;
    case 'index':
      return o.name !== null
        ? catalog.index(o.schema, o.name) !== undefined
        : compareIndex(o, catalog).status === 'match';
    case 'constraint':
      return o.name !== null
        ? catalog.constraint(o.schema, o.table, o.name) !== undefined
        : compareConstraint(o, catalog).status === 'match';
    case 'function':
      return catalog.functions(o.schema, o.name).some((f) => functionMatches(o, f));
    case 'trigger':
      return catalog.trigger(o.schema, o.table, o.name) !== undefined;
    case 'rls':
      return catalog.relation(o.schema, o.table)?.rlsEnabled ?? false;
    case 'policy':
      return catalog.policy(o.schema, o.table, o.name) !== undefined;
    case 'type':
      return catalog.type(o.schema, o.name) !== undefined;
    case 'enum_value':
      return catalog.hasEnumValue(o.schema, o.typeName, o.value);
  }
}

/** A partitioned table is still a table as far as a migration's CREATE TABLE is concerned. */
function relationKindMatches(expected: RelationObject['kind'], actual: CatalogRelation['kind']) {
  return expected === actual || (expected === 'table' && actual === 'partitioned_table');
}

function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function diff(attribute: string, expected: string, actual: string): Difference {
  return { attribute, expected, actual };
}

function result(status: Comparison['status']): Comparison {
  return { status, differences: [], notes: [] };
}

/** The object exists: it matches unless an asserted attribute differs. */
function compared(differences: Difference[]): Comparison {
  return { status: differences.length === 0 ? 'match' : 'different', differences, notes: [] };
}
