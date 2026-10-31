/**
 * Checks what `npm publish` would ship, from `npm pack --dry-run`: the bin, the shrinkwrap that
 * pins the dependency tree `npx pg-migration-verify@x.y.z` installs, and nothing that does not
 * belong in a bin-only package (sources, tests, type declarations, source maps). Run
 * `npm run build` first; scripts are skipped here so the check sees that build.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Everything outside dist/ that belongs in the package. */
const ROOT_FILES = ['package.json', 'README.md', 'LICENSE', 'npm-shrinkwrap.json'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A constant command through the shell, so the npm.cmd shim also starts on Windows.
const output = execSync('npm pack --dry-run --json --ignore-scripts', {
  cwd: root,
  encoding: 'utf8',
});
const [pack] = JSON.parse(output);
const files = pack.files.map((f) => f.path.replaceAll('\\', '/')).sort();

for (const required of ROOT_FILES) {
  assert.ok(files.includes(required), `${required} is missing from the package`);
}
assert.ok(files.includes('dist/index.js'), 'dist/index.js is missing: run npm run build first');

// Sources, tests, type declarations and source maps all fail this.
const unwanted = files.filter((f) =>
  f.startsWith('dist/') ? !f.endsWith('.js') : !ROOT_FILES.includes(f),
);
assert.deepEqual(unwanted, [], 'only dist/*.js and the root files belong in the package');

for (const file of files) console.log(file);
console.log(`pack ok: ${files.length} files, ${pack.size} bytes packed`);
