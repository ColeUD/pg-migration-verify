import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeConfig,
  readConfig,
  readTlsSetting,
  resolveDirectory,
  type Config,
} from '../../src/config.js';

const CWD = path.resolve('/work/app');
const FAKE_URL = 'postgres://readonly_user:test-only-password@db.example.test:5432/postgres';
const OTHER_FAKE_URL = 'postgres://app_user:another-test-only-password@localhost:5432/app';

describe('readConfig', () => {
  it('uses defaults when nothing is set', () => {
    expect(readConfig({}, CWD)).toEqual<Config>({
      databaseUrl: null,
      databaseUrlSource: null,
      projectDir: CWD,
      migrationsDir: path.join(CWD, 'supabase', 'migrations'),
      defaultSchema: 'public',
      statementTimeoutMs: 15_000,
      allowOutsideProject: false,
      tls: null,
    });
  });

  it.each([
    [
      'PGMV_DATABASE_URL wins over DATABASE_URL',
      { PGMV_DATABASE_URL: FAKE_URL, DATABASE_URL: OTHER_FAKE_URL },
      FAKE_URL,
      'PGMV_DATABASE_URL',
    ],
    [
      'DATABASE_URL is the fallback',
      { DATABASE_URL: OTHER_FAKE_URL },
      OTHER_FAKE_URL,
      'DATABASE_URL',
    ],
    [
      'an empty PGMV_DATABASE_URL does not hide DATABASE_URL',
      { PGMV_DATABASE_URL: '', DATABASE_URL: OTHER_FAKE_URL },
      OTHER_FAKE_URL,
      'DATABASE_URL',
    ],
    [
      'a whitespace PGMV_DATABASE_URL counts as unset',
      { PGMV_DATABASE_URL: '  \t', DATABASE_URL: OTHER_FAKE_URL },
      OTHER_FAKE_URL,
      'DATABASE_URL',
    ],
    [
      'an unexpanded plugin placeholder counts as unset',
      { PGMV_DATABASE_URL: '${user_config.database_url}', DATABASE_URL: OTHER_FAKE_URL },
      OTHER_FAKE_URL,
      'DATABASE_URL',
    ],
    [
      'surrounding whitespace is trimmed',
      { PGMV_DATABASE_URL: ` ${FAKE_URL}\n` },
      FAKE_URL,
      'PGMV_DATABASE_URL',
    ],
    [
      'placeholders in both variables mean no URL',
      { PGMV_DATABASE_URL: '${A}', DATABASE_URL: '${DATABASE_URL}' },
      null,
      null,
    ],
  ])('database URL: %s', (_case, env, url, source) => {
    const config = readConfig(env, CWD);

    expect(config.databaseUrl).toBe(url);
    expect(config.databaseUrlSource).toBe(source);
  });

  it.each([
    ['defaults to cwd', {}, CWD],
    [
      'takes PGMV_PROJECT_DIR as is when absolute',
      { PGMV_PROJECT_DIR: path.resolve('/repos/todo-app') },
      path.resolve('/repos/todo-app'),
    ],
    [
      'resolves a relative PGMV_PROJECT_DIR against cwd',
      { PGMV_PROJECT_DIR: '../todo-app' },
      path.resolve(CWD, '../todo-app'),
    ],
    [
      'ignores an unexpanded ${CLAUDE_PROJECT_DIR}',
      { PGMV_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}' },
      CWD,
    ],
  ])('project dir %s', (_case, env, expected) => {
    expect(readConfig(env, CWD).projectDir).toBe(expected);
  });

  it.each([
    [
      'defaults to <projectDir>/supabase/migrations',
      { PGMV_PROJECT_DIR: path.resolve('/repos/todo-app') },
      path.resolve('/repos/todo-app/supabase/migrations'),
    ],
    [
      'resolves a relative value against the project dir, not cwd',
      { PGMV_PROJECT_DIR: path.resolve('/repos/todo-app'), PGMV_MIGRATIONS_DIR: 'db/migrations' },
      path.resolve('/repos/todo-app/db/migrations'),
    ],
    [
      'keeps an absolute value',
      { PGMV_MIGRATIONS_DIR: path.resolve('/shared/migrations') },
      path.resolve('/shared/migrations'),
    ],
    [
      'ignores a placeholder',
      { PGMV_MIGRATIONS_DIR: '${MIGRATIONS}' },
      path.join(CWD, 'supabase', 'migrations'),
    ],
  ])('migrations dir %s', (_case, env, expected) => {
    expect(readConfig(env, CWD).migrationsDir).toBe(expected);
  });

  it.each([
    [{ PGMV_DEFAULT_SCHEMA: 'app' }, 'app'],
    [{ PGMV_DEFAULT_SCHEMA: ' ' }, 'public'],
    [{ PGMV_DEFAULT_SCHEMA: '${SCHEMA}' }, 'public'],
  ])('default schema from %j is %s', (env, expected) => {
    expect(readConfig(env, CWD).defaultSchema).toBe(expected);
  });

  it.each([
    [{}, 15_000],
    [{ PGMV_STATEMENT_TIMEOUT_MS: '5000' }, 5_000],
    [{ PGMV_STATEMENT_TIMEOUT_MS: ' 1 ' }, 1],
    [{ PGMV_STATEMENT_TIMEOUT_MS: '' }, 15_000],
    [{ PGMV_STATEMENT_TIMEOUT_MS: '${TIMEOUT}' }, 15_000],
  ])('statement timeout from %j is %i ms', (env, expected) => {
    expect(readConfig(env, CWD).statementTimeoutMs).toBe(expected);
  });

  it.each(['0', '-5', '1.5', '15s', 'abc', '1e3', '2147483648'])(
    'rejects PGMV_STATEMENT_TIMEOUT_MS=%s with a clear message',
    (value) => {
      expect(() => readConfig({ PGMV_STATEMENT_TIMEOUT_MS: value }, CWD)).toThrow(
        `PGMV_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds between 1 and 2147483647, got "${value}".`,
      );
    },
  );
});

