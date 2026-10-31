/**
 * Plain-text rendering of verification results. The output is what an assistant reads and quotes
 * back to the user, so it is deterministic (no colors, timestamps or locale formatting), ASCII only,
 * and leads with problems: a report of a healthy migration is two lines long.
 */
import { describeObject } from '../keys.js';
import type {
  CheckStatus,
  MigrationReport,
  MigrationVerdict,
  Note,
  ObjectCheck,
  ObjectKind,
  ParsedMigration,
  SourceRef,
} from '../model.js';
import { formatTable, plural } from '../text.js';
import { describeExpected } from './describe.js';

export interface ReportFormatOptions {
  /** Also list matching objects and ignored statements. */
  verbose?: boolean;
  /** History table name (e.g. `supabase_migrations.schema_migrations`) for the history line. */
  historyTable?: string;
}

/**
 * One migration's report, e.g.
 *
 * ```text
 * MISMATCH 2/4  20240102000000_add_todos.sql
 *   MISSING      line 7   column public.todos.due_date (date, nullable)
 *   DIFFERENT    line 12  index public.todos_owner_idx: unique expected true, found false
 *   SUPERSEDED   line 3   table public.tmp_import (and 2 columns): dropped by 20240301000000_x.sql line 3
 *   UNVERIFIABLE line 25  GrantStmt: privileges are not checked
 *   history: NOT recorded
 * ```
 *
 * Problems come first (missing, different, unexpected), then what could not be checked; within a
 * group lines follow the file. Line numbers refer to this migration's file. Objects superseded
 * along with their table (or type, or schema) share its line, unless `verbose`.
 */
export function formatMigrationReport(
  report: MigrationReport,
  options: ReportFormatOptions = {},
): string {
  const verbose = options.verbose ?? false;
  const shown = report.checks.filter((c) => verbose || c.status !== 'match');
  const rows: Row[] = [
    ...(verbose ? shown.map((c) => checkRow(c)) : groupSuperseded(shown)),
    ...report.notes.filter((n) => verbose || n.category !== 'ignored').map((n) => noteRow(n)),
  ];
  rows.sort((a, b) => a.rank - b.rank || a.line - b.line);
  return [
    `${verdictHeader(report)}  ${report.file}`,
    ...renderRows(rows, columnWidths(rows)),
    ...(lacksEvidence(report) ? [`  evidence: ${NO_EVIDENCE}`] : []),
    `  history: ${historyText(report.recorded, options.historyTable)}`,
  ].join('\n');
}

const NO_EVIDENCE =
  'none, every check would also hold had this file never run, so this MATCH does not show ' +
  'that it was applied';

/**
 * A MATCH that does not show the file ran, where that matters: the history does not confirm it.
 * Drops, policies re-created with the same command and roles, CREATE OR REPLACE FUNCTION and
 * columns added back as an earlier migration defined them all hold before the file runs.
 */
function lacksEvidence(report: MigrationReport): boolean {
  return report.verdict === 'MATCH' && report.evidence === 0 && report.recorded !== true;
}

/**
 * An aligned table with one line per migration, then totals. The totals call out the two cases
 * this tool exists for: migrations whose objects are all there but which the history table does
 * not know about (applied by hand, e.g. in the SQL editor), and migrations the history table
 * claims were applied whose objects are not all there.
 */
export function formatSummary(reports: readonly MigrationReport[]): string {
  if (reports.length === 0) return 'No migrations.';
  const header = ['VERSION', 'NAME', 'RESULT', 'MATCHED', 'SUPERSEDED', 'UNVERIFIABLE', 'HISTORY'];
  const body = reports.map((r) => [
    r.version,
    r.name,
    lacksEvidence(r) ? `${VERDICT_TEXT[r.verdict]}*` : VERDICT_TEXT[r.verdict],
    r.verdict === 'NOTHING_TO_VERIFY' ? '-' : `${r.matched}/${r.checked}`,
    String(r.checks.filter((c) => c.status === 'superseded').length),
    String(r.notes.filter((n) => n.category === 'unverifiable').length),
    r.recorded === null ? '-' : r.recorded ? 'recorded' : 'NOT RECORDED',
  ]);
  return [...formatTable([header, ...body]), '', ...totals(reports)].join('\n');
}

/**
 * What the parser expects a migration to do, grouped by kind (in dependency order), then the
 * statements it could not or did not turn into checks. Lets a user see why a report says what it
 * says, and spot statements the parser misunderstood.
 */
