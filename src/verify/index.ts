/**
 * Verification: expected objects + catalog snapshot -> per-migration reports, and their text form.
 * Pure functions with no I/O; the catalog module supplies the snapshot, the server prints the text.
 */
export { requiredSchemas, verifyMigrations, type MigrationInput } from './verify.js';
export {
  formatExpectedObjects,
  formatMigrationReport,
  formatSummary,
  type ReportFormatOptions,
} from './format.js';
export { typesEqual } from './types-equal.js';
