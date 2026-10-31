import path from 'node:path';
import { resolveDirectory, type Config } from '../config.js';
import {
  listMigrationFiles,
  readMigrationSql,
  type MigrationListing,
} from '../migrations/files.js';
import type { MigrationFile } from '../model.js';
import { loadParser, parseMigration } from '../parser/index.js';
import { plural } from '../text.js';
import type { MigrationInput } from '../verify/index.js';
import type { ToolContext } from './context.js';

/** The repository side of every tool: which directory was scanned and what it contains. */
export interface RepoMigrations {
  /** Directory for output: relative to the project directory when inside it, else absolute. */
  display: string;
  listing: MigrationListing;
}

/**
 * Lists the migrations of `dir` (default: the configured directory; relative paths are taken
 * from the project directory).
 *
 * @throws Error naming the directory when it does not exist or cannot be read.
 */
export async function loadRepoMigrations(
  context: ToolContext,
  dir: string | undefined,
): Promise<RepoMigrations> {
  const absolute = resolveDirectory(context.config, dir);
  return {
    display: displayDirectory(context.config, absolute),
    listing: await listMigrationFiles(absolute),
  };
}

/**
 * Reads and parses migration files. The parser's WASM module is loaded on first use (later calls
 * return at once), so tools that never parse do not pay for it.
 */
export async function parseMigrations(
  context: ToolContext,
  files: readonly MigrationFile[],
): Promise<MigrationInput[]> {
  await loadParser();
  const inputs: MigrationInput[] = [];
  for (const file of files) {
    const sql = await readMigrationSql(file);
    inputs.push({
      file,
      parsed: parseMigration(sql, {
        file: file.fileName,
        defaultSchema: context.config.defaultSchema,
      }),
    });
  }
  return inputs;
}

/**
 * Lines warning about files the Supabase CLI will not apply as they are. Shown under summaries
 * because a skipped or clashing file is a classic answer to "why is my migration not there?".
 */
export function listingWarnings(listing: MigrationListing): string[] {
  const warnings: string[] = [];
  if (listing.skipped.length > 0) {
    warnings.push(
      `Skipped ${plural(listing.skipped.length, '.sql file')} not named <version>_<name>.sql ` +
        `(never applied by the Supabase CLI): ${listing.skipped.map((s) => s.fileName).join(', ')}`,
    );
  }
  if (listing.duplicateVersions.length > 0) {
    warnings.push(
      `Duplicate versions (the Supabase CLI refuses them): ${listing.duplicateVersions.join(', ')}`,
    );
  }
  return warnings;
}

/** `supabase/migrations` rather than a long absolute path, when the directory is in the project. */
export function displayDirectory(config: Config, absolute: string): string {
  const relative = path.relative(config.projectDir, absolute);
  if (relative === '') return '.';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return absolute;
  return relative.split(path.sep).join('/');
}
