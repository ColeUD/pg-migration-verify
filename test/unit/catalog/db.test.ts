import { createServer, type AddressInfo, type Socket } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../../../src/catalog/db.js';
import { DatabaseError } from '../../../src/catalog/errors.js';

// No server is needed: these inputs are rejected before any connection is attempted.
const URL_ = 'postgres://app_user:test-only-password@db.example.test:5432/postgres';

describe('createDatabase', () => {
  it.each([0, -1, 1.5, Number.NaN, 2 ** 31])('rejects statement timeout %s', (timeout) => {
    expect(() => createDatabase(URL_, { statementTimeoutMs: timeout })).toThrow(DatabaseError);
  });

  it('accepts the default and explicit timeouts without connecting', () => {
    expect(() => createDatabase(URL_)).not.toThrow();
    expect(() => createDatabase(URL_, { statementTimeoutMs: 1 })).not.toThrow();
  });

  it.each([
    'not a url',
    'mysql://app_user:test-only-password@db.example.test/postgres',
    'postgres://app_user:test only password@[broken/postgres',
    '',
  ])('reports %j as a configuration error without echoing it', async (connectionString) => {
    const attempt = createDatabase(connectionString).readOnly(() => Promise.resolve(1));
    await expect(attempt).rejects.toMatchObject({
      name: 'DatabaseError',
      category: 'configuration',
      message: 'connection string is not a valid postgres:// URL',
    });
  });
});

/**
 * A local TCP server standing in for Postgres. `onConnection` decides how much of the protocol
 * it speaks; nothing ever reaches a real database.
 */
async function fakeServer(
  onConnection: (socket: Socket) => void,
): Promise<{ url: string; port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => undefined);
    onConnection(socket);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `postgres://app_user:test-only-password@127.0.0.1:${port}/postgres`,
    port,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}

/** A backend protocol message: type byte, int32 length (including itself), body. */
function backendMessage(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(5);
  header.write(type, 0, 'ascii');
  header.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([header, body]);
}

/** AuthenticationOk followed by ReadyForQuery (idle): a server that accepts the login. */
const LOGIN_OK = Buffer.concat([
  backendMessage('R', Buffer.alloc(4)),
  backendMessage('Z', Buffer.from('I')),
]);

function expectNoConnectionDetails(message: string, port: number): void {
  for (const fragment of ['test-only-password', 'app_user', '127.0.0.1', String(port)]) {
    expect(message).not.toContain(fragment);
  }
}

describe('createDatabase against a server that stops answering', () => {
  it('gives up connecting after connectTimeoutMs, with a connection error', async () => {
    // Accepts the TCP connection and never answers the startup packet (a firewall or a stuck
    // proxy). pg.Client's own timeout would report a bare "timeout expired".
    const server = await fakeServer(() => undefined);
    try {
      const started = Date.now();
      const error: unknown = await createDatabase(server.url, { connectTimeoutMs: 200 })
        .readOnly(() => Promise.resolve(1))
        .catch((err: unknown) => err);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(error).toBeInstanceOf(DatabaseError);
      const { category, message } = error as DatabaseError;
      expect(category).toBe('connection');
      expect(message).toMatch(
        /^could not connect to the database server \(connection timed out after 200 ms\)/,
      );
      expectNoConnectionDetails(message, server.port);
    } finally {
      await server.close();
    }
  });

  it('bounds every statement, also BEGIN, when replies stop after login', async () => {
    // Logs in, then swallows every query: a dropped VPN or a dead pooler after the handshake.
    // statement_timeout cannot help, because it is set after BEGIN and needs a working server.
    const queries: string[] = [];
    const server = await fakeServer((socket) => {
      let startup = true;
      socket.on('data', (data) => {
        if (startup) {
          startup = false;
          socket.write(LOGIN_OK);
        } else if (data[0] === 0x51) {
          // 'Q' simple query: length, then NUL-terminated text.
          queries.push(data.subarray(5, data.indexOf(0, 5)).toString('utf8'));
        }
      });
    });
    try {
      const started = Date.now();
      const error: unknown = await createDatabase(server.url, { statementTimeoutMs: 50 })
        .readOnly(() => Promise.resolve(1))
        .catch((err: unknown) => err);
      expect(Date.now() - started).toBeLessThan(8_000);
      expect(error).toBeInstanceOf(DatabaseError);
      const { category, message } = error as DatabaseError;
      expect(category).toBe('timeout');
      expect(message).toMatch(/^no reply from the server within the time limit/);
      expectNoConnectionDetails(message, server.port);
      // One snapshot for the whole call: every catalog query sees the same moment.
      expect(queries[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    } finally {
      await server.close();
    }
  }, 15_000);

  it.each([0, -1, 1.5])('rejects connect timeout %s', (timeout) => {
    expect(() => createDatabase(URL_, { connectTimeoutMs: timeout })).toThrow(DatabaseError);
  });
});
