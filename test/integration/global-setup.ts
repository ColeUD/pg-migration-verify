import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** Superuser URL of the server the integration tests use (database `postgres`). */
    adminUrl: string;
  }
}

/**
 * Starts one Postgres server for the whole integration run and hands its admin URL to the tests
 * via `inject('adminUrl')`. Each test file then creates its own database (see helpers/test-db.ts).
 *
 * - `TEST_DATABASE_URL` set (CI service container, local server): used as is, nothing to stop.
 * - otherwise: embedded-postgres with throwaway data in the OS temp dir (initdb takes ~5 s). It
 *   uses a free port and a fresh directory, so a server orphaned by a killed run cannot collide.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const externalUrl = process.env.TEST_DATABASE_URL;
  if (externalUrl !== undefined && externalUrl !== '') {
    project.provide('adminUrl', externalUrl);
    return async () => {
      // The external server belongs to whoever started it.
    };
  }

  assertBinariesCanStart();
  const databaseDir = await mkdtemp(path.join(tmpdir(), 'pmv-pg-'));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    initdbFlags: ['--encoding=UTF8', '--locale=C'],
    onLog: () => undefined,
    // npm 11 skips the binary package's postinstall that restores symlinks on Linux and macOS.
    autoRehydrateSymlinks: process.platform !== 'win32',
  });
  try {
    await server.initialise();
    await server.start();
  } catch (err) {
    await rm(databaseDir, { recursive: true, force: true });
    throw err;
  }
  project.provide('adminUrl', `postgres://postgres:postgres@127.0.0.1:${port}/postgres`);

  return async () => {
    await server.stop();
    await rm(databaseDir, { recursive: true, force: true });
  };
}

/** Windows refuses to start a program whose path reaches MAX_PATH (260 characters). */
const WINDOWS_MAX_PATH = 260;

/**
 * On Windows, a checkout in a deep directory puts the Postgres binaries past MAX_PATH. Spawning
 * them then fails with a bare ENOENT that embedded-postgres does not handle, which kills the
 * whole run with a misleading "file not found". Fail early with the actual cause instead.
 */
function assertBinariesCanStart(): void {
  if (process.platform !== 'win32') return;
  // Resolved, not imported: the package is Windows-only, and this mirrors its own path logic.
  const entry = createRequire(import.meta.url).resolve('@embedded-postgres/windows-x64');
  const initdb = path.resolve(path.dirname(entry), '..', 'native', 'bin', 'initdb.exe');
  if (initdb.length >= WINDOWS_MAX_PATH) {
    const message =
      `The embedded Postgres binaries are at a ${initdb.length}-character path, over the ` +
      `${WINDOWS_MAX_PATH}-character limit Windows has for starting programs. Move the ` +
      `repository to a shorter path, map its parent directory to a drive letter ` +
      `(subst P: <parent of the repo>, then run from P:\\<repo folder>; mapping the repo itself ` +
      `trips vitest), or point TEST_DATABASE_URL at an existing server.`;
    // Also printed directly: in deep directories vitest 5 can crash while source-mapping a
    // globalSetup error's stack, and the thrown message would never be shown.
    console.error(message);
    throw new Error(message);
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not determine a free port'));
      });
    });
  });
}
