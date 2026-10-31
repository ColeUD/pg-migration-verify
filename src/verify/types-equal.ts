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

/**
 * Split `schema.rest`, where `schema` is a leading identifier (bare or double-quoted) directly
 * followed by a dot. Parsing the identifier instead of splitting on the first dot keeps quoted
 * names such as `"my.type"[]` intact, and leaves multi-word names like `double precision` alone.
 */
export function splitSchemaQualifier(type: string): { schema: string | null; rest: string } {
  const end = leadingIdentifierEnd(type);
  if (end > 0 && type[end] === '.') {
    return { schema: type.slice(0, end), rest: type.slice(end + 1) };
  }
  return { schema: null, rest: type };
}

/** Length of the identifier at the start of `text`, or 0 when there is none. */
function leadingIdentifierEnd(text: string): number {
  if (!text.startsWith('"')) {
    return /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text)?.[0].length ?? 0;
  }
  let i = 1;
  while (i < text.length) {
    if (text[i] === '"') {
      // A doubled quote is an escaped quote inside the identifier.
      if (text[i + 1] !== '"') return i + 1;
      i += 2;
    } else {
      i += 1;
    }
  }
  return 0; // unterminated quote: not an identifier
}