export function formatExpectedObjects(parsed: ParsedMigration): string {
  const header =
    `${parsed.file}: ${plural(parsed.statementCount, 'statement')}, ` +
    `${plural(parsed.objects.length, 'expected object')}, ${plural(parsed.notes.length, 'note')}`;
  const sections: { title: string; rows: Row[] }[] = [];
  for (const [kind, title] of Object.entries(KIND_TITLES) as [ObjectKind, string][]) {
    const objects = parsed.objects.filter((o) => o.kind === kind);
    if (objects.length === 0) continue;
    sections.push({
      title: `${title} (${objects.length})`,
      rows: objects.map((o) => row(o.expect, 0, o.source, describeExpected(o))),
    });
  }
  if (parsed.notes.length > 0) {
    sections.push({
      title: `Notes (${parsed.notes.length})`,
      rows: parsed.notes.map((n) => row(n.category, 0, n.source, noteText(n))),
    });
  }
  // One set of column widths for the whole listing keeps every section aligned.
  const widths = columnWidths(sections.flatMap((s) => s.rows));
  return [
    header,
    ...sections.flatMap((s) => [
      '',
      s.title,
      ...renderRows(
        [...s.rows].sort((a, b) => a.line - b.line),
        widths,
      ),
    ]),
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------

interface Row {
  label: string;
  /** Sort group: problems first. */
  rank: number;
  line: number;
  text: string;
  /** Continuation lines shown under the row. */
  notes: readonly string[];
}

interface Widths {
  label: number;
  line: number;
}

/** Order of report lines; `match` is only shown in verbose mode, after everything else. */
const CHECK_RANK: Record<CheckStatus, number> = {
  missing: 0,
  different: 1,
  unexpected: 2,
  superseded: 3,
  match: 5,
};
const NOTE_RANK: Record<Note['category'], number> = { unverifiable: 4, ignored: 6 };

const VERDICT_TEXT: Record<MigrationVerdict, string> = {
  MATCH: 'MATCH',
  MISMATCH: 'MISMATCH',
  NOTHING_TO_VERIFY: 'NOTHING TO VERIFY',
};

/** Listing order: things other objects depend on come first. */
const KIND_TITLES: Record<ObjectKind, string> = {
  schema: 'Schemas',
  extension: 'Extensions',
  type: 'Types',
  enum_value: 'Enum values',
  table: 'Tables',
  view: 'Views',
  materialized_view: 'Materialized views',
  sequence: 'Sequences',
  column: 'Columns',
  index: 'Indexes',
  constraint: 'Constraints',
  function: 'Functions',
  trigger: 'Triggers',
  rls: 'Row level security',
  policy: 'Policies',
};

function checkRow(c: ObjectCheck): Row {
  return row(c.status.toUpperCase(), CHECK_RANK[c.status], c.object.source, checkText(c), c.notes);
}

/**
 * Rows for checks, where a superseded object whose cause is in this report (a dropped table)
 * stands for every object superseded with it (its columns, constraints and indexes), which would
 * otherwise repeat the same reason line after line.
 */
function groupSuperseded(checks: readonly ObjectCheck[]): Row[] {
  const groupOf = (c: ObjectCheck & { status: 'superseded' }): string =>
    `${c.supersededBy.file}|${c.supersededBy.byKey}`;
  const groups = new Map<string, ObjectCheck[]>();
  for (const c of checks) {
    if (c.status === 'superseded') groups.set(groupOf(c), [...(groups.get(groupOf(c)) ?? []), c]);
  }
  const rows: Row[] = [];
  for (const c of checks) {
    if (c.status !== 'superseded') {
      rows.push(checkRow(c));
      continue;
    }
    const group = groups.get(groupOf(c)) ?? [];
    const cause = group.find((g) => g.object.key === c.supersededBy.byKey);
    if (cause === undefined) {
      rows.push(checkRow(c));
    } else if (cause === c) {
      const others = group.filter((g) => g !== c).map((g) => g.object.kind);
      const text = `${describeObject(c.object)}${othersText(others)}: ${c.supersededBy.reason}`;
      rows.push(row('SUPERSEDED', CHECK_RANK.superseded, c.object.source, text, c.notes));
    }
  }
  return rows;
}

/** ` (and 5 columns, 1 constraint, 1 index)`, kinds in listing order. */
function othersText(kinds: readonly ObjectKind[]): string {
  if (kinds.length === 0) return '';
  const parts = (Object.keys(KIND_TITLES) as ObjectKind[]).flatMap((kind) => {
    const count = kinds.filter((k) => k === kind).length;
    const [singular, pluralNoun] = KIND_NOUNS[kind];
    return count === 0 ? [] : [`${count} ${count === 1 ? singular : pluralNoun}`];
  });
  return ` (and ${parts.join(', ')})`;
}

/** Singular and plural nouns for counting objects of a kind. */
const KIND_NOUNS: Record<ObjectKind, readonly [string, string]> = {
  schema: ['schema', 'schemas'],
  extension: ['extension', 'extensions'],
  type: ['type', 'types'],
  enum_value: ['enum value', 'enum values'],
  table: ['table', 'tables'],
  view: ['view', 'views'],
  materialized_view: ['materialized view', 'materialized views'],
  sequence: ['sequence', 'sequences'],
  column: ['column', 'columns'],
  index: ['index', 'indexes'],
  constraint: ['constraint', 'constraints'],
  function: ['function', 'functions'],
  trigger: ['trigger', 'triggers'],
  rls: ['row level security setting', 'row level security settings'],
  policy: ['policy', 'policies'],
};

function checkText(c: ObjectCheck): string {
  const o = c.object;
  switch (c.status) {
    case 'match':
      // A matching drop means the object is gone; the bare name would read as "it exists".
      return o.expect === 'absent'
        ? `${describeObject(o)}: dropped or renamed here, and no longer exists`
        : describeObject(o);
    case 'missing':
      return describeExpected(o);
    case 'different':
      return `${describeObject(o)}: ${c.differences
        .map((d) => `${d.attribute} expected ${d.expected}, found ${d.actual}`)
        .join('; ')}`;
    case 'unexpected':
      return `${describeObject(o)}: dropped or renamed here, but still exists`;
    case 'superseded':
      return `${describeObject(o)}: ${c.supersededBy.reason}`;
  }
}

function noteRow(n: Note): Row {
  return row(n.category.toUpperCase(), NOTE_RANK[n.category], n.source, noteText(n));
}

function noteText(n: Note): string {
  return `${n.statementType}: ${n.reason}`;
}

function row(
  label: string,
  rank: number,
  source: SourceRef,
  text: string,
  notes: readonly string[] = [],
): Row {
  // Statements inside DO blocks may be conditional, which matters when reading a mismatch.
  const suffix = source.inDoBlock === true ? ' [inside DO block]' : '';
  return { label, rank, line: source.line, text: text + suffix, notes };
}

function columnWidths(rows: readonly Row[]): Widths {
  return {
    label: Math.max(0, ...rows.map((r) => r.label.length)),
    line: Math.max(0, ...rows.map((r) => lineText(r.line).length)),
  };
}

function renderRows(rows: readonly Row[], widths: Widths): string[] {
  const indent = ' '.repeat(2 + widths.label + 1 + widths.line + 2);
  return rows.flatMap((r) => [
    `  ${r.label.padEnd(widths.label)} ${lineText(r.line).padEnd(widths.line)}  ${r.text}`,
    ...r.notes.map((note) => `${indent}note: ${note}`),
  ]);
}

function lineText(line: number): string {
  return `line ${line}`;
}

function verdictHeader(report: MigrationReport): string {
  return report.verdict === 'NOTHING_TO_VERIFY'
    ? VERDICT_TEXT.NOTHING_TO_VERIFY
    : `${report.verdict} ${report.matched}/${report.checked}`;
}

function historyText(recorded: boolean | null, table: string | undefined): string {
  if (recorded === null) return 'unavailable';
  const where = table === undefined ? '' : ` in ${table}`;
  return `${recorded ? 'recorded' : 'NOT recorded'}${where}`;
}

function totals(reports: readonly MigrationReport[]): string[] {
  const by = (verdict: MigrationVerdict): number =>
    reports.filter((r) => r.verdict === verdict).length;
  let line =
    `${plural(reports.length, 'migration')}: ${by('MATCH')} MATCH, ${by('MISMATCH')} MISMATCH, ` +
    `${by('NOTHING_TO_VERIFY')} nothing to verify.`;
  const unrecorded = reports.filter((r) => r.verdict === 'MATCH' && r.recorded === false);
  // Only a MATCH with evidence shows that a file ran; the others are listed apart.
  const applied = unrecorded.filter((r) => r.evidence > 0).length;
  if (applied > 0) line += ` ${applied} applied but NOT recorded in history.`;
  if (reports.every((r) => r.recorded === null)) line += ' History unavailable.';

  const lines = [line];
  const unproven = unrecorded.filter((r) => r.evidence === 0);
  if (unproven.length > 0) {
    lines.push(
      `${unproven.length} NOT recorded, and their MATCH does not show they ran: ` +
        unproven.map((r) => r.file).join(', '),
    );
  }
  const recordedMismatch = reports.filter((r) => r.verdict === 'MISMATCH' && r.recorded === true);
  if (recordedMismatch.length > 0) {
    lines.push(
      `${recordedMismatch.length} recorded in history but MISMATCH: ` +
        recordedMismatch.map((r) => r.file).join(', '),
    );
  }
  if (reports.some(lacksEvidence)) {
    lines.push(
      'MATCH*: every check would also hold had the file never run, so it may not have been ' +
        'applied.',
    );
  }
  return lines;
}
