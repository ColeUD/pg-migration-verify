import { loadRecordedHistory } from '../catalog/index.js';
import { formatRecordedHistory } from '../migrations/format.js';
import { requireDatabase, type ToolContext, type ToolResult } from './context.js';
import { historyInfo } from './entries.js';
import type { ListRecordedMigrationsOutput } from './schemas.js';

/**
 * `list_recorded_migrations`: the Supabase history table. A missing or unreadable table is a
 * normal answer (explained in the text, `history.status` in the data), not a tool error.
 */
export async function listRecordedMigrations(
  context: ToolContext,
): Promise<ToolResult<ListRecordedMigrationsOutput>> {
  const history = await loadRecordedHistory(requireDatabase(context));
  return {
    text: formatRecordedHistory(history),
    structured: {
      history: historyInfo(history),
      migrations:
        history.status === 'ok'
          ? history.migrations.map((m) => ({ version: m.version, name: m.name }))
          : [],
    },
  };
}
