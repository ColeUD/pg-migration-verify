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
