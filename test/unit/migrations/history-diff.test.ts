import { describe, expect, it } from 'vitest';
import { diffHistory } from '../../../src/migrations/history-diff.js';
import type { MigrationFile, RecordedMigration } from '../../../src/model.js';

function file(version: string, name: string): MigrationFile {
  const fileName = `${version}_${name}.sql`;
  return { version, name, fileName, path: `/repo/${fileName}`, checksum: 'a'.repeat(64) };
}

function recorded(version: string, name: string | null = null): RecordedMigration {
  return { version, name };
}

const versions = (items: readonly { version: string }[]): string[] => items.map((i) => i.version);

describe('diffHistory', () => {
  it('reports everything in both when repo and history agree', () => {
    const files = [file('1', 'create_profiles'), file('2', 'create_todos')];

    const diff = diffHistory(files, [
      recorded('1', 'create_profiles'),
      recorded('2', 'create_todos'),
    ]);

    expect(diff.onlyInRepo).toEqual([]);
    expect(diff.onlyInDatabase).toEqual([]);
    expect(diff.inBoth).toEqual([
      { file: files[0], recorded: recorded('1', 'create_profiles'), nameMatches: true },
      { file: files[1], recorded: recorded('2', 'create_todos'), nameMatches: true },
    ]);
  });

  it('separates pending files from recorded versions that have no file', () => {
    const diff = diffHistory(
      [file('1', 'create_profiles'), file('3', 'create_projects')],
      [recorded('1'), recorded('2')],
    );

    expect(versions(diff.onlyInRepo)).toEqual(['3']);
    expect(diff.onlyInDatabase).toEqual([recorded('2')]);
    expect(versions(diff.inBoth.map((b) => b.file))).toEqual(['1']);
  });

  it.each([
    ['the recorded name equals the file name', 'create_todos', true],
    ['the file was renamed after being applied', 'todos', false],
    ['the history row has no name', null, null],
  ])('sets nameMatches when %s', (_case, recordedName, expected) => {
    const diff = diffHistory([file('1', 'create_todos')], [recorded('1', recordedName)]);

    expect(diff.inBoth[0]?.nameMatches).toBe(expected);
  });

  it('matches by version only, so a renamed file is not reported as missing', () => {
    const diff = diffHistory([file('5', 'add_due_date')], [recorded('5', 'add_deadline')]);

    expect(diff.onlyInRepo).toEqual([]);
    expect(diff.onlyInDatabase).toEqual([]);
    expect(diff.inBoth).toHaveLength(1);
  });

  it('sorts every list by numeric version whatever the input order', () => {
    const diff = diffHistory(
      [file('10', 'c'), file('9', 'b'), file('100', 'd'), file('2', 'a')],
      [recorded('9'), recorded('1000'), recorded('2'), recorded('11')],
    );

    expect(versions(diff.onlyInRepo)).toEqual(['10', '100']);
    expect(versions(diff.onlyInDatabase)).toEqual(['11', '1000']);
    expect(versions(diff.inBoth.map((b) => b.file))).toEqual(['2', '9']);
  });

  it('pairs every file sharing a recorded version with that row', () => {
    const diff = diffHistory([file('1', 'a'), file('1', 'b')], [recorded('1', 'a')]);

    expect(diff.inBoth.map((b) => [b.file.name, b.nameMatches])).toEqual([
      ['a', true],
      ['b', false],
    ]);
  });

  it('handles empty inputs on either side', () => {
    expect(diffHistory([], [])).toEqual({ onlyInRepo: [], onlyInDatabase: [], inBoth: [] });
    expect(versions(diffHistory([file('1', 'a')], []).onlyInRepo)).toEqual(['1']);
    expect(diffHistory([], [recorded('1')]).onlyInDatabase).toEqual([recorded('1')]);
  });
});
