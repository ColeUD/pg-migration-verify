import { resolveMigration } from '../migrations/files.js';
import { formatExpectedObjects, describeExpected } from '../verify/index.js';
import type { ToolContext, ToolResult } from './context.js';
import { noteEntry } from './entries.js';
import { loadRepoMigrations, parseMigrations } from './repo.js';
import type { ExpectedObjectsInput, ExpectedObjectsOutput } from './schemas.js';

/**
 * `expected_objects`: what the parser thinks one migration does, without touching a database.
 * Useful on its own (review a migration before applying it) and to explain a verification result.
 */
export async function expectedObjects(
  context: ToolContext,
  input: ExpectedObjectsInput,
): Promise<ToolResult<ExpectedObjectsOutput>> {
  const { listing } = await loadRepoMigrations(context, input.dir);
  const target = resolveMigration(listing.files, input.file);
  const [migration] = await parseMigrations(context, [target]);
  if (migration === undefined) throw new Error(`Could not parse ${target.fileName}.`);
  const { parsed } = migration;
  return {
    text: formatExpectedObjects(parsed),
    structured: {
      file: parsed.file,
      statementCount: parsed.statementCount,
      objects: parsed.objects.map((o) => ({
        kind: o.kind,
        key: o.key,
        expect: o.expect,
        description: describeExpected(o),
        line: o.source.line,
        inDoBlock: o.source.inDoBlock === true,
      })),
      notes: parsed.notes.map(noteEntry),
    },
  };
}
