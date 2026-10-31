/**
 * Plain-text renderings for tool output. They are read by a model and pasted by humans, so they
 * are deterministic, ASCII-only and column-aligned, and they explain what a result means and what
 * to do next instead of just dumping rows.
 */

import type { RecordedHistory } from '../model.js';
import { formatTable, plural } from '../text.js';
import { compareText, compareVersions } from '../versions.js';
import type { MigrationListing } from './files.js';
import type { HistoryDiff } from './history-diff.js';

/** Hex digits of the sha256 shown in listings: enough to spot an edited file at a glance. */
const CHECKSUM_DISPLAY_LENGTH = 12;

const NO_VALUE = '-';

/** Lists the repository's migrations, then any skipped files and duplicate versions. */
export function formatMigrationListing(listing: MigrationListing, dirDisplay: string): string {
  const { files, skipped, duplicateVersions } = listing;
  const lines: string[] = [];

  if (files.length === 0) {
    lines.push(`No migration files in ${dirDisplay}.`);
  } else {
    lines.push(`${plural(files.length, 'migration file')} in ${dirDisplay}`);
    lines.push(
      ...indentedTable([
        ['VERSION', 'NAME', 'SHA256'],
        ...files.map((f) => [f.version, f.name, f.checksum.slice(0, CHECKSUM_DISPLAY_LENGTH)]),
      ]),
    );
  }

  if (skipped.length > 0) {
    lines.push('');
    lines.push(
      `Skipped ${plural(skipped.length, '.sql file')} (never applied by the Supabase CLI):`,
    );
    lines.push(...indentedTable(skipped.map((s) => [s.fileName, s.reason])));
  }

  if (duplicateVersions.length > 0) {
    lines.push('');
    lines.push(
      `Duplicate versions (each version must belong to one file): ${duplicateVersions.join(', ')}`,
    );
  }

  return lines.join('\n');
}

/** Shows the history table's rows, or explains why it could not be read. */
export function formatRecordedHistory(history: RecordedHistory): string {
  switch (history.status) {
    case 'missing':
      return (
        `${history.table} does not exist in this database: history cannot be compared; ` +
        'use verify_all to check objects directly.'
      );
    case 'not_readable':
      return formatNotReadable(history.table, history.reason);
    case 'ok': {
      const { migrations, table } = history;
      if (migrations.length === 0) return `No migrations recorded in ${table}.`;
      const sorted = [...migrations].sort((a, b) => compareVersions(a.version, b.version));
      return [
        `${plural(migrations.length, 'migration')} recorded in ${table}`,
        ...indentedTable([
          ['VERSION', 'NAME'],
          ...sorted.map((m) => [m.version, m.name ?? NO_VALUE]),
        ]),
      ].join('\n');
    }
  }
}

function formatNotReadable(table: string, reason: string): string {
  const dot = table.indexOf('.');
  const grants =
    dot > 0
      ? [
          `GRANT USAGE ON SCHEMA ${table.slice(0, dot)} TO <role>;`,
          `GRANT SELECT ON ${table} TO <role>;`,
        ]
      : [`GRANT SELECT ON ${table} TO <role>;`];
  return [
    `${table} exists but cannot be read: ${reason}`,
    'History cannot be compared until the connecting role can read it. As an administrator, run:',
    ...grants.map((g) => `  ${g}`),
    '<role> is the role in the connection string; it needs no write privileges.',
    'verify_all checks objects directly and works without this grant.',
  ].join('\n');
}

interface DiffRow {
  version: string;
  status: 'in both' | 'name differs' | 'only in repo' | 'only in db';
  repoName: string;
  dbName: string;
}

/**
 * One table of every version on either side, sorted by version, followed by a summary and a
 * plain-language explanation of each kind of discrepancy present.
 */
export function formatHistoryDiff(diff: HistoryDiff, history: RecordedHistory): string {
  if (history.status !== 'ok') return formatRecordedHistory(history);

  const rows: DiffRow[] = [
    ...diff.inBoth.map(({ file, recorded, nameMatches }): DiffRow => ({
      version: file.version,
      status: nameMatches === false ? 'name differs' : 'in both',
      repoName: file.name,
      dbName: recorded.name ?? NO_VALUE,
    })),
    ...diff.onlyInRepo.map((f): DiffRow => ({
      version: f.version,
      status: 'only in repo',
      repoName: f.name,
      dbName: NO_VALUE,
    })),
    ...diff.onlyInDatabase.map((r): DiffRow => ({
      version: r.version,
      status: 'only in db',
      repoName: NO_VALUE,
      dbName: r.name ?? NO_VALUE,
    })),
  ].sort((a, b) => compareVersions(a.version, b.version) || compareText(a.repoName, b.repoName));

  const fileCount = diff.inBoth.length + diff.onlyInRepo.length;
  const recordedCount = diff.inBoth.length + diff.onlyInDatabase.length;
  const header = `History: ${plural(fileCount, 'migration file')}, ${recordedCount} recorded in ${history.table}`;
  if (rows.length === 0) return `${header}\nNothing to compare.`;

  const renamed = diff.inBoth.filter((b) => b.nameMatches === false).length;
  const lines = [
    header,
    ...indentedTable([
      ['STATUS', 'VERSION', 'REPO NAME', 'RECORDED NAME'],
      ...rows.map((r) => [r.status, r.version, r.repoName, r.dbName]),
    ]),
    `Summary: ${diff.inBoth.length} in both` +
      (renamed > 0 ? ` (${renamed} with a different name)` : '') +
      `, ${diff.onlyInRepo.length} only in repo, ${diff.onlyInDatabase.length} only in database.`,
  ];

  if (diff.onlyInRepo.length === 0 && diff.onlyInDatabase.length === 0 && renamed === 0) {
    lines.push('Repository and recorded history agree.');
  }
  if (diff.onlyInRepo.length > 0) {
    lines.push(
      'only in repo: not recorded as applied (pending, or run by hand without recording); ' +
        'verify_migration shows whether its objects exist anyway.',
    );
  }
  if (diff.onlyInDatabase.length > 0) {
    lines.push(
      'only in db: recorded as applied but no file has that version (deleted, renamed, or ' +
        'applied from another branch).',
    );
  }
  if (renamed > 0) {
    lines.push(
      'name differs: same version, different name; the file was probably renamed after it was applied.',
    );
  }
  return lines.join('\n');
}

/** Tables sit indented under the heading line that introduces them. */
function indentedTable(rows: readonly (readonly string[])[]): string[] {
  return formatTable(rows, '  ');
}
