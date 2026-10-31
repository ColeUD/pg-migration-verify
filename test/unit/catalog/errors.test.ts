import { describe, expect, it } from 'vitest';
import type { DatabaseErrorCategory } from '../../../src/catalog/errors.js';
import {
  DatabaseError,
  redactSecrets,
  sanitizeDatabaseError,
} from '../../../src/catalog/errors.js';

// Synthetic connection details; nothing here is a real host or credential.
const PASSWORD = 's3cr@t/pw'; // decoded form
const ENCODED_PASSWORD = 's3cr%40t%2Fpw';
const HOST = 'db.example.test';
const PORT = '6543';
const URL_ = `postgres://app_user:${ENCODED_PASSWORD}@${HOST}:${PORT}/postgres`;

/** Fragments that must never survive sanitization. */
const FORBIDDEN = [URL_, PASSWORD, ENCODED_PASSWORD, `app_user:${ENCODED_PASSWORD}@`, HOST, PORT];

function expectNoSecrets(text: string): void {
  for (const fragment of FORBIDDEN) expect(text).not.toContain(fragment);
}

describe('redactSecrets', () => {
  it.each([
    ['the whole connection string', `cannot use ${URL_} now`],
    ['the decoded password on its own', `password "${PASSWORD}" rejected`],
    ['the encoded password on its own', `bad token ${ENCODED_PASSWORD}`],
    ['the host and port', `connect ECONNREFUSED ${HOST}:${PORT}`],
    ['a user:password@ fragment without a scheme', `at app_user:${ENCODED_PASSWORD}@${HOST}`],
    ['several URLs in one message', `${URL_} and postgresql://other:pw@elsewhere.test/db`],
    ['the URL-encoded connection string', `bad value ${encodeURIComponent(URL_)}`],
  ])('removes %s', (_, text) => {
    const redacted = redactSecrets(text, URL_);
    expectNoSecrets(redacted);
    expect(redacted).toContain('[redacted');
  });

  it('removes any postgres:// or postgresql:// URL, not only the configured one', () => {
    const text = 'try postgresql://someone:hunter2-test@10.0.0.9:5433/app or POSTGRES://x@y/z';
    expect(redactSecrets(text, URL_)).toBe(
      'try [redacted connection string] or [redacted connection string]',
    );
  });

  it('keeps a bare scheme, which carries no connection details', () => {
    const text = 'set PGMV_DATABASE_URL to a postgres:// URL';
    expect(redactSecrets(text, URL_)).toBe(text);
  });

  it('removes a password with unencoded special characters from an invalid URL', () => {
    const invalid = 'postgres://u:p@ss w/rd#1@host.test/db';
    const redacted = redactSecrets('password is p@ss w/rd#1 and p%40ss%20w%2Frd%231', invalid);
    expect(redacted).not.toContain('p@ss w/rd#1');
    expect(redacted).not.toContain('p%40ss%20w%2Frd%231');
  });

  it('removes a password passed as a query parameter', () => {
    const url = `postgres://${HOST}/postgres?user=app&password=query-test-only`;
    expect(redactSecrets('auth failed with query-test-only', url)).toBe(
      'auth failed with [redacted]',
    );
  });

  it('removes an IPv6 host', () => {
    const url = 'postgres://u:pw-test-only@[fd00::12]:5544/db';
    expect(redactSecrets('connect ECONNREFUSED fd00::12:5544', url)).not.toMatch(/fd00|5544/);
  });

  it('leaves text without connection details untouched', () => {
    const text = 'permission denied for schema supabase_migrations';
    expect(redactSecrets(text, URL_)).toBe(text);
  });

  it('copes with an empty connection string', () => {
    expect(redactSecrets('relation "todos" does not exist', '')).toBe(
      'relation "todos" does not exist',
    );
  });
});

/** An error as node-pg builds it from a server ErrorResponse. */
function serverError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code, severity: 'ERROR' });
}

