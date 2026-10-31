import {
  readCatalogSnapshot,
  readRecordedHistory,
  type ReadOnlyDatabase,
} from '../catalog/index.js';
import type { MigrationReport, RecordedHistory } from '../model.js';
import { requiredSchemas, verifyMigrations, type MigrationInput } from '../verify/index.js';

export interface Verification {
  /** One report per migration in apply order, or only the one asked for. */
  reports: MigrationReport[];
  history: RecordedHistory;
}

/**
 * Checks parsed migrations against the live catalog. The snapshot and the recorded history are
 * read in ONE read-only transaction, so they describe the same moment and the tool call uses a
 * single connection.
 *
 * Pass every repository migration, even when one report is wanted (`only`, a file name):
 * whether an object should still exist depends on what later migrations did to it.
 */
export async function verifyAgainstDatabase(
  db: ReadOnlyDatabase,
  migrations: readonly MigrationInput[],
  only?: string,
): Promise<Verification> {
  const { snapshot, history } = await db.readOnly(async (q) => {
    const snapshot = await readCatalogSnapshot(q, requiredSchemas(migrations));
    // Last on purpose: a permission error while reading history aborts the transaction.
    const history = await readRecordedHistory(q);
    return { snapshot, history };
  });
  const recordedVersions =
    history.status === 'ok' ? new Set(history.migrations.map((m) => m.version)) : null;
  const reports = verifyMigrations({
    migrations,
    snapshot,
    recordedVersions,
    ...(only === undefined ? {} : { only }),
  });
  return { reports, history };
}
