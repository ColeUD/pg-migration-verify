import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listMigrationFiles,
  readMigrationSql,
  resolveMigration,
} from '../../../src/migrations/files.js';
import type { MigrationFile } from '../../../src/model.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'pgmv-files-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeFiles(files: Record<string, string | Buffer>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
}

function fakeFile(fileName: string): MigrationFile {
  const match = /^(\d+)_(.+)\.sql$/.exec(fileName)!;
  return {
    version: match[1]!,
    name: match[2]!,
    fileName,
    path: path.join('/repo/supabase/migrations', fileName),
    checksum: '0'.repeat(64),
  };
}

describe('listMigrationFiles', () => {
  it('lists *.sql migrations sorted by version, with absolute paths and parsed names', async () => {
    await writeFiles({
      '20240102000000_create_todos.sql': 'create table todos (id int);',
      '20240101000000_create_profiles.sql': 'create table profiles (id int);',
    });

    const listing = await listMigrationFiles(dir);

    expect(listing.files.map((f) => f.fileName)).toEqual([
      '20240101000000_create_profiles.sql',
      '20240102000000_create_todos.sql',
    ]);
    expect(listing.files[0]).toMatchObject({
      version: '20240101000000',
      name: 'create_profiles',
      path: path.join(dir, '20240101000000_create_profiles.sql'),
    });
    expect(path.isAbsolute(listing.files[0]!.path)).toBe(true);
    expect(listing.skipped).toEqual([]);
    expect(listing.duplicateVersions).toEqual([]);
  });

  it('sorts versions of different digit lengths numerically, not as text', async () => {
    await writeFiles({
      '10_ten.sql': '',
      '9_nine.sql': '',
      '100_hundred.sql': '',
      '2_two.sql': '',
    });

    const listing = await listMigrationFiles(dir);

    expect(listing.files.map((f) => f.version)).toEqual(['2', '9', '10', '100']);
  });

  it('ignores non-sql files and subdirectories, and does not recurse', async () => {
    await writeFiles({ 'README.md': '# notes', '.gitkeep': '', '1_init.sql': '' });
    await mkdir(path.join(dir, '2_folder.sql'));
    await mkdir(path.join(dir, 'nested'));
    await writeFile(path.join(dir, 'nested', '3_nested.sql'), '');

    const listing = await listMigrationFiles(dir);

    expect(listing.files.map((f) => f.fileName)).toEqual(['1_init.sql']);
    expect(listing.skipped).toEqual([]);
  });

  it.each(['seed.sql', 'init_20240101.sql', '20240101.sql', '20240101_.sql', '20240101_x.SQL'])(
    'reports misnamed .sql file %s as skipped with a reason',
    async (fileName) => {
      await writeFiles({ [fileName]: 'select 1;' });

      const listing = await listMigrationFiles(dir);

      expect(listing.files).toEqual([]);
      expect(listing.skipped).toEqual([
        { fileName, reason: expect.stringContaining('<version>_<name>.sql') as unknown },
      ]);
    },
  );

  it('reports versions used by more than one file, keeping all files in a stable order', async () => {
    await writeFiles({
      '1_b.sql': '',
      '1_a.sql': '',
      '2_only.sql': '',
      '3_x.sql': '',
      '3_y.sql': '',
      '3_z.sql': '',
    });

    const listing = await listMigrationFiles(dir);

    expect(listing.duplicateVersions).toEqual(['1', '3']);
    expect(listing.files.map((f) => f.fileName)).toEqual([
      '1_a.sql',
      '1_b.sql',
      '2_only.sql',
      '3_x.sql',
      '3_y.sql',
      '3_z.sql',
    ]);
  });

  it('computes a stable sha256 of the exact bytes', async () => {
    const bytes = Buffer.from('\uFEFFcreate table profiles (id int);\r\n', 'utf8');
    await writeFiles({ '1_init.sql': bytes });

    const first = await listMigrationFiles(dir);
    const second = await listMigrationFiles(dir);

    const expected = createHash('sha256').update(bytes).digest('hex');
    expect(first.files[0]!.checksum).toBe(expected);
    expect(second.files[0]!.checksum).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes the checksum when the content changes', async () => {
    await writeFiles({ '1_init.sql': 'create table todos (id int);' });
    const before = await listMigrationFiles(dir);
    await writeFiles({ '1_init.sql': 'create table todos (id bigint);' });
    const after = await listMigrationFiles(dir);

    expect(after.files[0]!.checksum).not.toBe(before.files[0]!.checksum);
  });

  it('returns an empty listing for an empty directory', async () => {
    expect(await listMigrationFiles(dir)).toEqual({
      files: [],
      skipped: [],
      duplicateVersions: [],
    });
  });

  it('throws a clear error naming the path when the directory does not exist', async () => {
    const missing = path.join(dir, 'supabase', 'migrations');

    await expect(listMigrationFiles(missing)).rejects.toThrow(
      `Migrations directory not found: ${missing}`,
    );
  });

  it('throws a clear error when the path is a file', async () => {
    await writeFiles({ 'not-a-dir': '' });
    const file = path.join(dir, 'not-a-dir');

    await expect(listMigrationFiles(file)).rejects.toThrow(
      `Migrations path is not a directory: ${file}`,
    );
  });
});

