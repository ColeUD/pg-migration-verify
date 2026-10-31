import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { helpText, parseCliArgs } from '../../src/cli.js';
import { readConfig } from '../../src/config.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from '../../src/package-info.js';
import { displayDirectory } from '../../src/tools/repo.js';

describe('parseCliArgs', () => {
  it('serves MCP when there are no arguments', () => {
    expect(parseCliArgs([])).toEqual({ kind: 'serve' });
  });

  it.each([
    [['--help'], 'help'],
    [['-h'], 'help'],
    [['--version'], 'version'],
    [['-v'], 'version'],
  ] as const)('maps %j to %s', (args, kind) => {
    expect(parseCliArgs(args)).toEqual({ kind });
  });

  it.each([[['--verbose']], [['--help', '--version']], [['serve']]])(
    'rejects %j with a pointer to --help',
    (args) => {
      const command = parseCliArgs(args);
      expect(command.kind).toBe('error');
      expect(command.kind === 'error' && command.message).toContain('--help');
    },
  );
});

describe('helpText', () => {
  it('names the version, every environment variable and every tool', () => {
    const text = helpText();
    expect(text).toContain(`${PACKAGE_NAME} ${PACKAGE_VERSION}`);
    for (const name of [
      'PGMV_DATABASE_URL',
      'DATABASE_URL',
      'PGMV_PROJECT_DIR',
      'PGMV_MIGRATIONS_DIR',
      'PGMV_DEFAULT_SCHEMA',
      'PGMV_STATEMENT_TIMEOUT_MS',
      'verify_all',
      'verify_migration',
      'expected_objects',
      'diff_history',
      'list_repo_migrations',
      'list_recorded_migrations',
    ]) {
      expect(text).toContain(name);
    }
  });
});

describe('package info', () => {
  it('matches package.json', () => {
    const json = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as {
      name: string;
      version: string;
    };
    expect({ name: PACKAGE_NAME, version: PACKAGE_VERSION }).toEqual({
      name: json.name,
      version: json.version,
    });
  });
});

describe('displayDirectory', () => {
  const projectDir = path.resolve('/work/app');
  const config = readConfig({}, projectDir);

  it('shows a directory inside the project relative to it, with forward slashes', () => {
    expect(displayDirectory(config, path.join(projectDir, 'supabase', 'migrations'))).toBe(
      'supabase/migrations',
    );
    expect(displayDirectory(config, projectDir)).toBe('.');
  });

  it('shows a directory outside the project as an absolute path', () => {
    const outside = path.resolve('/elsewhere/migrations');
    expect(displayDirectory(config, outside)).toBe(outside);
  });
});
