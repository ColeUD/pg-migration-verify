import { describe, expect, it } from 'vitest';
import * as queries from '../../../src/catalog/queries.js';
import { defineCatalogQuery } from '../../../src/catalog/queries.js';

interface QueryShape {
  id: string;
  text: string;
}

function isQuery(value: unknown): value is QueryShape {
  return typeof value === 'object' && value !== null && 'id' in value && 'text' in value;
}

/** Every exported query constant (anything with an id and a text). */
const exportedQueries: [string, QueryShape][] = Object.entries(
  queries as Record<string, unknown>,
).flatMap(([name, value]): [string, QueryShape][] => (isQuery(value) ? [[name, value]] : []));

describe('defineCatalogQuery', () => {
  it.each([
    ['SELECT 1', 'SELECT 1'],
    ['  select 1  ', 'select 1'],
    ['WITH x AS (SELECT 1) SELECT * FROM x', 'WITH x AS (SELECT 1) SELECT * FROM x'],
    ['\n  SELECT\n  2\n', 'SELECT\n  2'],
  ])('accepts a single read statement: %j', (text, stored) => {
    expect(defineCatalogQuery('q', text).text).toBe(stored);
  });

  it.each([
    ['INSERT INTO t VALUES (1)', /must start with SELECT or WITH/],
    ['UPDATE t SET a = 1', /must start with SELECT or WITH/],
    ['DELETE FROM t', /must start with SELECT or WITH/],
    ['DROP TABLE t', /must start with SELECT or WITH/],
    ['SET search_path = public', /must start with SELECT or WITH/],
    ['SELECTED', /must start with SELECT or WITH/],
    ['-- comment\nSELECT 1', /must start with SELECT or WITH/],
    ['', /must start with SELECT or WITH/],
    ['SELECT 1; DROP TABLE t', /single statement/],
    ['SELECT 1;', /single statement/],
    ["SELECT ';'", /single statement/],
  ])('rejects %j', (text, error) => {
    expect(() => defineCatalogQuery('q', text)).toThrow(error);
  });

  it('names the offending query in the error', () => {
    expect(() => defineCatalogQuery('bad_query', 'DELETE FROM t')).toThrow(/bad_query/);
  });

  it('returns a frozen object', () => {
    expect(Object.isFrozen(defineCatalogQuery('q', 'SELECT 1'))).toBe(true);
  });
});

describe('exported catalog queries', () => {
  it('exports the snapshot and history queries', () => {
    expect(exportedQueries.length).toBeGreaterThanOrEqual(15);
  });

  it.each(exportedQueries)('%s is a single SELECT or WITH statement', (_, query) => {
    expect(query.text).toMatch(/^(SELECT|WITH)\b/);
    expect(query.text).not.toContain(';');
  });

  it.each(exportedQueries)('%s never uses information_schema', (_, query) => {
    // information_schema hides objects the connected role has no privileges on.
    expect(query.text).not.toMatch(/information_schema/i);
  });

  it('has unique ids', () => {
    const ids = exportedQueries.map(([, q]) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
