import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MigrationFile } from '../model.js';
import { compareMigrationFiles } from '../versions.js';

/** Result of scanning a migrations directory. */
export interface MigrationListing {
  /** Valid migration files, sorted by version (then file name). */
  files: MigrationFile[];
  /** `.sql` files that are not migrations by naming convention, so they are never verified. */
  skipped: { fileName: string; reason: string }[];
  /** Versions used by more than one file, sorted. Supabase refuses to apply such a directory. */
  duplicateVersions: string[];
}

/**
 * Supabase CLI convention: `<version>_<name>.sql`, where version is a 14-digit timestamp. Any
 * digit count is accepted so plain numbered schemes (`0001_init.sql`) work too.
 */
const MIGRATION_FILE_NAME = /^(\d+)_(.+)\.sql$/;

const MAX_LISTED_CANDIDATES = 10;

/**
 * Lists the migration files of a directory (non-recursive, `.sql` only), the way the Supabase CLI
 * would see them. Misnamed `.sql` files are reported instead of silently ignored, because a file
 * the CLI skips is a classic reason for "my migration never ran".
 *
 * @throws Error naming the directory when it does not exist or is not a directory.
 */
export async function listMigrationFiles(dir: string): Promise<MigrationListing> {
  const absoluteDir = path.resolve(dir);
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(`Migrations directory not found: ${absoluteDir}`, { cause: error });
    }
    if (code === 'ENOTDIR') {
      throw new Error(`Migrations path is not a directory: ${absoluteDir}`, { cause: error });
    }
    throw new Error(`Cannot read migrations directory ${absoluteDir}`, { cause: error });
  }

  const files: MigrationFile[] = [];
  const skipped: MigrationListing['skipped'] = [];
  const sqlFileNames = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of sqlFileNames) {
    const match = MIGRATION_FILE_NAME.exec(fileName);
    if (match?.[1] === undefined || match[2] === undefined) {
      skipped.push({
        fileName,
        reason: 'file name does not match <version>_<name>.sql (e.g. 20240101120000_init.sql)',
      });
      continue;
    }
    const filePath = path.join(absoluteDir, fileName);
    const bytes = await readFile(filePath);
    files.push({
      version: match[1],
      name: match[2],
      fileName,
      path: filePath,
      checksum: createHash('sha256').update(bytes).digest('hex'),
    });
  }

  files.sort(compareMigrationFiles);
  return { files, skipped, duplicateVersions: findDuplicateVersions(files) };
}

function findDuplicateVersions(sortedFiles: readonly MigrationFile[]): string[] {
  const duplicates: string[] = [];
  for (let i = 1; i < sortedFiles.length; i++) {
    const version = sortedFiles[i]?.version;
    const isRepeat = version !== undefined && version === sortedFiles[i - 1]?.version;
    if (isRepeat && duplicates.at(-1) !== version) duplicates.push(version);
  }
  return duplicates;
}

/**
 * Reads a migration as text. A UTF-8 byte order mark (common in files saved by Windows editors) is
 * stripped so it cannot end up inside the first statement's text or offsets.
 */
export async function readMigrationSql(file: MigrationFile): Promise<string> {
  const text = await readFile(file.path, 'utf8');
  return text.startsWith('﻿') ? text.slice(1) : text;
}

/**
 * Finds the one migration a user (or model) means. Accepted forms, tried in this order:
 * a file name (`20240101120000_create_profiles.sql`), a path ending in one, the file name without
 * `.sql`, a version (`20240101120000`) and a name (`create_profiles`).
 *
 * Only exact matches resolve; guessing from a substring could silently verify the wrong file.
 *
 * @throws Error when nothing or more than one file matches, listing up to 10 candidates.
 */
export function resolveMigration(files: readonly MigrationFile[], ref: string): MigrationFile {
  const wanted = ref.trim();
  if (wanted === '') throw new Error('No migration given: pass a file name, version or name.');
  if (files.length === 0) throw new Error(`No migration files to match "${wanted}" against.`);

  const baseName = wanted.split(/[\\/]/).at(-1) ?? wanted;
  const strategies: ((f: MigrationFile) => boolean)[] = [
    (f) => f.fileName === baseName,
    (f) => `${f.version}_${f.name}` === baseName,
    (f) => f.version === wanted,
    (f) => f.name === wanted,
  ];

  for (const matches of strategies) {
    const found = files.filter(matches);
    const [first] = found;
    if (first !== undefined && found.length === 1) return first;
    if (found.length > 1) {
      throw new Error(
        `"${wanted}" matches ${found.length} migrations; pass the full file name instead:\n` +
          listCandidates(found),
      );
    }
  }

  const needle = baseName.toLowerCase();
  const near = files.filter((f) => f.fileName.toLowerCase().includes(needle));
  if (near.length > 0) {
    return throwUnknown(wanted, `Did you mean:\n${listCandidates(near)}`);
  }
  // Nothing similar: show the most recent migrations, which are the ones usually being checked.
  return throwUnknown(
    wanted,
    `Latest migrations:\n${listCandidates(files.slice(-MAX_LISTED_CANDIDATES).reverse())}`,
  );
}

function throwUnknown(ref: string, hint: string): never {
  throw new Error(`No migration matches "${ref}". ${hint}`);
}

function listCandidates(candidates: readonly MigrationFile[]): string {
  const shown = candidates.slice(0, MAX_LISTED_CANDIDATES).map((f) => `  - ${f.fileName}`);
  const hidden = candidates.length - shown.length;
  if (hidden > 0) shown.push(`  ... and ${hidden} more`);
  return shown.join('\n');
}
