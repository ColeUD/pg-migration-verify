/**
 * Post-build smoke test of the compiled bin, the way an MCP client runs it: `node dist/index.js`
 * as a child process speaking MCP over stdio. Unit tests cover the tools in process; this proves
 * the build output starts, serves the six tools, parses a migration, and fails cleanly without a
 * database URL. Run `npm run build` first.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'index.js');
const fixture = path.join(root, 'test', 'fixtures', 'smoke-project');
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

// The child must not see a database URL from the developer's or CI's environment.
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name, value]) => value !== undefined && !/^(PGMV_|DATABASE_URL$)/i.test(name),
  ),
);

// --version prints to stdout and exits without starting an MCP session.
const versionRun = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', env });
assert.equal(versionRun.status, 0, versionRun.stderr);
assert.equal(versionRun.stdout.trim(), version);

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [bin],
  cwd: fixture,
  env,
  stderr: 'pipe',
});
let stderr = '';
transport.stderr?.on('data', (chunk) => {
  stderr += String(chunk);
});

const client = new Client({ name: 'pgmv-smoke', version: '0.0.0' });
try {
  await client.connect(transport);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [
    'diff_history',
    'expected_objects',
    'list_recorded_migrations',
    'list_repo_migrations',
    'verify_all',
    'verify_migration',
  ]);
  assert.ok(tools.every((t) => t.annotations?.readOnlyHint === true));

  const expected = await client.callTool({
    name: 'expected_objects',
    arguments: { file: '20240101000000' },
  });
  const expectedText = textOf(expected);
  assert.notEqual(expected.isError, true, expectedText);
  assert.match(expectedText, /^20240101000000_create_profiles\.sql: 2 statements/);
  assert.match(expectedText, /table public\.profiles/);
  assert.match(expectedText, /column public\.profiles\.username \(text, not null\)/);
  assert.match(expectedText, /row level security on public\.profiles/);

  const verifyAll = await client.callTool({ name: 'verify_all', arguments: {} });
  assert.equal(verifyAll.isError, true);
  assert.match(textOf(verifyAll), /^No database connection configured\. Set PGMV_DATABASE_URL/);
} finally {
  await client.close();
}

assert.match(stderr, /serving MCP on stdio\. Database URL: not set/);
console.log('smoke ok');

/** @param {{ content: { type: string; text?: string }[] }} result */
function textOf(result) {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}
