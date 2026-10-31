import { describe, expect, it } from 'vitest';
import type { MigrationFile } from '../../src/model.js';
import {
  compareMigrationFiles,
  compareVersions,
  mixedVersionLengthWarning,
} from '../../src/versions.js';

const file = (fileName: string): MigrationFile => {
  const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
  return { version, name, fileName, path: `/repo/${fileName}`, checksum: '0'.repeat(64) };
};

describe('compareVersions', () => {
  // As the Supabase CLI compares them: strings, not numbers.
  it.each([
    ['9', '10', 1],
    ['10', '9', -1],
    ['20240101000000', '20240101000001', -1],
    ['0010', '10', -1],
    ['123', '123', 0],
  ])('compare(%s, %s) has sign %i', (a, b, sign) => {
    expect(Math.sign(compareVersions(a, b))).toBe(sign);
  });
});

describe('compareMigrationFiles', () => {
  it.each([
    [
      ['0010_c.sql', '10_b.sql', '10_a.sql', '9_z.sql'],
      ['0010_c.sql', '10_a.sql', '10_b.sql', '9_z.sql'],
    ],
    // '0' sorts before '_', so the CLI applies 10_b.sql before 1_a.sql.
    [
      ['1_a.sql', '10_b.sql'],
      ['10_b.sql', '1_a.sql'],
    ],
    [
      ['20240102000000_b.sql', '20240101000000_a.sql'],
      ['20240101000000_a.sql', '20240102000000_b.sql'],
    ],
  ])('orders %j by file name, byte by byte, as the Supabase CLI applies them', (names, sorted) => {
    expect(
      names
        .map(file)
        .sort(compareMigrationFiles)
        .map((f) => f.fileName),
    ).toEqual(sorted);
  });
});

describe('mixedVersionLengthWarning', () => {
  it('warns when versions differ in length, since file-name order is then not numeric', () => {
    expect(mixedVersionLengthWarning(['9_a.sql', '10_b.sql'].map(file))).toMatch(
      /^Versions of different lengths: .*file-name order/,
    );
  });

  it('stays quiet for versions of one length', () => {
    expect(
      mixedVersionLengthWarning(['20240101000000_a.sql', '20240102000000_b.sql'].map(file)),
    ).toBeNull();
    expect(mixedVersionLengthWarning([])).toBeNull();
  });
});
