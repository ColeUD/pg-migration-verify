import { resolveMigration } from '../migrations/files.js';
import { formatMigrationReport } from '../verify/index.js';
import { requireDatabase, type ToolContext, type ToolResult } from './context.js';
import {
  checkEntry,
  historyExplanation,
  historyInfo,
  migrationEntry,
  noteEntry,
} from './entries.js';
import { loadRepoMigrations, parseMigrations } from './repo.js';
import type { VerifyMigrationInput, VerifyMigrationOutput } from './schemas.js';
import { verifyAgainstDatabase } from './verification.js';

/**
 * `verify_migration`: one migration against the live catalog. Every repository migration is
 * parsed anyway, because later migrations decide which of this one's objects should still exist.
 */
export async function verifyMigration(
  context: ToolContext,
  input: VerifyMigrationInput,
): Promise<ToolResult<VerifyMigrationOutput>> {
  const db = requireDatabase(context);
  const { listing } = await loadRepoMigrations(context, input.dir);
  // Resolve before the expensive part, so a typo fails fast with a list of candidates.
  const target = resolveMigration(listing.files, input.file);
  const migrations = await parseMigrations(context, listing.files);
  const { reports, history } = await verifyAgainstDatabase(db, migrations, target.fileName);

  const report = reports.find((r) => r.file === target.fileName);
  if (report === undefined) throw new Error(`No report was produced for ${target.fileName}.`);

  const explanation = historyExplanation(history);
  const text = formatMigrationReport(report, {
    verbose: input.verbose ?? false,
    historyTable: history.table,
  });
  return {
    text: explanation === null ? text : `${text}\n\n${explanation}`,
    structured: {
      migration: migrationEntry(report),
      checks: report.checks.map(checkEntry),
      notes: report.notes.map(noteEntry),
      history: historyInfo(history),
    },
  };
}
