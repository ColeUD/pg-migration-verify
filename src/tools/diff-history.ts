import { loadRecordedHistory } from '../catalog/index.js';
import { formatHistoryDiff } from '../migrations/format.js';
import { diffHistory, type HistoryDiff } from '../migrations/history-diff.js';
import { requireDatabase, type ToolContext, type ToolResult } from './context.js';
import { historyInfo } from './entries.js';
import { loadRepoMigrations } from './repo.js';
import type { DiffHistoryInput, DiffHistoryOutput } from './schemas.js';

/**
 * `diff_history`: repository files versus the recorded history, by version. Only compares the
 * bookkeeping; whether the objects exist is what `verify_*` checks.
 */
export async function compareHistory(
  context: ToolContext,
  input: DiffHistoryInput,
): Promise<ToolResult<DiffHistoryOutput>> {
  const db = requireDatabase(context);
  const { display, listing } = await loadRepoMigrations(context, input.dir);
  const history = await loadRecordedHistory(db);
  // With no readable history there is nothing to compare; the formatter explains why instead.
  const diff = diffHistory(listing.files, history.status === 'ok' ? history.migrations : []);
  return {
    text: formatHistoryDiff(diff, history),
    structured: {
      directory: display,
      history: historyInfo(history),
      diff: history.status === 'ok' ? diffEntry(diff) : null,
    },
  };
}

function diffEntry(diff: HistoryDiff): NonNullable<DiffHistoryOutput['diff']> {
  return {
    agree:
      diff.onlyInRepo.length === 0 &&
      diff.onlyInDatabase.length === 0 &&
      diff.inBoth.every((b) => b.nameMatches !== false),
    inBoth: diff.inBoth.map(({ file, recorded, nameMatches }) => ({
      version: file.version,
      fileName: file.fileName,
      repoName: file.name,
      recordedName: recorded.name,
      nameMatches,
    })),
    onlyInRepo: diff.onlyInRepo.map((f) => ({
      version: f.version,
      name: f.name,
      fileName: f.fileName,
    })),
    onlyInDatabase: diff.onlyInDatabase.map((r) => ({ version: r.version, name: r.name })),
  };
}
