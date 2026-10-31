/**
 * Turning driver and server errors into messages that are safe to show an MCP client.
 *
 * Errors from `pg`, Node's socket layer and `new URL()` routinely embed connection details: the
 * host and port (`connect ECONNREFUSED 10.0.0.5:6543`), the TLS host name, or the whole input
 * string (`ERR_INVALID_URL` keeps it in `err.input`). The connection string may carry a password,
 * so nothing from it may reach tool output. Every error leaving the catalog layer goes through
 * `sanitizeDatabaseError`, which prefers fixed, actionable messages and only lets the server's own
 * text through (after `redactSecrets`) when that text is about catalog objects, not the connection.
 */

export type DatabaseErrorCategory =
  'connection' | 'authentication' | 'permission' | 'timeout' | 'configuration' | 'query';

/** A database failure whose message is safe to show: it never contains connection details. */
export class DatabaseError extends Error {
  override readonly name = 'DatabaseError';

  constructor(
    /** What kind of problem it is, so callers can react (e.g. `permission` means "not readable"). */
    readonly category: DatabaseErrorCategory,
    message: string,
    /** The server's SQLSTATE when the error came from Postgres, e.g. `42501`. */
    readonly sqlState: string | null = null,
  ) {
    super(message);
  }
}

const REDACTED_URL = '[redacted connection string]';
const REDACTED = '[redacted]';

/** Socket-level failures; their Node messages include host and port, so only the code is used. */
const NETWORK_ERRORS: Readonly<Record<string, string>> = {
  ECONNREFUSED: 'connection refused',
  ENOTFOUND: 'host name not found',
  EAI_AGAIN: 'temporary DNS failure',
  ETIMEDOUT: 'connection timed out',
  ECONNRESET: 'connection reset by the server',
  EHOSTUNREACH: 'host unreachable',
  ENETUNREACH: 'network unreachable',
};

/** TLS certificate failures; `ERR_TLS_CERT_ALTNAME_INVALID` messages name the host. */
const TLS_CERTIFICATE_ERRORS: Readonly<Record<string, string>> = {
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in the chain',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate issuer is not trusted',
  UNABLE_TO_GET_ISSUER_CERT: 'certificate issuer is not trusted',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificate issuer is not trusted',
  CERT_HAS_EXPIRED: 'certificate has expired',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate does not match the host name',
};

const SSL_MODE_HINT =
  'check sslmode in the connection string: verify-full needs the server CA certificate ' +
  '(sslrootcert), sslmode=no-verify encrypts without verifying the server';

/**
 * Converts anything thrown while talking to the database into a `DatabaseError` whose message
 * never contains the connection string, its password (in any encoding), `user:password@`, the
 * host or the port. Already-sanitized `DatabaseError`s pass through unchanged.
 */
export function sanitizeDatabaseError(err: unknown, connectionString: string): DatabaseError {
  if (err instanceof DatabaseError) return err;

  const code = errorCode(err);
  const message = errorMessage(err);
  if (isServerError(err)) return fromServerError(code, message, connectionString);

  if (code !== null && code in NETWORK_ERRORS) {
    return connectionError(NETWORK_ERRORS[code] ?? code);
  }
  if (code === 'ERR_INVALID_URL' || (err instanceof TypeError && /invalid url/i.test(message))) {
    return new DatabaseError('configuration', 'connection string is not a valid postgres:// URL');
  }
  if (code !== null && code in TLS_CERTIFICATE_ERRORS) {
    return connectionError(`TLS: ${TLS_CERTIFICATE_ERRORS[code] ?? code}`, SSL_MODE_HINT);
  }
  // The checks below match driver messages. That is safe only because server errors, whose text
  // may mention anything (a table called "certificates"), were handled above.
  if (/does not support SSL/i.test(message)) {
    return connectionError(
      'it does not accept SSL connections',
      'remove sslmode from the connection string or set sslmode=disable for a local server',
    );
  }
  if (/certificate/i.test(message)) {
    return connectionError('TLS certificate rejected', SSL_MODE_HINT);
  }
  if (/^Connection terminated due to connection timeout/i.test(message)) {
    return connectionError('connection timed out');
  }
  if (/^Connection terminated/i.test(message)) {
    return connectionError('connection closed unexpectedly');
  }
  if (/^SASL: .*password must be a string/i.test(message)) {
    return new DatabaseError(
      'authentication',
      'authentication failed: the server requires a password, but the connection string has none',
    );
  }
  return new DatabaseError('query', redactSecrets(message, connectionString));
}

