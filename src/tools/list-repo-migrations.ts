import { formatMigrationListing } from '../migrations/format.js';
import type { ToolContext, ToolResult } from './context.js';
import { loadRepoMigrations } from './repo.js';
import type { ListRepoMigrationsInput, ListRepoMigrationsOutput } from './schemas.js';

/** `list_repo_migrations`: the migration files on disk. Needs no database. */
export async function listRepoMigrations(
  context: ToolContext,
  input: ListRepoMigrationsInput,
): Promise<ToolResult<ListRepoMigrationsOutput>> {
  const { display, listing } = await loadRepoMigrations(context, input.dir);
  return {
    text: formatMigrationListing(listing, display),
    structured: {
      directory: display,
      files: listing.files.map((f) => ({
        version: f.version,
        name: f.name,
        fileName: f.fileName,
        checksum: f.checksum,
      })),
      skipped: listing.skipped.map((s) => ({ fileName: s.fileName, reason: s.reason })),
      duplicateVersions: [...listing.duplicateVersions],
    },
  };
}
