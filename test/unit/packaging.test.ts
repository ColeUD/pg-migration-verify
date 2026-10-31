/**
 * What gets published and how it is started: package.json, the shipped lockfile, the plugin
 * manifests and CI. Drift between them fails nothing at runtime, it only surfaces after a
 * release, so it is checked here. scripts/check-pack.mjs checks the packed file list itself.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PACKAGE_VERSION } from '../../src/package-info.js';
import { readRepoFile, readRepoJson } from '../helpers/repo-files.js';

interface PackageJson {
  name: string;
  version: string;
  author?: string;
  homepage?: string;
  repository?: { type: string; url: string };
  bugs?: { url: string };
  files: string[];
  engines: { node: string };
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
}

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  dependencies?: Record<string, string>;
}

interface Lockfile {
  name: string;
  version: string;
  packages: Record<string, LockEntry>;
}

interface PluginManifest {
  name: string;
  version: string;
  author: { name: string };
  repository: string;
}

const pkg = readRepoJson('package.json') as PackageJson;
const lock = readRepoJson('npm-shrinkwrap.json') as Lockfile;
const plugin = readRepoJson('.claude-plugin/plugin.json') as PluginManifest;

const EXACT_VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

describe('runtime dependencies', () => {
  it('are pinned to exact versions in package.json', () => {
    for (const [name, range] of Object.entries(pkg.dependencies)) {
      expect(range, name).toMatch(EXACT_VERSION);
    }
  });

  // pg's own dependencies (pg-connection-string, pg-protocol, pg-pool) are caret ranges, so only a
  // published lockfile fixes what `npx pg-migration-verify@x.y.z` installs.
  it('ship as npm-shrinkwrap.json, the only lockfile', () => {
    expect(pkg.files).toContain('npm-shrinkwrap.json');
    expect(existsSync(new URL('../../package-lock.json', import.meta.url))).toBe(false);
    expect(lock.name).toBe(pkg.name);
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.dependencies).toEqual(pkg.dependencies);
  });

  it('resolve to one fixed, integrity-checked version each in the shrinkwrap', () => {
    const runtime = Object.entries(lock.packages).filter(
      ([key, entry]) => key !== '' && entry.dev !== true && entry.devOptional !== true,
    );
    for (const [key, entry] of runtime) {
      expect(entry.version, key).toMatch(EXACT_VERSION);
      expect(entry.resolved, key).toMatch(/^https:\/\/registry\.npmjs\.org\//);
      expect(entry.integrity, key).toMatch(/^sha512-/);
    }
    const names = runtime.map(([key]) => key.replace(/^.*node_modules\//, ''));
    for (const name of [
      ...Object.keys(pkg.dependencies),
      'pg-connection-string',
      'pg-protocol',
      'pg-pool',
    ]) {
      expect(names).toContain(name);
    }
  });
});

describe('package metadata', () => {
  it('links the repository, so npm resolves the README links and `npm repo` works', () => {
    expect(pkg.repository).toEqual({
      type: 'git',
      url: `git+${plugin.repository}.git`,
    });
    expect(pkg.homepage).toBe(`${plugin.repository}#readme`);
    expect(pkg.bugs).toEqual({ url: `${plugin.repository}/issues` });
    expect(pkg.author).toBe(plugin.author.name);
  });

  it('builds from a clean dist before every pack and publish', () => {
    expect(pkg.scripts.build).toMatch(/^npm run clean && /);
    expect(pkg.scripts.prepack).toBe('npm run build');
  });
});

describe('release version', () => {
  const version = pkg.version;

  it('is what --version prints', () => {
    expect(PACKAGE_VERSION).toBe(version);
  });

  it('is the plugin version, so installed plugins update', () => {
    expect(plugin.version).toBe(version);
    const marketplace = readRepoJson('.claude-plugin/marketplace.json') as {
      plugins: { name: string }[];
    };
    expect(marketplace.plugins.map((p) => p.name)).toEqual([plugin.name]);
  });

  it('is the version the plugin starts with npx', () => {
    const mcp = readRepoJson('.mcp.json') as {
      mcpServers: Record<string, { args: string[] }>;
    };
    expect(mcp.mcpServers.pgmv?.args).toContain(`${pkg.name}@${version}`);
  });

  it('is the version every README snippet starts', () => {
    const pinned = [...readRepoFile('README.md').matchAll(/pg-migration-verify@(\d[\w.-]*)/g)].map(
      (m) => m[1],
    );
    // At least the claude mcp add, Claude Desktop and Windows snippets.
    expect(pinned.length).toBeGreaterThanOrEqual(3);
    for (const v of pinned) expect(v).toBe(version);
  });
});

describe('CI', () => {
  it('tests the oldest Node version engines.node allows', () => {
    const minimum = /^>=(\d+)$/.exec(pkg.engines.node)?.[1];
    expect(minimum).toBeDefined();
    // The first `node: [...]` list is the check job's matrix.
    const matrix = /^\s+node: \[([\d, ]+)\]/m.exec(readRepoFile('.github/workflows/ci.yml'))?.[1];
    const majors = matrix?.split(',').map((v) => v.trim()) ?? [];
    expect(majors).toContain(minimum);
    expect(majors.length).toBeGreaterThanOrEqual(3);
  });
});
