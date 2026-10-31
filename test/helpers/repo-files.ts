import { readFileSync } from 'node:fs';

/**
 * Files at the repository root that tests check against each other and against the code: the
 * README a user copies from, the plugin manifests, package.json and CI. Read relative to this
 * module, so the tests do not depend on the working directory.
 */
export function readRepoFile(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

export function readRepoJson(relativePath: string): unknown {
  return JSON.parse(readRepoFile(relativePath));
}

/**
 * The body of the README section with this `## ` heading, up to the next heading of the same
 * level.
 */
export function readmeSection(heading: string): string {
  const readme = readRepoFile('README.md');
  const start = readme.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`README.md has no "## ${heading}" section`);
  const end = readme.indexOf('\n## ', start + 1);
  return readme.slice(start, end === -1 ? undefined : end);
}

/** The README's read-only role SQL, exactly as a user copies it. */
export function readOnlyRoleSql(): string {
  const block = /```sql\n([\s\S]*?)```/.exec(readmeSection('Read-only role'));
  if (block?.[1] === undefined) throw new Error('README "Read-only role" has no ```sql block');
  return block[1];
}

/** The role names the README's role SQL creates. */
export function createdRoles(sql: string): string[] {
  return [...sql.matchAll(/\bCREATE ROLE\s+("?)(\w+)\1/gi)].map((m) => m[2]!);
}