/** Maps an error reported by the Postgres server itself (it carries a SQLSTATE `code`). */
function fromServerError(
  code: string | null,
  message: string,
  connectionString: string,
): DatabaseError {
  switch (code) {
    case '28P01':
      return new DatabaseError(
        'authentication',
        'authentication failed: the server rejected the user name or password in the connection string',
        code,
      );
    case '28000': {
      // The server's text names the client host ("no pg_hba.conf entry for host ..."), so it is
      // replaced; only whether it mentions missing encryption survives, as a hint.
      const sslHint = /SSL off|no encryption/i.test(message)
        ? '; the server may require SSL: add sslmode=require to the connection string'
        : '';
      return new DatabaseError(
        'authentication',
        `authentication failed: the server does not allow this role to connect (pg_hba.conf rules or a role without LOGIN)${sslHint}`,
        code,
      );
    }
    case '3D000':
      return new DatabaseError(
        'configuration',
        'database does not exist (check the database name in the connection string)',
        code,
      );
    case '42501':
      // e.g. "permission denied for schema supabase_migrations": names catalog objects, not secrets.
      return new DatabaseError('permission', redactSecrets(message, connectionString), code);
    case '57014':
      return new DatabaseError(
        'timeout',
        'query cancelled: it ran longer than the statement timeout',
        code,
      );
    case '25006':
      // Should never happen: every query is a SELECT. Seeing it means a query tried to write.
      return new DatabaseError('query', 'read-only transaction blocked a write', code);
    case '53300':
      return connectionError('too many connections', null, code);
    case '57P03':
      return connectionError('the server is starting up or shutting down', null, code);
  }
  const redacted = redactSecrets(message, connectionString);
  return new DatabaseError(
    'query',
    code === null ? redacted : `${redacted} (SQLSTATE ${code})`,
    code,
  );
}

function connectionError(
  reason: string,
  hint: string | null = null,
  sqlState: string | null = null,
): DatabaseError {
  const message = `could not connect to the database server (${reason})`;
  return new DatabaseError('connection', hint === null ? message : `${message}; ${hint}`, sqlState);
}

/**
 * Last line of defence for any text that might quote the connection string: removes the exact
 * string (also URL-encoded), every `postgres://` / `postgresql://` URL, every `user:password@`
 * fragment, the password in raw, URL-decoded and URL-encoded form, and the host and port.
 */
export function redactSecrets(text: string, connectionString: string): string {
  let result = text;
  if (connectionString !== '') {
    // Also URL-encoded (e.g. echoed inside a query string): there the host follows `%40`, which
    // the host pattern below does not treat as a boundary.
    for (const form of [connectionString, encodeURIComponent(connectionString)]) {
      result = result.replaceAll(form, REDACTED_URL);
    }
  }
  // `+`, not `*`: a bare scheme ("set it to a postgres:// URL") has nothing to hide.
  result = result.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, REDACTED_URL);
  result = result.replace(/[^\s:/@'"[\]]+:[^\s/@'"]+@/g, `${REDACTED}@`);

  const { secrets, host, port } = connectionParts(connectionString);
  // Longest first, so a password that contains another candidate is removed whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    result = result.replaceAll(secret, REDACTED);
  }
  if (host !== null) {
    const hostPattern = new RegExp(`(?<![\\w.-])${escapeRegExp(host)}(?![\\w-])`, 'g');
    result = result.replace(hostPattern, REDACTED);
  }
  if (port !== null) {
    result = result.replace(new RegExp(`(?<!\\d)${port}(?!\\d)`, 'g'), REDACTED);
  }
  return result;
}

interface ConnectionParts {
  secrets: Set<string>;
  host: string | null;
  port: string | null;
}

/**
 * Extracts what must never be shown. Parsing is deliberately forgiving: a password with an
 * unencoded `@` or `/` makes the string an invalid URL, and it must still be found and redacted.
 */
function connectionParts(connectionString: string): ConnectionParts {
  const secrets = new Set<string>();
  let host: string | null = null;
  let port: string | null = null;

  const schemeEnd = connectionString.indexOf('://');
  if (schemeEnd !== -1) {
    // Split at the last '@': people paste passwords containing a literal '@'. (A valid URL with
    // an '@' in its query is parsed correctly below; this split then only over-redacts.)
    const rest = connectionString.slice(schemeEnd + 3);
    const userInfo = rest.slice(0, Math.max(rest.lastIndexOf('@'), 0));
    const colon = userInfo.indexOf(':');
    if (colon !== -1) secrets.add(userInfo.slice(colon + 1));
  }

  try {
    const url = new URL(connectionString);
    secrets.add(url.password);
    const queryPassword = url.searchParams.get('password');
    if (queryPassword !== null) secrets.add(queryPassword);
    host = url.hostname.replace(/^\[(.*)\]$/, '$1') || null;
    port = url.port || null;
  } catch {
    // Not a URL: the raw userinfo split above is all there is to go on.
  }

  for (const secret of [...secrets]) {
    secrets.add(encodeURIComponent(secret));
    try {
      secrets.add(decodeURIComponent(secret));
    } catch {
      // Malformed percent-encoding: the raw form is already in the set.
    }
  }
  secrets.delete('');
  return { secrets, host, port };
}

function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null;
  if ('code' in err && typeof err.code === 'string') return err.code;
  // Node reports a failed multi-address connect (IPv6 + IPv4 `localhost`) as an AggregateError.
  if (err instanceof AggregateError) {
    for (const inner of err.errors) {
      const code = errorCode(inner);
      if (code !== null) return code;
    }
  }
  return null;
}

/** `pg` builds server errors with the protocol's `severity` field; socket errors have none. */
function isServerError(err: unknown): boolean {
  return (
    typeof err === 'object' && err !== null && 'severity' in err && typeof err.severity === 'string'
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'unknown error';
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
