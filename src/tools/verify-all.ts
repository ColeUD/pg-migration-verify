import type { MigrationReport } from '../model.js';
import { formatMigrationReport, formatSummary } from '../verify/index.js';
import { requireDatabase, type ToolContext, type ToolResult } from './context.js';
import { historyExplanation, historyInfo, migrationEntry } from './entries.js';
import { listingWarnings, loadRepoMigrations, parseMigrations } from './repo.js';
import type { VerifyAllInput, VerifyAllOutput } from './schemas.js';
import { verifyAgainstDatabase } from './verification.js';

/**
 * `verify_all`: every migration against the live catalog. The text is the summary table, then
 * the full report of each MISMATCH (of every migration when verbose), so the answer to "what is
 * wrong?" is in one call.
 */
export async function verifyAll(
  context: ToolContext,
  input: VerifyAllInput,
): Promise<ToolResult<VerifyAllOutput>> {
  const db = requireDatabase(context);
  const { display, listing } = await loadRepoMigrations(context, input.dir);
  const migrations = await parseMigrations(context, listing.files);
  const { reports, history } = await verifyAgainstDatabase(db, migrations);

  const verbose = input.verbose ?? false;
  const explanation = historyExplanation(history);
  const detailed = reports.filter((r) => verbose || r.verdict === 'MISMATCH');
  const sections = [
    [
      formatSummary(reports),
      ...(explanation === null ? [] : [explanation]),
      ...listingWarnings(listing),
    ].join('\n'),
    ...detailed.map((r) => formatMigrationReport(r, { verbose, historyTable: history.table })),
  ];

  return {
    text: sections.join('\n\n'),
    structured: {
      directory: display,
      history: historyInfo(history),
      totals: totals(reports),
      migrations: reports.map(migrationEntry),
    },
  };
}

function totals(reports: readonly MigrationReport[]): VerifyAllOutput['totals'] {
  const count = (predicate: (r: MigrationReport) => boolean): number =>
    reports.filter(predicate).length;
  return {
    migrations: reports.length,
    match: count((r) => r.verdict === 'MATCH'),
    mismatch: count((r) => r.verdict === 'MISMATCH'),
    nothingToVerify: count((r) => r.verdict === 'NOTHING_TO_VERIFY'),
    appliedNotRecorded: count(
      (r) => r.verdict === 'MATCH' && r.recorded === false && r.evidence > 0,
    ),
    unprovenNotRecorded: count(
      (r) => r.verdict === 'MATCH' && r.recorded === false && r.evidence === 0,
    ),
    recordedButMismatch: count((r) => r.verdict === 'MISMATCH' && r.recorded === true),
  };
}
