/**
 * The setup instructions a user copies from the README and the plugin's skill. Nothing else would
 * notice when they stop working: the integration tests use their own role, and no test runs the
 * Claude Code CLI. test/integration/readme-role.test.ts runs the role SQL itself.
 */
import { describe, expect, it } from 'vitest';
import { createdRoles, readOnlyRoleSql, readRepoFile } from '../helpers/repo-files.js';

const README = readRepoFile('README.md');
const SKILL = readRepoFile('skills/verify-migrations/SKILL.md');

/** Example connection strings with credentials: `postgres(ql)://<user>:<password>@<host>...`. */
function exampleUrls(text: string): { url: string; user: string; host: string }[] {
  return [
    ...text.matchAll(/postgres(?:ql)?:\/\/([^\s:@"'`/]+):[^\s@"'`]*@([^\s:/?"'`]+)[^\s"'`]*/g),
  ].map((m) => ({ url: m[0], user: m[1]!, host: m[2]! }));
}

describe('README read-only role', () => {
  const roles = createdRoles(readOnlyRoleSql());

  it('creates exactly one role, with a name Postgres allows', () => {
    expect(roles).toHaveLength(1);
    // Postgres rejects CREATE ROLE pg_... with 42939 "role name is reserved", even for superusers.
    expect(roles[0]).not.toMatch(/^pg_/i);
  });

  it('is the role every example connection string and the pooler note use', () => {
    const urls = exampleUrls(README);
    expect(urls.length).toBeGreaterThanOrEqual(2);
    for (const { user } of urls) expect(user).toBe(roles[0]);
    expect(README).toContain(`(\`${roles[0]!}.<project-ref>\`)`);
  });

  it('is never named with the reserved pg_ prefix anywhere in the docs', () => {
    for (const text of [README, SKILL]) {
      expect(text).not.toMatch(/CREATE ROLE\s+"?pg_/i);
      expect(text).not.toMatch(/postgres(?:ql)?:\/\/pg_/i);
    }
  });
});

describe('connection string examples', () => {
  // node-postgres, unlike libpq, connects without TLS unless the URL or PGSSLMODE asks for it.
  it('ask for TLS whenever they point at a remote server', () => {
    const remote = exampleUrls(README).filter(
      ({ host }) => !['localhost', '127.0.0.1', '[::1]'].includes(host),
    );
    expect(remote.length).toBeGreaterThanOrEqual(2);
    for (const { url } of remote) expect(url).toMatch(/[?&]sslmode=verify-full\b/);
  });
});

describe('plugin option instructions', () => {
  // `claude plugin configure <plugin>` only lists options; saving needs `/plugin configure` inside
  // Claude Code or `--values-stdin`.
  it.each([
    ['README.md', README],
    ['SKILL.md', SKILL],
  ])('%s never presents the listing command as the way to set a value', (_file, text) => {
    for (const [line] of text.matchAll(/^.*claude plugin configure [\w@.-]+.*$/gm)) {
      expect(line).toContain('--values-stdin');
    }
  });

  it.each([
    ['README.md', README],
    ['SKILL.md', SKILL],
  ])('%s gives the in-app command', (_file, text) => {
    expect(text).toContain('/plugin configure pg-migration-verify@pg-migration-verify');
  });
});