describe('resolveDirectory', () => {
  const PROJECT = path.resolve('/repos/todo-app');
  const config = readConfig({ PGMV_PROJECT_DIR: PROJECT }, CWD);
  const OUTSIDE = 'dir must be inside the project directory (PGMV_PROJECT_DIR)';

  it.each([
    ['no directory', undefined, config.migrationsDir],
    ['an empty directory', '  ', config.migrationsDir],
    ['a relative directory', 'db/migrations', path.join(PROJECT, 'db', 'migrations')],
    ['the project directory itself', '.', PROJECT],
    [
      'an absolute directory inside the project',
      path.join(PROJECT, 'sql'),
      path.join(PROJECT, 'sql'),
    ],
    ['a name that only starts with dots', '..sql', path.join(PROJECT, '..sql')],
  ])('resolves %s against the project dir', async (_case, dir, expected) => {
    await expect(resolveDirectory(config, dir)).resolves.toBe(expected);
  });

  it.each([
    ['a parent directory', '../other-app'],
    ['a path that climbs out', 'db/../../../etc'],
    ['an absolute directory elsewhere', path.resolve('/elsewhere/sql')],
    ['another drive or root', process.platform === 'win32' ? 'Z:/dumps' : '/dumps'],
  ])('refuses %s, without echoing it', async (_case, dir) => {
    const error = await resolveDirectory(config, dir).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(OUTSIDE);
    expect((error as Error).message).not.toMatch(/other-app|etc|elsewhere|dumps/);
  });

  it('allows a configured migrations directory outside the project, and what is below it', async () => {
    const outside = readConfig(
      { PGMV_PROJECT_DIR: PROJECT, PGMV_MIGRATIONS_DIR: '../shared-db/migrations' },
      CWD,
    );
    const migrations = path.resolve('/repos/shared-db/migrations');
    await expect(resolveDirectory(outside)).resolves.toBe(migrations);
    await expect(resolveDirectory(outside, '../shared-db/migrations/archive')).resolves.toBe(
      path.join(migrations, 'archive'),
    );
    await expect(resolveDirectory(outside, '../shared-db')).rejects.toThrow(OUTSIDE);
  });

  it('allows any directory with PGMV_ALLOW_OUTSIDE_PROJECT=1', async () => {
    const open = readConfig({ PGMV_PROJECT_DIR: PROJECT, PGMV_ALLOW_OUTSIDE_PROJECT: '1' }, CWD);
    expect(open.allowOutsideProject).toBe(true);
    await expect(resolveDirectory(open, '../other-app')).resolves.toBe(
      path.resolve('/repos/other-app'),
    );
  });

  it('follows symbolic links before deciding', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'pmv-dir-'));
    try {
      const project = path.join(root, 'project');
      const secret = path.join(root, 'secret');
      await mkdir(project);
      await mkdir(secret);
      // A junction needs no privileges on Windows; elsewhere it is an ordinary directory symlink.
      await symlink(secret, path.join(project, 'link'), 'junction');
      const linked = readConfig({ PGMV_PROJECT_DIR: project }, CWD);
      await expect(resolveDirectory(linked, 'link')).rejects.toThrow(OUTSIDE);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('describeConfig', () => {
  it('names the variable that supplied the URL but never its value', () => {
    for (const env of [
      { PGMV_DATABASE_URL: FAKE_URL },
      { DATABASE_URL: FAKE_URL },
      { PGMV_DATABASE_URL: FAKE_URL, DATABASE_URL: OTHER_FAKE_URL },
    ]) {
      const text = describeConfig(readConfig(env, CWD));

      expect(text).not.toContain(FAKE_URL);
      expect(text).not.toContain(OTHER_FAKE_URL);
      expect(text).not.toContain('test-only-password');
      expect(text).not.toContain('readonly_user');
      expect(text).not.toContain('db.example.test');
    }
  });

  it('renders every setting', () => {
    const config = readConfig({ PGMV_DATABASE_URL: FAKE_URL, PGMV_DEFAULT_SCHEMA: 'app' }, CWD);

    expect(describeConfig(config)).toBe(
      [
        'Database URL: from PGMV_DATABASE_URL (value hidden)',
        'TLS: off (no sslmode in the connection string or PGSSLMODE, so traffic to the database ' +
          'server is unencrypted; add sslmode=verify-full)',
        `Project directory: ${CWD}`,
        `Migrations directory: ${path.join(CWD, 'supabase', 'migrations')}`,
        'Default schema: app',
        'Statement timeout: 15000 ms',
      ].join('\n'),
    );
  });

  it('explains how to set a URL when none is configured', () => {
    expect(describeConfig(readConfig({}, CWD))).toContain(
      'Database URL: not set (set PGMV_DATABASE_URL or DATABASE_URL; a read-only role is recommended)',
    );
  });
});

describe('readTlsSetting', () => {
  // pg, unlike libpq, does not default to sslmode=prefer: no TLS parameter means plain TCP.
  it.each<[string, string, string | undefined, boolean | null, string]>([
    [
      'no parameter, remote host',
      'postgres://u:test-only-password@db.example.test/app',
      undefined,
      false,
      'no sslmode in the connection string or PGSSLMODE, so traffic to the database server is unencrypted; add sslmode=verify-full',
    ],
    [
      'no parameter, local host',
      'postgres://u:test-only-password@localhost:5432/app',
      undefined,
      false,
      'no sslmode in the connection string or PGSSLMODE; fine for a local server',
    ],
    [
      'no parameter, IPv6 loopback',
      'postgres://u:test-only-password@[::1]:5432/app',
      undefined,
      false,
      'no sslmode in the connection string or PGSSLMODE; fine for a local server',
    ],
    [
      'Unix socket through the host parameter',
      'postgres://u@/app?host=/var/run/postgresql',
      undefined,
      false,
      'no sslmode in the connection string or PGSSLMODE; fine for a local server',
    ],
    [
      'remote host through the host parameter',
      'postgres://u@localhost/app?host=db.example.test',
      undefined,
      false,
      'no sslmode in the connection string or PGSSLMODE, so traffic to the database server is unencrypted; add sslmode=verify-full',
    ],
    [
      'sslmode=verify-full',
      'postgres://u:p@db.example.test/app?sslmode=verify-full&sslrootcert=/ca.crt',
      undefined,
      true,
      'sslmode=verify-full in the connection string',
    ],
    [
      'sslmode=no-verify',
      'postgres://u:p@db.example.test/app?sslmode=no-verify',
      undefined,
      true,
      'sslmode=no-verify in the connection string; the server certificate is not verified',
    ],
    [
      'sslmode=disable wins over PGSSLMODE',
      'postgres://u:p@db.example.test/app?sslmode=disable',
      'require',
      false,
      'sslmode=disable in the connection string',
    ],
    [
      'an unknown sslmode still turns TLS on, and is not repeated',
      'postgres://u:p@db.example.test/app?sslmode=test-only-password',
      undefined,
      true,
      'unrecognized sslmode in the connection string',
    ],
    [
      'sslrootcert alone',
      'postgres://u:p@db.example.test/app?sslrootcert=/ca.crt',
      undefined,
      true,
      'sslrootcert in the connection string',
    ],
    [
      'ssl=true',
      'postgres://u:p@db.example.test/app?ssl=true',
      undefined,
      true,
      'ssl parameter in the connection string',
    ],
    [
      'ssl=0',
      'postgres://u:p@db.example.test/app?ssl=0',
      'require',
      false,
      'ssl=0 in the connection string',
    ],
    [
      'PGSSLMODE when the URL says nothing',
      'postgres://u:p@db.example.test/app',
      'verify-full',
      true,
      'sslmode=verify-full from PGSSLMODE',
    ],
    [
      'an unknown PGSSLMODE is ignored, as pg ignores it',
      'postgres://u:p@db.example.test/app',
      'bogus',
      false,
      'no sslmode in the connection string or PGSSLMODE, so traffic to the database server is unencrypted; add sslmode=verify-full',
    ],
    [
      'an unreadable URL',
      'not a url',
      undefined,
      null,
      'the connection string could not be read to tell',
    ],
  ])('%s', (_case, url, pgSslMode, encrypted, detail) => {
    expect(readTlsSetting(url, pgSslMode)).toEqual({ encrypted, detail });
  });

  it('reads PGSSLMODE from the environment it is given', () => {
    const config = readConfig({ PGMV_DATABASE_URL: FAKE_URL, PGSSLMODE: 'verify-full' }, CWD);
    expect(describeConfig(config)).toContain('TLS: on (sslmode=verify-full from PGSSLMODE)');
  });

  it('never repeats the URL, its password or its host', () => {
    for (const url of [
      FAKE_URL,
      `${FAKE_URL}?sslmode=verify-full`,
      `${FAKE_URL}?sslmode=disable`,
    ]) {
      const text = describeConfig(readConfig({ PGMV_DATABASE_URL: url }, CWD));

      expect(text).toMatch(/^TLS: (on|off) \(/m);
      expect(text).not.toContain('test-only-password');
      expect(text).not.toContain('readonly_user');
      expect(text).not.toContain('db.example.test');
    }
  });

  it('is absent without a database URL', () => {
    expect(describeConfig(readConfig({}, CWD))).not.toContain('TLS:');
  });
});
