/**
 * build-schemas.ts
 *
 * Emits one JSON Schema 2020-12 document per TypeBox source module.
 *
 * Contract with the authoring side (`schemas/src/`):
 *
 *   - Each `schemas/src/<name>.ts` file is one logical schema module.
 *   - Each module exports one or more TypeBox schema symbols (values created
 *     by `Type.Object(...)`, `Type.Union(...)`, `Type.String(...)`, etc.).
 *   - OPTIONAL: a module may export a `MODULE_META` constant of shape
 *       `{ title?: string; description?: string }`
 *     to control the emitted file's top-level `title` / `description` fields.
 *     When absent those fields are omitted.
 *   - Non-schema exports (plain objects, functions, primitive constants that
 *     are not TypeBox schemas) are ignored.
 *   - `index.ts` (the barrel) is NOT emitted as its own JSON file — only
 *     leaf modules.
 *
 * Output contract:
 *
 *   - `schemas/<module-basename>.json` for each module.
 *   - Each file carries:
 *       "$schema":  https://json-schema.org/draft/2020-12/schema
 *       "$id":      https://schemas.resolvetrace.com/v1/<basename>.json
 *       "definitions": { <ExportName>: <schema>, ... }    // always present
 *   - Export order inside `definitions` matches ascending alphabetical order
 *     (deterministic regardless of authoring order).
 *   - 2-space indent + trailing newline.
 *   - Idempotent: running the script twice on unchanged sources produces
 *     byte-identical output.
 *
 * Failure policy:
 *
 *   - Missing `schemas/src/` directory:           non-zero exit.
 *   - Module importable but exports no schemas:   non-zero exit.
 *   - Any I/O or import error:                    non-zero exit.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { TSchema } from '@sinclair/typebox';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMAS_SRC_DIR = resolve(REPO_ROOT, 'schemas/src');
const SCHEMAS_OUT_DIR = resolve(REPO_ROOT, 'schemas');
const SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';
const SCHEMA_ID_BASE = 'https://schemas.resolvetrace.com/v1';
const MODULE_META_EXPORT = 'MODULE_META';
const INDEX_BASENAMES = new Set(['index', 'index.d']);

interface ModuleMeta {
  readonly title?: string;
  readonly description?: string;
}

interface EmittedFile {
  readonly basename: string;
  readonly outputPath: string;
  readonly definitionNames: readonly string[];
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Structural check: does this value look like a JSON Schema / TypeBox schema?
 * TypeBox's constructors return plain objects whose shape already matches
 * JSON Schema — they carry `type`, `$ref`, or a composite keyword.
 */
function looksLikeSchema(value: unknown): value is TSchema {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj['type'] === 'string' ||
    Array.isArray(obj['type']) ||
    '$ref' in obj ||
    'oneOf' in obj ||
    'anyOf' in obj ||
    'allOf' in obj ||
    'const' in obj ||
    'enum' in obj
  );
}

function isModuleMeta(value: unknown): value is ModuleMeta {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  const titleOk = obj['title'] === undefined || typeof obj['title'] === 'string';
  const descOk =
    obj['description'] === undefined || typeof obj['description'] === 'string';
  return titleOk && descOk;
}

function listSchemaModules(): string[] {
  let entries: string[];
  try {
    entries = readdirSync(SCHEMAS_SRC_DIR);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`could not read ${SCHEMAS_SRC_DIR}: ${msg}`);
  }

  const basenames: string[] = [];
  for (const entry of entries) {
    if (extname(entry) !== '.ts') continue;
    // Strip .ts; then .d if this is a declaration file.
    const stem = entry.slice(0, -'.ts'.length);
    const noDts = stem.endsWith('.d') ? stem.slice(0, -2) : stem;
    if (INDEX_BASENAMES.has(noDts)) continue;
    basenames.push(noDts);
  }
  return [...new Set(basenames)].sort();
}

async function importModule(basename: string): Promise<Record<string, unknown>> {
  const filePath = resolve(SCHEMAS_SRC_DIR, `${basename}.ts`);
  const url = pathToFileURL(filePath).href;
  const mod = (await import(url)) as Record<string, unknown>;
  return mod;
}