describe('readMigrationSql', () => {
  it('strips a leading UTF-8 byte order mark', async () => {
    await writeFiles({ '1_init.sql': '\uFEFFcreate table profiles (id int);' });
    const [file] = (await listMigrationFiles(dir)).files;

    expect(await readMigrationSql(file!)).toBe('create table profiles (id int);');
  });

  it('returns other text unchanged, including non-ASCII characters and CRLF', async () => {
    const sql = "comment on table todos is 'caf\u00e9 \uFEFF';\r\n";
    await writeFiles({ '1_init.sql': sql });
    const [file] = (await listMigrationFiles(dir)).files;

    expect(await readMigrationSql(file!)).toBe(sql);
  });
});

describe('resolveMigration', () => {
  const files = [
    '20240101000000_create_profiles.sql',
    '20240102000000_create_todos.sql',
    '20240103000000_add_todo_index.sql',
    '20240104000000_create_projects.sql',
  ].map(fakeFile);

  it.each([
    ['a file name', '20240102000000_create_todos.sql'],
    ['a POSIX path', 'supabase/migrations/20240102000000_create_todos.sql'],
    ['a Windows path', 'C:\\repo\\supabase\\migrations\\20240102000000_create_todos.sql'],
    ['a file name without extension', '20240102000000_create_todos'],
    ['a version', '20240102000000'],
    ['a name', 'create_todos'],
    ['a reference with surrounding spaces', '  create_todos '],
  ])('resolves %s', (_form, ref) => {
    expect(resolveMigration(files, ref).fileName).toBe('20240102000000_create_todos.sql');
  });

  it('prefers a file name over a migration name that happens to be equal', () => {
    // '1_2_init.sql' has the name '2_init', which is also the file name of '2_init.sql'.
    const tricky = [fakeFile('1_2_init.sql'), fakeFile('2_init.sql')];

    expect(resolveMigration(tricky, '2_init').fileName).toBe('2_init.sql');
  });

  it('rejects a version shared by two files and lists both', () => {
    const duplicated = [...files, fakeFile('20240102000000_create_todos_again.sql')];

    expect(() => resolveMigration(duplicated, '20240102000000')).toThrow(
      '"20240102000000" matches 2 migrations; pass the full file name instead:\n' +
        '  - 20240102000000_create_todos.sql\n' +
        '  - 20240102000000_create_todos_again.sql',
    );
  });

  it('rejects a name shared by two files', () => {
    const renamedTwice = [fakeFile('1_seed_roles.sql'), fakeFile('7_seed_roles.sql')];

    expect(() => resolveMigration(renamedTwice, 'seed_roles')).toThrow(/matches 2 migrations/);
  });

  it('does not resolve a partial match, but suggests it', () => {
    expect(() => resolveMigration(files, 'todo')).toThrow(
      'No migration matches "todo". Did you mean:\n' +
        '  - 20240102000000_create_todos.sql\n' +
        '  - 20240103000000_add_todo_index.sql',
    );
  });

  it('lists the latest migrations when nothing is similar', () => {
    expect(() => resolveMigration(files, 'billing')).toThrow(
      'No migration matches "billing". Latest migrations:\n' +
        '  - 20240104000000_create_projects.sql\n' +
        '  - 20240103000000_add_todo_index.sql\n' +
        '  - 20240102000000_create_todos.sql\n' +
        '  - 20240101000000_create_profiles.sql',
    );
  });

  it('lists at most 10 candidates', () => {
    const many = Array.from({ length: 15 }, (_, i) => fakeFile(`${100 + i}_add_column.sql`));

    let message = '';
    try {
      resolveMigration(many, 'add_column');
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/^"add_column" matches 15 migrations/);
    expect(message.split('\n').filter((line) => line.startsWith('  - '))).toHaveLength(10);
    expect(message).toMatch(/\.\.\. and 5 more$/);
  });

  it.each([
    ['an empty reference', files, '  ', 'No migration given'],
    ['an empty file list', [], 'create_todos', 'No migration files to match "create_todos"'],
  ])('rejects %s', (_case, list, ref, message) => {
    expect(() => resolveMigration(list, ref)).toThrow(message);
  });
});
