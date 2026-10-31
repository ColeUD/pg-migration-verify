/**
 * DO blocks. Supabase migrations often wrap DDL in `DO $$ BEGIN IF NOT EXISTS (...) THEN CREATE
 * TYPE ...; END IF; END $$` to make it re-runnable. The PL/pgSQL body is parsed (never run), and
 * every static SQL statement inside it is analyzed like a top-level one, flagged `inDoBlock`
 * because it may be conditional. Dynamic SQL (`EXECUTE format(...)`) cannot be known statically.
 */
import { parsePlPgSQLSync, parseSync, type DoStmt, type Node } from 'libpg-query';
import type { SourceRef } from '../model.js';
import { isRecord, stringValue } from './ast.js';
import { noteEffect, type Effect, type HandlerContext } from './effects.js';
import { excerpt } from './source.js';

/** Analyze one statement; supplied by the dispatcher so nested statements use the same handlers. */
export type StatementAnalyzer = (
  node: Node,
  ctx: { schema: string; source: SourceRef },
) => Effect[];

/** A step inside the block: static SQL text, or dynamic SQL that cannot be read. */
type Step = { kind: 'sql'; query: string } | { kind: 'dynamic' };

/** Statements that run SQL built at run time. */
const DYNAMIC_STATEMENTS = new Set(['PLpgSQL_stmt_dynexecute', 'PLpgSQL_stmt_dynfors']);

export function analyzeDoBlock(
  node: DoStmt,
  ctx: HandlerContext,
  analyze: StatementAnalyzer,
): Effect[] {
  const options = new Map(
    (node.args ?? []).flatMap((a) =>
      'DefElem' in a ? [[a.DefElem.defname ?? '', stringValue(a.DefElem.arg)] as const] : [],
    ),
  );
  const language = options.get('language') ?? 'plpgsql';
  const body = options.get('as');
  if (language !== 'plpgsql') {
    return [noteEffect(ctx, 'unverifiable', `DO blocks in language ${language} are not analyzed`)];
  }
  if (body === undefined) return [noteEffect(ctx, 'unverifiable', 'DO block has no body')];

  let steps: Step[];
  try {
    steps = collectSteps(parsePlPgSQLSync(wrapAsFunction(body)));
  } catch (error) {
    return [
      noteEffect(ctx, 'unverifiable', `DO block body could not be parsed: ${messageOf(error)}`),
    ];
  }

  const effects: Effect[] = [];
  let schema = ctx.schema;
  for (const step of steps) {
    if (step.kind === 'dynamic') {
      effects.push(
        noteEffect(ctx, 'unverifiable', 'dynamic SQL inside DO block (EXECUTE) cannot be checked'),
      );
      continue;
    }
    const source: SourceRef = { ...ctx.source, excerpt: excerpt(step.query), inDoBlock: true };
    let statements: Node[];
    try {
      statements = (parseSync(step.query).stmts ?? []).flatMap((s) => (s.stmt ? [s.stmt] : []));
    } catch (error) {
      effects.push(
        noteEffect(
          { ...ctx, source },
          'unverifiable',
          `statement inside DO block could not be parsed: ${messageOf(error)}`,
        ),
      );
      continue;
    }
    for (const statement of statements) {
      const inner = analyze(statement, { schema, source });
      for (const effect of inner) {
        // A SET search_path inside the block applies to the block's later statements too.
        if (effect.type === 'search_path') schema = effect.schema ?? ctx.schema;
      }
      effects.push(...inner);
    }
  }

  if (effects.length === 0) {
    effects.push(
      noteEffect(ctx, 'unverifiable', 'DO block contains no statements that can be checked'),
    );
  }
  return effects;
}

/**
 * libpg-query only parses PL/pgSQL as a function body, so the DO body is wrapped in a throwaway
 * function, quoted with a dollar tag that does not occur in the body.
 */
function wrapAsFunction(body: string): string {
  let tag = '$pmv$';
  for (let i = 1; body.includes(tag); i++) tag = `$pmv${i.toString()}$`;
  return `CREATE FUNCTION pg_temp.pmv_do() RETURNS void LANGUAGE plpgsql AS ${tag}${body}${tag}`;
}

/**
 * Walk the PL/pgSQL tree in source order and collect SQL statements. IF conditions and PERFORM are
 * expressions, not `PLpgSQL_stmt_execsql`, so existence checks are not mistaken for DDL.
 */
function collectSteps(tree: unknown): Step[] {
  const steps: Step[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'PLpgSQL_stmt_execsql') {
        const query = queryText(isRecord(child) ? child.sqlstmt : undefined);
        if (query !== undefined) steps.push({ kind: 'sql', query });
        continue;
      }
      if (DYNAMIC_STATEMENTS.has(key)) steps.push({ kind: 'dynamic' });
      visit(child);
    }
  };
  visit(tree);
  return steps;
}

/** `{ PLpgSQL_expr: { query } }` -> query */
function queryText(expr: unknown): string | undefined {
  if (!isRecord(expr) || !isRecord(expr.PLpgSQL_expr)) return undefined;
  const query = expr.PLpgSQL_expr.query;
  return typeof query === 'string' ? query : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
