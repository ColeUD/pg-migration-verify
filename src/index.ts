#!/usr/bin/env node
/**
 * The `pg-migration-verify` bin. stdout carries the MCP protocol, so every diagnostic goes to
 * stderr, and nothing printed anywhere contains the database URL.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { redactSecrets } from './catalog/index.js';
import { helpText, parseCliArgs } from './cli.js';
import { describeConfig, readConfig, type Config } from './config.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import { createServer } from './server.js';
import { createToolContext } from './tools/context.js';

function main(): void {
  const command = parseCliArgs(process.argv.slice(2));
  switch (command.kind) {
    case 'help':
      process.stdout.write(helpText());
      return;
    case 'version':
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      return;
    case 'error':
      console.error(command.message);
      process.exitCode = 2;
      return;
    case 'serve':
      serve();
      return;
  }
}

function serve(): void {
  let config: Config;
  try {
    config = readConfig(process.env, process.cwd());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Configuration messages never quote the URL; redact anyway in case one ends up in a value.
    const url = process.env.PGMV_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
    console.error(`${PACKAGE_NAME}: configuration error: ${redactSecrets(message, url)}`);
    process.exitCode = 1;
    return;
  }

  const context = createToolContext(config);
  const handle = serveStdio(() => createServer(context), {
    onerror: (error) => {
      console.error(`${PACKAGE_NAME}: ${redactSecrets(error.message, config.databaseUrl ?? '')}`);
    },
  });
  // One line, so it reads well in a client's MCP log. describeConfig never includes the URL.
  console.error(
    `${PACKAGE_NAME} ${PACKAGE_VERSION} serving MCP on stdio. ` +
      describeConfig(config).split('\n').join('; '),
  );

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  // The transport also closes itself at end of input; exiting here guarantees it.
  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
}

main();
