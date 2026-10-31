import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeConfig, readConfig, resolveDirectory, type Config } from '../../src/config.js';

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
  const config = readConfig({ PGMV_PROJECT_DIR: path.resolve('/repos/todo-app') }, CWD);

  it.each([
    ['no directory', undefined, config.migrationsDir],
    ['an empty directory', '  ', config.migrationsDir],
    ['a relative directory', 'db/migrations', path.resolve('/repos/todo-app/db/migrations')],
    ['an absolute directory', path.resolve('/elsewhere/sql'), path.resolve('/elsewhere/sql')],
  ])('resolves %s against the project dir', (_case, dir, expected) => {
    expect(resolveDirectory(config, dir)).toBe(expected);
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
