/**
 * Small plain-text helpers shared by the tool-output formatters. Output is read by a model and
 * pasted by humans, so it stays ASCII, deterministic and column-aligned.
 */

/** `1 migration`, `3 migrations`. */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * Left-aligns columns with two spaces between them. The last column is never padded and trailing
 * spaces are trimmed, so a table pasted into a chat or a terminal does not wrap needlessly.
 */
export function formatTable(rows: readonly (readonly string[])[], indent = ''): string[] {
  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] ?? 0, cell.length);
    });
  }
  return rows.map((row) =>
    (
      indent +
      row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join('  ')
    ).trimEnd(),
  );
}
