/**
 * Quote an identifier the way Postgres' `quote_ident()` / `format_type()` would print it:
 * bare when it is a plain lower-case identifier, double-quoted (with embedded quotes doubled)
 * otherwise. Keyword quoting is not reproduced; names that are reserved words are rare in
 * migrations and both sides of a comparison go through the same function.
 */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_$]*$/.test(name) ? name : `"${name.replaceAll('"', '""')}"`;
}

/** `schema.name` with each part quoted as needed. */
export function qualifiedName(schema: string | null, name: string): string {
  return schema === null ? quoteIdent(name) : `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * An index or constraint key column for display: plain column names quoted like `quoteIdent()`,
 * expressions (which the model stores as SQL wrapped in parentheses) left as they are.
 */
export function quoteKeyColumn(column: string): string {
  return column.startsWith('(') ? column : quoteIdent(column);
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
