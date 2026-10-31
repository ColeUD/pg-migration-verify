/**
 * SQL -> expected objects. `parseMigration` reads one migration file and returns the net set of
 * objects it should leave behind (created, altered, dropped, renamed), plus notes for everything
 * that cannot be checked against the catalog. It uses the real Postgres parser (libpg-query,
 * compiled to WASM), so anything Postgres accepts is understood; it never connects to a database.
 */
import { loadModule } from 'libpg-query';
import type { Note, ParsedMigration, SourceRef } from '../model.js';
import { describeObject } from '../keys.js';
import { NetEffect } from './merge.js';
import { excerpt, SourceText, splitStatements } from './source.js';
import { analyzeStatement } from './statements.js';

export { normalizeTypeName, type NormalizeTypeOptions } from './types.js';

export interface ParseOptions {
  /** File name recorded in every SourceRef, e.g. `20240101120000_create_profiles.sql`. */
  file: string;
  /** Schema for unqualified names until the migration sets search_path. Default `public`. */
  defaultSchema?: string;
}

let loading: Promise<void> | undefined;
let loaded = false;

/**
 * Load the parser's WASM module. Must be awaited once before `parseMigration`, which is
 * synchronous so callers can parse many files in a tight loop. Safe to call repeatedly.
 */
export async function loadParser(): Promise<void> {
  loading ??= loadModule().then(() => {
    loaded = true;
  });
  try {
    await loading;
  } catch (error) {
    // Allow a later retry instead of caching the failure forever.
    loading = undefined;
    throw error;
  }
}

/**
 * Parse a migration into its net expected objects. Never throws for bad SQL: a statement that does
 * not parse becomes a `ParseError` note and the rest of the file is still analyzed.
 */
export function parseMigration(sql: string, options: ParseOptions): ParsedMigration {
  if (!loaded) {
    throw new Error(
      'The SQL parser is not loaded: await loadParser() before calling parseMigration().',
    );
  }
  const defaultSchema = options.defaultSchema ?? 'public';
  // Editors on Windows may save a UTF-8 byte order mark, which Postgres' lexer rejects.
  const text = new SourceText(sql.startsWith('﻿') ? sql.slice(1) : sql);
  const statements = splitStatements(text);
  const net = new NetEffect();
  const notes: Note[] = [];
  let schema = defaultSchema;

  statements.forEach((statement, statementIndex) => {
    const source: SourceRef = {
      file: options.file,
      statementIndex,
      line: text.lineAt(statement.start),
      excerpt: excerpt(text.slice(statement.start, statement.end)),
    };
    if (statement.kind === 'error') {
      notes.push({
        category: 'unverifiable',
        statementType: 'ParseError',
        reason: statement.reason,
        source,
      });
      return;
    }
    for (const effect of analyzeStatement(statement.node, { schema, source })) {
      switch (effect.type) {
        case 'object':
          net.add(effect.object, effect.cascade);
          break;
        case 'rename':
          if (!net.rename(effect.from, effect.to, schema)) {
            notes.push({
              category: 'unverifiable',
              statementType: effect.statementType,
              reason: `the new name of ${describeObject(effect.from)} is not checked: write the argument list so the function can be identified`,
              source: effect.to.source,
            });
          }
          break;
        case 'note':
          notes.push(effect.note);
          break;
        case 'search_path':
          schema = effect.schema ?? defaultSchema;
          break;
      }
    }
  });

  return {
    file: options.file,
    objects: net.objects,
    renames: net.renames,
    notes,
    statementCount: statements.length,
  };
}
