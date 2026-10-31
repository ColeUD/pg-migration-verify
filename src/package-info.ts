import { readFileSync } from 'node:fs';

/**
 * Name and version from package.json, read at runtime. A JSON import of `../package.json` would
 * sit outside tsc's `rootDir`; reading it relative to this module works the same from `src/`
 * (tests), `dist/` (build) and an npx install, since all three are one level below package.json.
 */
function readPackageInfo(): { name: string; version: string } {
  const json: unknown = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  );
  if (
    typeof json === 'object' &&
    json !== null &&
    'name' in json &&
    typeof json.name === 'string' &&
    'version' in json &&
    typeof json.version === 'string'
  ) {
    return { name: json.name, version: json.version };
  }
  throw new Error('package.json has no name or version');
}

const info = readPackageInfo();

export const PACKAGE_NAME: string = info.name;
export const PACKAGE_VERSION: string = info.version;
