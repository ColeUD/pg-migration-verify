/**
 * Source text handling: statement boundaries, line numbers and excerpts.
 *
 * libpg-query reports positions as UTF-8 byte offsets, so all slicing goes through a Buffer;
 * slicing the JS string would be wrong as soon as a comment contains a non-ASCII character.
 */
import { hasSqlDetails, parseSync, scanSync, type Node, type ScanToken } from 'libpg-query';

const EXCERPT_MAX_LENGTH = 160;

/**
 * When a chunk between two semicolons does not parse, it may be a statement that legitimately
 * contains top-level semicolons (`BEGIN ATOMIC ... END` function bodies, multi-action rules). We
 * retry with up to this many following chunks appended before reporting a parse error.
 */
const MAX_CHUNKS_PER_STATEMENT = 20;

const COMMENT_TOKENS = new Set(['SQL_COMMENT', 'C_COMMENT']);
const SEMICOLON_TOKEN = 'ASCII_59';

/** A migration file's text with byte-offset based access. */
export class SourceText {
  readonly bytes: Buffer;
  /** Byte offset where each line starts; index 0 is line 1. */
  readonly #lineStarts: number[];

  constructor(sql: string) {
    this.bytes = Buffer.from(sql, 'utf8');
    this.#lineStarts = [0];
    for (let i = 0; i < this.bytes.length; i++) {
      if (this.bytes[i] === 0x0a) this.#lineStarts.push(i + 1);
    }
  }

  /** Text between two byte offsets. */
  slice(start: number, end: number): string {
    return this.bytes.subarray(start, end).toString('utf8');
  }

  /** 1-based line number of a byte offset. */
  lineAt(offset: number): number {
    let low = 0;
    let high = this.#lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((this.#lineStarts[mid] ?? 0) <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  }
}

/** Whitespace-collapsed statement text, truncated to about 160 characters. */
export function excerpt(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length <= EXCERPT_MAX_LENGTH
    ? collapsed
    : `${collapsed.slice(0, EXCERPT_MAX_LENGTH - 3)}...`;
}

/** One top-level statement located in the file: parsed, or the reason it could not be. */
export type RawStatement =
  | { kind: 'parsed'; node: Node; start: number; end: number }
  | { kind: 'error'; start: number; end: number; reason: string };

/**
 * Split a file into top-level statements. The whole file is parsed at once when possible. A single
 * syntax error makes libpg-query reject the whole file, so on failure the file is split on
 * top-level semicolons (from the lexer, so semicolons inside strings, comments and `$$` bodies do
 * not count) and each piece is parsed on its own: one broken statement must not hide the rest.
 */
export function splitStatements(source: SourceText): RawStatement[] {
  const sql = source.bytes.toString('utf8');
  if (sql.trim() === '') return [];
  try {
    return parsedStatements(parseSync(sql).stmts ?? [], 0, source.bytes.length);
  } catch {
    return splitOnSemicolons(source, sql);
  }
}

interface Chunk {
  /** Byte offset of the chunk's first token that is not a comment. */
  start: number;
  /** Byte offset just before the terminating semicolon (or end of file). */
  end: number;
}

function splitOnSemicolons(source: SourceText, sql: string): RawStatement[] {
  const chunks = chunksOf(sql, source.bytes.length);
  if (chunks === null) {
    // The lexer itself failed (e.g. an unterminated quote): nothing can be split reliably.
    const error = errorOf(() => parseSync(sql));
    return [
      {
        kind: 'error',
        start: 0,
        end: source.bytes.length,
        reason: describeError(error, source, 0),
      },
    ];
  }

  const statements: RawStatement[] = [];
  let i = 0;
  while (i < chunks.length) {
    const joined = parseJoinedChunks(source, chunks, i);
    if (joined !== null) {
      statements.push(...joined.statements);
      i = joined.next;
      continue;
    }
    const chunk = chunks[i] as Chunk;
    const error = errorOf(() => parseSync(source.slice(chunk.start, chunk.end)));
    statements.push({
      kind: 'error',
      start: chunk.start,
      end: chunk.end,
      reason: describeError(error, source, chunk.start),
    });
    i += 1;
  }
  return statements;
}

/**
 * Parse `chunks[first..j]` joined back together, for the smallest `j` that parses. Null when no
 * run starting at `first` parses: the chunk itself is broken.
 */
function parseJoinedChunks(
  source: SourceText,
  chunks: Chunk[],
  first: number,
): { statements: RawStatement[]; next: number } | null {
  const start = (chunks[first] as Chunk).start;
  const last = Math.min(chunks.length, first + MAX_CHUNKS_PER_STATEMENT) - 1;
  for (let j = first; j <= last; j++) {
    const end = (chunks[j] as Chunk).end;
    try {
      const stmts = parseSync(source.slice(start, end)).stmts ?? [];
      return { statements: parsedStatements(stmts, start, end), next: j + 1 };
    } catch {
      // A statement may contain top-level semicolons: retry with the next chunk appended.
    }
  }
  return null;
}

/** Pieces of the file between top-level semicolons, or null if the lexer rejects the file. */
function chunksOf(sql: string, length: number): Chunk[] | null {
  let tokens: ScanToken[];
  try {
    tokens = scanSync(sql).tokens;
  } catch {
    return null;
  }
  const chunks: Chunk[] = [];
  let current: Chunk | null = null;
  for (const token of tokens) {
    if (token.tokenName === SEMICOLON_TOKEN) {
      if (current !== null) chunks.push({ start: current.start, end: token.start });
      current = null;
    } else if (!COMMENT_TOKENS.has(token.tokenName)) {
      current ??= { start: token.start, end: token.end };
    }
  }
  if (current !== null) chunks.push({ start: current.start, end: length });
  return chunks;
}

/** Convert libpg-query's statement offsets (relative to `base`, 0 omitted) to absolute ones. */
function parsedStatements(
  stmts: { stmt?: Node; stmt_location?: number; stmt_len?: number }[],
  base: number,
  end: number,
): RawStatement[] {
  return stmts.flatMap((raw) => {
    if (raw.stmt === undefined) return [];
    const start = base + (raw.stmt_location ?? 0);
    const len = raw.stmt_len ?? 0;
    return [{ kind: 'parsed' as const, node: raw.stmt, start, end: len > 0 ? start + len : end }];
  });
}

function errorOf(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** libpg-query's message plus the line the error is on (its cursor counts characters, not bytes). */
function describeError(error: unknown, source: SourceText, base: number): string {
  const message = error instanceof Error ? error.message : 'could not be parsed';
  if (!hasSqlDetails(error) || error.sqlDetails === undefined) return message;
  // Postgres counts the cursor in characters (code points); string iteration yields code points.
  let line = source.lineAt(base);
  let remaining = error.sqlDetails.cursorPosition - 1;
  for (const char of source.slice(base, source.bytes.length)) {
    if (remaining-- <= 0) break;
    if (char === '\n') line++;
  }
  return `${message} (line ${line.toString()})`;
}
