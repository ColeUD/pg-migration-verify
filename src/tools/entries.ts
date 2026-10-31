/**
 * Model types -> the structured entries of tool results (see schemas.ts). Object descriptions use
 * the same wording as the text output, so an agent can quote either.
 */
import { describeObject } from '../keys.js';
import type { MigrationReport, Note, ObjectCheck, RecordedHistory } from '../model.js';
import { describeExpected } from '../verify/index.js';
import type { CheckEntry, HistoryInfo, MigrationEntry, NoteEntry } from './schemas.js';

export function historyInfo(history: RecordedHistory): HistoryInfo {
  return {
    table: history.table,
    status: history.status,
    reason: history.status === 'not_readable' ? history.reason : null,
  };
}

/**
 * One line saying why the history column of a report reads "unavailable", or null when the
 * history was read. The verdicts do not depend on it: objects are checked in the catalog.
 */
export function historyExplanation(history: RecordedHistory): string | null {
  switch (history.status) {
    case 'ok':
      return null;
    case 'missing':
      return (
        `History: ${history.table} does not exist, so whether each migration was recorded is ` +
        'unknown. The object checks do not depend on it.'
      );
    case 'not_readable':
      return (
        `History: ${history.table} cannot be read (${history.reason}); ` +
        'list_recorded_migrations shows the grants needed. The object checks do not depend on it.'
      );
  }
}

export function noteEntry(note: Note): NoteEntry {
  return {
    category: note.category,
    statementType: note.statementType,
    reason: note.reason,
    line: note.source.line,
    inDoBlock: note.source.inDoBlock === true,
    excerpt: note.source.excerpt,
  };
}

export function checkEntry(check: ObjectCheck): CheckEntry {
  const { object } = check;
  return {
    status: check.status,
    object: describeObject(object),
    expect: object.expect,
    expected: describeExpected(object),
    kind: object.kind,
    key: object.key,
    line: object.source.line,
    inDoBlock: object.source.inDoBlock === true,
    differences: check.differences.map((d) => ({ ...d })),
    notes: [...check.notes],
    supersededBy: check.status === 'superseded' ? { ...check.supersededBy } : null,
  };
}

/** Statuses that make a migration MISMATCH. */
const PROBLEM_STATUSES: ReadonlySet<ObjectCheck['status']> = new Set([
  'missing',
  'different',
  'unexpected',
]);

export function migrationEntry(report: MigrationReport): MigrationEntry {
  return {
    version: report.version,
    name: report.name,
    file: report.file,
    verdict: report.verdict,
    matched: report.matched,
    checked: report.checked,
    evidence: report.evidence,
    superseded: report.checks.filter((c) => c.status === 'superseded').length,
    unverifiable: report.notes.filter((n) => n.category === 'unverifiable').length,
    recorded: report.recorded,
    problems: report.checks.filter((c) => PROBLEM_STATUSES.has(c.status)).map(checkEntry),
  };
}
