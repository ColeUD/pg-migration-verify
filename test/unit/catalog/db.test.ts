import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../../src/catalog/db.js';
import { DatabaseError } from '../../../src/catalog/errors.js';

// No server is needed: these inputs are rejected before any connection is attempted.
const URL_ = 'postgres://app_user:test-only-password@db.example.test:5432/postgres';

describe('createDatabase', () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('rejects statement timeout %s', (timeout) => {
    expect(() => createDatabase(URL_, { statementTimeoutMs: timeout })).toThrow(DatabaseError);
  });

  it('accepts the default and explicit timeouts without connecting', () => {
    expect(() => createDatabase(URL_)).not.toThrow();
    expect(() => createDatabase(URL_, { statementTimeoutMs: 1 })).not.toThrow();
  });

  it.each([
    'not a url',
    'mysql://app_user:test-only-password@db.example.test/postgres',
    'postgres://app_user:test only password@[broken/postgres',
    '',
  ])('reports %j as a configuration error without echoing it', async (connectionString) => {
    const attempt = createDatabase(connectionString).readOnly(() => Promise.resolve(1));
    await expect(attempt).rejects.toMatchObject({
      name: 'DatabaseError',
      category: 'configuration',
      message: 'connection string is not a valid postgres:// URL',
    });
  });
});
