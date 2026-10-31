/**
 * Type normalization: turn a parsed `TypeName` into the exact text Postgres' `format_type()`
 * prints, because that is what the catalog reader reports for columns and function arguments.
 * Comparing normalized strings is then a plain equality check, with no server round trip.
 */
import type { Node, TypeName } from 'libpg-query';
import { integerValue, stringValue, stringValues } from './ast.js';
import { quoteIdent } from '../sql-ident.js';

/** How a built-in type prints its typmod. */
type TypmodStyle = 'none' | 'length' | 'numeric' | 'precision' | 'interval';

interface BuiltinType {
  /** `format_type()` spelling. For time types the precision goes before the time zone words. */
  name: string;
  typmod: TypmodStyle;
}

const builtin = (name: string, typmod: TypmodStyle = 'none'): BuiltinType => ({ name, typmod });

/**
 * Internal and alias names (as they appear after stripping `pg_catalog.`) mapped to their
 * `format_type()` spelling. SQL keywords such as `int` or `double precision` already arrive as
 * `pg_catalog.int4` / `pg_catalog.float8`; the rest cover types written by their internal name.
 */
const BUILTIN_TYPES: Readonly<Record<string, BuiltinType>> = {
  int2: builtin('smallint'),
  smallint: builtin('smallint'),
  int4: builtin('integer'),
  int: builtin('integer'),
  integer: builtin('integer'),
  int8: builtin('bigint'),
  bigint: builtin('bigint'),
  float4: builtin('real'),
  real: builtin('real'),
  float8: builtin('double precision'),
  bool: builtin('boolean'),
  boolean: builtin('boolean'),
  // serial types are integers plus a sequence-backed default.
  serial: builtin('integer'),
  serial4: builtin('integer'),
  bigserial: builtin('bigint'),
  serial8: builtin('bigint'),
  smallserial: builtin('smallint'),
  serial2: builtin('smallint'),
  varchar: builtin('character varying', 'length'),
  bpchar: builtin('character', 'length'),
  // Written as `"char"` (quoted), this is the one-byte internal type, not `character`.
  char: builtin('"char"'),
  bit: builtin('bit', 'length'),
  varbit: builtin('bit varying', 'length'),
  decimal: builtin('numeric', 'numeric'),
  numeric: builtin('numeric', 'numeric'),
  timestamp: builtin('timestamp without time zone', 'precision'),
  timestamptz: builtin('timestamp with time zone', 'precision'),
  time: builtin('time without time zone', 'precision'),
  timetz: builtin('time with time zone', 'precision'),
  interval: builtin('interval', 'interval'),
};

const SERIAL_TYPES = new Set([
  'serial',
  'serial4',
  'bigserial',
  'serial8',
  'smallserial',
  'serial2',
]);

/** Field masks from Postgres' `datetime.h` (`INTERVAL_MASK(YEAR)` etc.) as `format_type` prints them. */
const INTERVAL_FIELDS: ReadonlyMap<number, string> = new Map([
  [4, ' year'],
  [2, ' month'],
  [8, ' day'],
  [1024, ' hour'],
  [2048, ' minute'],
  [4096, ' second'],
  [6, ' year to month'],
  [1032, ' day to hour'],
  [3080, ' day to minute'],
  [7176, ' day to second'],
  [3072, ' hour to minute'],
  [7168, ' hour to second'],
  [6144, ' minute to second'],
  // INTERVAL_FULL_RANGE: no field restriction, only a precision (`interval(3)`).
  [32767, ''],
]);

/** Postgres clamps fractional-second precision to 6 (with a warning). */
const MAX_SECONDS_PRECISION = 6;

export interface NormalizeTypeOptions {
  /**
   * Include typmods (`character varying(255)`). Defaults to true, matching
   * `format_type(atttypid, atttypmod)` for columns. Function argument types are compared with
   * `format_type(t, NULL)`, which has no typmods, so pass false for those.
   */
  withTypmod?: boolean;
}