interface CollectedSchemas {
  readonly meta: ModuleMeta | undefined;
  readonly definitions: Readonly<Record<string, TSchema>>;
}

function collectFromModule(
  basename: string,
  mod: Record<string, unknown>,
): CollectedSchemas {
  let meta: ModuleMeta | undefined;
  const metaCandidate = mod[MODULE_META_EXPORT];
  if (metaCandidate !== undefined) {
    if (!isModuleMeta(metaCandidate)) {
      throw new Error(
        `module '${basename}' exports '${MODULE_META_EXPORT}' ` +
          `but its shape is invalid (expected { title?: string; description?: string })`,
      );
    }
    meta = metaCandidate;
  }

  const definitions: Record<string, TSchema> = {};
  const exportNames = Object.keys(mod).sort();
  for (const exportName of exportNames) {
    if (exportName === 'default' || exportName === MODULE_META_EXPORT) continue;
    const value = mod[exportName];
    if (!looksLikeSchema(value)) continue;
    definitions[exportName] = value;
  }

  return { meta, definitions };
}

function buildDocument(
  basename: string,
  collected: CollectedSchemas,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    $schema: SCHEMA_DRAFT,
    $id: `${SCHEMA_ID_BASE}/${basename}.json`,
  };
  if (collected.meta?.title !== undefined) {
    doc['title'] = collected.meta.title;
  }
  if (collected.meta?.description !== undefined) {
    doc['description'] = collected.meta.description;
  }
  doc['definitions'] = collected.definitions;
  return doc;
}

function serialize(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

async function main(): Promise<void> {
  const basenames = listSchemaModules();
  if (basenames.length === 0) {
    console.error(
      `[build-schemas] no .ts modules found in ${SCHEMAS_SRC_DIR} ` +
        `(excluding index.ts). Expected at least one schema module.`,
    );
    process.exit(1);
  }

  mkdirSync(SCHEMAS_OUT_DIR, { recursive: true });

  const emitted: EmittedFile[] = [];
  let totalDefinitions = 0;

  for (const basename of basenames) {
    let mod: Record<string, unknown>;
    try {
      mod = await importModule(basename);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[build-schemas] failed to import schemas/src/${basename}.ts: ${msg}`,
      );
      process.exit(1);
    }

    const collected = collectFromModule(basename, mod);
    const definitionCount = Object.keys(collected.definitions).length;
    if (definitionCount === 0) {
      console.error(
        `[build-schemas] module '${basename}' exports no TypeBox schemas — ` +
          `nothing to emit. Remove the file or add a schema export.`,
      );
      process.exit(1);
    }

    const doc = buildDocument(basename, collected);
    const body = serialize(doc);
    const outputPath = resolve(SCHEMAS_OUT_DIR, `${basename}.json`);
    writeFileSync(outputPath, body, 'utf8');

    const bytes = Buffer.byteLength(body, 'utf8');
    const sha256 = createHash('sha256').update(body).digest('hex').slice(0, 12);
    const definitionNames = Object.keys(collected.definitions);
    totalDefinitions += definitionCount;

    emitted.push({
      basename,
      outputPath,
      definitionNames,
      bytes,
      sha256,
    });

    console.log(
      `emitted schemas/${basename}.json (${bytes} bytes, sha256:${sha256}, ` +
        `${definitionCount} definition${definitionCount === 1 ? '' : 's'})`,
    );
  }

  // Idempotency check: re-serialize each document and compare to disk.
  for (const e of emitted) {
    const onDisk = readFileSync(e.outputPath, 'utf8');
    const mod = await importModule(e.basename);
    const collected = collectFromModule(e.basename, mod);
    const expected = serialize(buildDocument(e.basename, collected));
    if (onDisk !== expected) {
      console.error(
        `[build-schemas] idempotency check failed for ${e.basename}.json ` +
          `— emitter is non-deterministic`,
      );
      process.exit(1);
    }
  }

  console.log(
    `[build-schemas] ${emitted.length} file(s), ` +
      `${totalDefinitions} definition(s) total`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[build-schemas] unhandled error: ${msg}`);
  process.exit(1);
});
