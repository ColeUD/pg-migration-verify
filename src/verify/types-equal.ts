import { splitSchemaQualifier } from '../sql-ident.js';

/**
 * Whether a type name written in a migration denotes the type the catalog reports.
 *
 * The catalog prints user-defined types schema-qualified (it is read with `search_path = ''`),
 * while migrations usually write them bare and rely on the search path. Which schema a bare name
 * resolved to cannot be known from the SQL alone, so a bare expected name matches the same type in
 * any schema: `job_status` matches `public.job_status`, and `citext` matches `extensions.citext`
 * (Supabase installs extensions into the `extensions` schema). A qualified expected name must match
 * exactly.
 */
export function typesEqual(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  if (splitSchemaQualifier(expected).schema !== null) return false;
  return splitSchemaQualifier(actual).rest === expected;
}

/** Element-wise {@link typesEqual} for argument lists. */
export function typeListsEqual(expected: readonly string[], actual: readonly string[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((type, i) => typesEqual(type, actual[i] ?? ''))
  );
}