/**
 * Normalize a type to `format_type()` spelling, e.g. `varchar(255)` to `character varying(255)`,
 * `timestamptz` to `timestamp with time zone`, `int[][]` to `integer[]`.
 *
 * User-defined types keep their schema only when the migration wrote one (`public.job_status`
 * stays qualified, `job_status` stays bare); each part is quoted like `quote_ident()`. Returns null
 * when the type cannot be known from the SQL alone (`%TYPE` references) or a typmod cannot be
 * decoded.
 */
export function normalizeTypeName(
  typeName: TypeName,
  options: NormalizeTypeOptions = {},
): string | null {
  if (typeName.pct_type === true) return null;
  const withTypmod = options.withTypmod ?? true;
  const parts = stringValues(typeName.names);
  const unqualified = parts.length === 2 && parts[0] === 'pg_catalog' ? parts.slice(1) : parts;
  const known = unqualified.length === 1 ? BUILTIN_TYPES[unqualified[0] ?? ''] : undefined;
  const typmods = typeName.typmods ?? [];

  let base: string | null;
  if (known !== undefined) {
    base = withTypmod ? builtinWithTypmod(known, typmods) : known.name;
  } else {
    base = unqualified.map(quoteIdent).join('.');
    if (withTypmod && typmods.length > 0) base += `(${typmods.map(typmodText).join(',')})`;
  }
  if (base === null) return null;
  // format_type() does not track array dimensions: int[][] and int[3] are both integer[].
  return (typeName.arrayBounds ?? []).length > 0 ? `${base}[]` : base;
}

/** True for serial/bigserial/smallserial, which imply NOT NULL on the column. */
export function isSerialType(typeName: TypeName | undefined): boolean {
  const name = stringValues(typeName?.names).at(-1);
  return name !== undefined && SERIAL_TYPES.has(name) && (typeName?.arrayBounds ?? []).length === 0;
}

function builtinWithTypmod(type: BuiltinType, typmods: Node[]): string | null {
  const values = typmods.map(integerValue);
  if (values.some((v) => v === undefined)) return null;
  const mods = values as number[];
  switch (type.typmod) {
    case 'none':
      return type.name;
    case 'length':
      if (mods.length > 0) return `${type.name}(${mods.join(',')})`;
      // A typmod-less bpchar column prints as `bpchar` (the SQL keyword CHARACTER always gets a
      // length from the grammar); a typmod-less BIT means BIT(1).
      if (type.name === 'character') return 'bpchar';
      return type.name === 'bit' ? 'bit(1)' : type.name;
    case 'numeric':
      if (mods.length === 1) return `numeric(${mods[0] ?? 0},0)`;
      return mods.length === 2 ? `numeric(${mods.join(',')})` : type.name;
    case 'precision': {
      if (mods.length === 0) return type.name;
      const precision = Math.min(mods[0] ?? 0, MAX_SECONDS_PRECISION);
      // `timestamp with time zone` + 3 => `timestamp(3) with time zone`
      const space = type.name.indexOf(' ');
      return `${type.name.slice(0, space)}(${precision})${type.name.slice(space)}`;
    }
    case 'interval':
      return intervalText(mods);
  }
}

/** `interval` typmods are `[fieldMask]` or `[fieldMask, precision]`; see `intervaltypmodout()`. */
function intervalText(mods: number[]): string | null {
  if (mods.length === 0) return 'interval';
  const fields = INTERVAL_FIELDS.get(mods[0] ?? 0);
  if (fields === undefined) return null;
  const precision =
    mods.length > 1 ? `(${Math.min(mods[1] ?? 0, MAX_SECONDS_PRECISION).toString()})` : '';
  return `interval${fields}${precision}`;
}

/** Typmods of extension types can be identifiers (`geometry(Point,4326)`) as well as numbers. */
function typmodText(node: Node): string {
  const n = integerValue(node);
  if (n !== undefined) return n.toString();
  if ('A_Const' in node) return node.A_Const.sval?.sval ?? '';
  if ('ColumnRef' in node) return stringValue(node.ColumnRef.fields?.at(-1)) ?? '?';
  return '?';
}
