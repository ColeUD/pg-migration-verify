import { describe, expect, it } from 'vitest';
import type { MigrationFile } from '../../src/model.js';
import { compareMigrationFiles, compareVersions } from '../../src/versions.js';

describe('compareVersions', () => {
  it.each([
    ['9', '10', -1],
    ['10', '9', 1],
    ['20240101000000', '20240101000001', -1],
    ['0010', '10', 1],
    ['123', '123', 0],
  ])('compare(%s, %s) has sign %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe('compareMigrationFiles', () => {
  const file = (fileName: string): MigrationFile => {
    const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
    return { version, name, fileName, path: `/repo/${fileName}`, checksum: '0'.repeat(64) };
  };

  it('orders by version first, then by file name for duplicate versions', () => {
    const files = ['0010_c.sql', '10_b.sql', '10_a.sql', '9_z.sql'].map(file);
    expect(files.sort(compareMigrationFiles).map((f) => f.fileName)).toEqual([
      '9_z.sql',
      '10_a.sql',
      '10_b.sql',
      '0010_c.sql',
    ]);
  });
});
