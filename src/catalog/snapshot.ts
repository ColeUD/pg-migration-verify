import type { CatalogSnapshot } from '../model.js';
import type { ReadOnlyDatabase } from './db.js';
import {
  constraintType,
  decodeTriggerType,
  policyCommand,
  relationKind,
  typeKind,
} from './decode.js';
import {
  COLUMNS,
  CONSTRAINTS,
  ENUM_VALUES,
  EXTENSIONS,
  FUNCTIONS,
  INDEXES,
  POLICIES,
  RELATIONS,
  SCHEMAS,
  SERVER_VERSION,
  TRIGGERS,
  TYPES,
} from './queries.js';

/**
 * Reads what actually exists in `schemas` from pg_catalog, in one read-only transaction so every
 * part of the snapshot sees the same moment. `schemas` and `extensions` are listed database-wide
 * (a migration may create or drop a schema the caller did not ask about); everything else is
 * limited to the covered schemas.
 *
 * Needs no privileges beyond CONNECT: all reads are pg_catalog name joins.
 */
export async function loadCatalogSnapshot(
  db: ReadOnlyDatabase,
  schemas: readonly string[],
): Promise<CatalogSnapshot> {
  const covered = [...schemas];
  return db.readOnly(async (q) => {
    const [version] = await q.run(SERVER_VERSION);
    if (version === undefined) throw new Error('server_version_num returned no row');
    const schemaRows = await q.run(SCHEMAS);
    const extensions = await q.run(EXTENSIONS);
    const relations = await q.run(RELATIONS, [covered]);
    const columns = await q.run(COLUMNS, [covered]);
    const indexes = await q.run(INDEXES, [covered]);
    const constraints = await q.run(CONSTRAINTS, [covered]);
    const functions = await q.run(FUNCTIONS, [covered]);
    const triggers = await q.run(TRIGGERS, [covered]);
    const policies = await q.run(POLICIES, [covered]);
    const types = await q.run(TYPES, [covered]);
    const enumValues = await q.run(ENUM_VALUES, [covered]);

    return {
      serverVersionNum: version.version_num,
      coveredSchemas: covered,
      schemas: schemaRows.map((r) => r.name),
      extensions: extensions.map((r) => ({ name: r.name, schema: r.schema })),
      relations: relations.map((r) => ({
        schema: r.schema,
        name: r.name,
        kind: relationKind(r.relkind),
        rlsEnabled: r.rls_enabled,
        rlsForced: r.rls_forced,
      })),
      columns: columns.map((r) => ({
        schema: r.schema,
        table: r.table_name,
        name: r.name,
        dataType: r.data_type,
        notNull: r.not_null,
      })),
      indexes: indexes.map((r) => ({
        schema: r.schema,
        table: r.table_name,
        name: r.name,
        unique: r.is_unique,
        primary: r.is_primary,
        method: r.method,
        columns: r.columns,
      })),
      constraints: constraints.map((r) => ({
        schema: r.schema,
        table: r.table_name,
        name: r.name,
        type: constraintType(r.contype),
        columns: r.columns,
        references:
          r.ref_schema !== null && r.ref_table !== null
            ? { schema: r.ref_schema, table: r.ref_table, columns: r.ref_columns }
            : null,
      })),
      functions: functions.map((r) => ({
        schema: r.schema,
        name: r.name,
        argTypes: r.arg_types,
        isProcedure: r.prokind === 'p',
      })),
      triggers: triggers.map((r) => ({
        schema: r.schema,
        table: r.table_name,
        name: r.name,
        ...decodeTriggerType(r.tgtype),
        function: { schema: r.function_schema, name: r.function_name },
      })),
      policies: policies.map((r) => ({
        schema: r.schema,
        table: r.table_name,
        name: r.name,
        command: policyCommand(r.polcmd),
        permissive: r.permissive,
        // Sorted here, not in SQL, so the order is code-point order whatever the collation.
        roles: [...r.roles].sort(),
      })),
      types: types.map((r) => ({ schema: r.schema, name: r.name, typeKind: typeKind(r.typtype) })),
      enumValues: enumValues.map((r) => ({
        schema: r.schema,
        typeName: r.type_name,
        value: r.value,
      })),
    };
  });
}