/** An error as Node's socket or TLS layer raises it. */
function systemError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('sanitizeDatabaseError', () => {
  const cases: [string, unknown, DatabaseErrorCategory, RegExp][] = [
    [
      'refused connection',
      systemError('ECONNREFUSED', `connect ECONNREFUSED ${HOST}:${PORT}`),
      'connection',
      /^could not connect to the database server \(connection refused\)$/,
    ],
    [
      'unknown host',
      systemError('ENOTFOUND', `getaddrinfo ENOTFOUND ${HOST}`),
      'connection',
      /\(host name not found\)/,
    ],
    [
      'DNS hiccup',
      systemError('EAI_AGAIN', `getaddrinfo EAI_AGAIN ${HOST}`),
      'connection',
      /temporary DNS failure/,
    ],
    [
      'socket timeout',
      systemError('ETIMEDOUT', `connect ETIMEDOUT ${HOST}:${PORT}`),
      'connection',
      /timed out/,
    ],
    ['reset', systemError('ECONNRESET', 'read ECONNRESET'), 'connection', /reset/],
    [
      'unreachable',
      systemError('EHOSTUNREACH', `connect EHOSTUNREACH ${HOST}`),
      'connection',
      /unreachable/,
    ],
    [
      'IPv6+IPv4 connect failure',
      new AggregateError([systemError('ECONNREFUSED', `connect ECONNREFUSED ::1:${PORT}`)], ''),
      'connection',
      /connection refused/,
    ],
    [
      'driver connect timeout (pg.Client wording)',
      new Error('timeout expired'),
      'connection',
      /connection timed out\); the host did not answer/,
    ],
    [
      'driver connect timeout (pg-pool wording)',
      new Error('Connection terminated due to connection timeout'),
      'connection',
      /connection timed out/,
    ],
    [
      'no reply within query_timeout',
      new Error('Query read timeout'),
      'timeout',
      /^no reply from the server within the time limit/,
    ],
    [
      'unlisted socket error naming the resolved address',
      Object.assign(systemError('EADDRNOTAVAIL', 'connect EADDRNOTAVAIL 203.0.113.7:5432'), {
        syscall: 'connect',
        address: '203.0.113.7',
      }),
      'connection',
      /^could not connect to the database server \(address not available\)$/,
    ],
    [
      'socket error with a code nobody listed',
      Object.assign(systemError('EFOO', 'connect EFOO 203.0.113.7:5432'), {
        syscall: 'connect',
        address: '203.0.113.7',
      }),
      'connection',
      /^could not connect to the database server \(network error EFOO\)$/,
    ],
    [
      'socket error without a code',
      Object.assign(new Error('connect 203.0.113.7:5432'), { syscall: 'connect' }),
      'connection',
      /\(network error\)$/,
    ],
    [
      'TLS handshake against a server that does not speak TLS',
      systemError(
        'EPROTO',
        'write EPROTO A80C0000:error:0A00010B:SSL routines:tls_validate_record_header:wrong version number',
      ),
      'connection',
      /TLS handshake failed.*may not speak TLS/,
    ],
    [
      'IPv6+IPv4 connect failure with an unlisted code',
      new AggregateError([systemError('EADDRNOTAVAIL', `connect EADDRNOTAVAIL ::1:${PORT}`)], ''),
      'connection',
      /address not available/,
    ],
    [
      'empty AggregateError without codes',
      new AggregateError([new Error('first attempt failed')], ''),
      'query',
      /^first attempt failed$/,
    ],
    ['error with an empty message', new Error(''), 'query', /^unknown error$/],
    [
      'self-signed certificate',
      systemError('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'),
      'connection',
      /self-signed certificate.*sslmode/,
    ],
    [
      'certificate host mismatch',
      systemError(
        'ERR_TLS_CERT_ALTNAME_INVALID',
        `Hostname/IP does not match certificate's altnames: Host: ${HOST}.`,
      ),
      'connection',
      /does not match the host name.*sslmode/,
    ],
    [
      'server without SSL',
      new Error('The server does not support SSL connections'),
      'connection',
      /does not accept SSL.*sslmode=disable/,
    ],
    [
      'invalid URL',
      Object.assign(new TypeError('Invalid URL'), { code: 'ERR_INVALID_URL', input: URL_ }),
      'configuration',
      /^connection string is not a valid postgres:\/\/ URL$/,
    ],
    [
      'missing password',
      new Error('SASL: SCRAM-SERVER-FIRST-MESSAGE: client password must be a string'),
      'authentication',
      /requires a password/,
    ],
    [
      'wrong password',
      serverError('28P01', 'password authentication failed for user "app_user"'),
      'authentication',
      /rejected the user name or password/,
    ],
    [
      'pg_hba rejection',
      serverError(
        '28000',
        `no pg_hba.conf entry for host "${HOST}", user "app_user", database "postgres", no encryption`,
      ),
      'authentication',
      /does not allow this role.*may require SSL/,
    ],
    [
      'missing database',
      serverError('3D000', 'database "postgres" does not exist'),
      'configuration',
      /^database does not exist/,
    ],
    [
      'permission denied',
      serverError('42501', 'permission denied for schema supabase_migrations'),
      'permission',
      /^permission denied for schema supabase_migrations$/,
    ],
    [
      'statement timeout',
      serverError('57014', 'canceling statement due to statement timeout'),
      'timeout',
      /statement timeout/,
    ],
    [
      'write in a read-only transaction',
      serverError('25006', 'cannot execute INSERT in a read-only transaction'),
      'query',
      /^read-only transaction blocked a write$/,
    ],
    [
      'too many connections',
      serverError('53300', 'sorry, too many clients already'),
      'connection',
      /too many connections/,
    ],
    [
      'other server error, with a URL echoed in it',
      serverError('42P01', `relation "todos" does not exist near ${URL_}`),
      'query',
      /^relation "todos" does not exist near \[redacted connection string\] \(SQLSTATE 42P01\)$/,
    ],
    [
      'a server error that mentions certificates is not a TLS problem',
      serverError('42P01', 'relation "certificates" does not exist'),
      'query',
      /^relation "certificates" does not exist \(SQLSTATE 42P01\)$/,
    ],
    ['thrown string', `failed at ${URL_}`, 'query', /^failed at \[redacted connection string\]$/],
    ['thrown non-Error object', { reason: 42 }, 'query', /^unknown error$/],
    [
      'unexpected driver error echoing the password',
      new Error(`unexpected value ${PASSWORD} at ${HOST}:${PORT}`),
      'query',
      /^unexpected value \[redacted\] at \[redacted\]:\[redacted\]$/,
    ],
  ];

  it.each(cases)('maps %s', (_, err, category, message) => {
    const sanitized = sanitizeDatabaseError(err, URL_);
    expect(sanitized).toBeInstanceOf(DatabaseError);
    expect(sanitized.category).toBe(category);
    expect(sanitized.message).toMatch(message);
  });

  it.each(cases)('never leaks connection details: %s', (_, err) => {
    const message = sanitizeDatabaseError(err, URL_).message;
    expectNoSecrets(message);
    // Node names the resolved address, which redaction of the host name cannot know about.
    expect(message).not.toMatch(/203\.0\.113\.7|5432|SSL routines/);
  });

  it('keeps the SQLSTATE of server errors', () => {
    expect(sanitizeDatabaseError(serverError('42501', 'permission denied'), URL_).sqlState).toBe(
      '42501',
    );
    expect(sanitizeDatabaseError(systemError('ECONNREFUSED', 'x'), URL_).sqlState).toBeNull();
  });

  it('passes an already sanitized DatabaseError through unchanged', () => {
    const original = new DatabaseError('timeout', 'query cancelled', '57014');
    expect(sanitizeDatabaseError(original, URL_)).toBe(original);
  });

  it('names the error class', () => {
    expect(new DatabaseError('query', 'x').name).toBe('DatabaseError');
  });
});
