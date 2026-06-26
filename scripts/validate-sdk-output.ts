/**
 * validate-sdk-output.ts
 *
 * Runs the TypeScript SDK dumper in a subprocess, reads its JSON-Lines stream
 * of captured `{ scenario, path, body }` tuples, and validates each `body`
 * against the matching JSON Schema definition for `path`. Prints a per-payload
 * pass/fail line and exits non-zero if any payload failed validation.
 *
 * Path → schema mapping:
 *   POST /v1/events            → schemas/events.json     #/definitions/EventBatchRequest
 *   POST /v1/session/start     → schemas/session.json    #/definitions/SessionStartRequest
 *   POST /v1/session/end       → schemas/session.json    #/definitions/SessionEndRequest
 *
 * The dumper is invoked via `tsx` so the SDK source is consumed directly with
 * no separate build step. The runner inherits the parent's stderr (so dumper
 * diagnostics surface in the CI log) and reads stdout line-by-line.
 *
 * Any unmapped path counts as a failure — silent coverage gaps are exactly
 * the failure mode this script exists to prevent.
 */

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

import Ajv2020Import from 'ajv/dist/2020.js';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';

const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Import.default;
const addFormats =
  addFormatsImport as unknown as typeof addFormatsImport.default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMAS_DIR = resolve(REPO_ROOT, 'schemas');
const DUMPER_SCRIPT = resolve(__dirname, 'dump-ts-sdk-payloads.ts');

interface PathMapping {
  readonly schemaFile: string;
  readonly definitionName: string;
}

const PATH_SCHEMA: Record<string, PathMapping> = {
  '/v1/events': {
    schemaFile: 'events.json',
    definitionName: 'EventBatchRequest',
  },
  '/v1/session/start': {
    schemaFile: 'session.json',
    definitionName: 'SessionStartRequest',
  },
  '/v1/session/end': {
    schemaFile: 'session.json',
    definitionName: 'SessionEndRequest',
  },
  '/v1/replay/signed-url': {
    schemaFile: 'replay.json',
    definitionName: 'ReplaySignedUrlRequest',
  },
  '/v1/replay/complete': {
    schemaFile: 'replay.json',
    definitionName: 'ReplayManifestRequest',
  },
};

interface CapturedPayload {
  readonly scenario: string;
  readonly path: string;
  readonly body: unknown;
}

function formatAjvErrors(
  errors: readonly ErrorObject[] | null | undefined,
): string {
  if (!errors || errors.length === 0) return '    (no error detail)';
  return errors
    .map(
      (e) =>
        `    - ${e.instancePath || '<root>'} ${e.message ?? ''}`.trimEnd(),
    )
    .join('\n');
}

function loadModuleSchema(schemaFile: string): AnySchemaObject {
  const modulePath = resolve(SCHEMAS_DIR, schemaFile);
  const body = readFileSync(modulePath, 'utf8');
  return JSON.parse(body) as AnySchemaObject;
}

/**
 * Spawn `tsx scripts/dump-ts-sdk-payloads.ts` and return its stdout lines as
 * an async iterable. Stderr is piped to the parent so dumper diagnostics
 * surface in the CI log.
 */
async function* streamDumperLines(): AsyncIterable<string> {
  // Resolve the tsx binary that npm installed for this repo. Using the local
  // node_modules/.bin entry keeps the script self-contained and tolerant of
  // CI runners that don't have a global tsx on $PATH. On Windows the bin
  // entry is a `.cmd` shim, which requires `shell: true` for `spawn` to
  // launch it correctly (Node's direct CreateProcess path can't exec `.cmd`).
  const isWindows = process.platform === 'win32';
  const tsxBin = isWindows ? 'tsx.cmd' : 'tsx';
  const tsxPath = resolve(REPO_ROOT, 'node_modules', '.bin', tsxBin);

  const child = spawn(tsxPath, [DUMPER_SCRIPT], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    shell: isWindows,
    // Pass through PATH and any test-relevant env without leaking parent
    // environment surprises into the dumper.
    env: process.env,
  });

  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  const exitPromise = new Promise<number>((res, rej) => {
    child.on('error', rej);
    child.on('close', (code) => res(code ?? 0));
  });

  for await (const line of rl) {
    if (line.trim().length === 0) continue;
    yield line;
  }

  const exitCode = await exitPromise;
  if (exitCode !== 0) {
    throw new Error(`dumper exited with status ${exitCode}`);
  }
}

async function main(): Promise<void> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // The TypeBox sources sometimes use `format: "ulid"` as a documentation
  // hint; ajv would otherwise reject the unknown format in strict mode.
  ajv.addFormat('ulid', true);

  // Eagerly load + register every module schema referenced by the path map so
  // cross-module `$ref` (if any) resolves and compiled validators reuse the
  // registered modules instead of redefining them.
  const moduleSchemas = new Map<string, AnySchemaObject>();
  for (const { schemaFile } of Object.values(PATH_SCHEMA)) {
    if (moduleSchemas.has(schemaFile)) continue;
    let moduleSchema: AnySchemaObject;
    try {
      moduleSchema = loadModuleSchema(schemaFile);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[validate-sdk-output] could not load schemas/${schemaFile}: ${msg}\n` +
          `  (hint: run \`npm run build:schemas\` first)`,
      );
      process.exit(1);
    }
    try {
      ajv.addSchema(moduleSchema);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[validate-sdk-output] ajv rejected schemas/${schemaFile}: ${msg}`,
      );
      process.exit(1);
    }
    moduleSchemas.set(schemaFile, moduleSchema);
  }

  // Cache one compiled validator per (schemaFile, definitionName) pair.
  const compiled = new Map<string, ValidateFunction>();
  function compileFor(mapping: PathMapping): ValidateFunction | null {
    const key = `${mapping.schemaFile}#${mapping.definitionName}`;
    const cached = compiled.get(key);
    if (cached !== undefined) return cached;

    const moduleSchema = moduleSchemas.get(mapping.schemaFile);
    if (moduleSchema === undefined) return null;
    const defs = moduleSchema['definitions'];
    if (
      defs === undefined ||
      defs === null ||
      typeof defs !== 'object' ||
      !(mapping.definitionName in (defs as Record<string, unknown>))
    ) {
      return null;
    }
    const moduleId = moduleSchema['$id'];
    if (typeof moduleId !== 'string' || moduleId.length === 0) return null;

    const refSchema: AnySchemaObject = {
      $ref: `${moduleId}#/definitions/${mapping.definitionName}`,
    };
    const validate = ajv.compile(refSchema);
    compiled.set(key, validate);
    return validate;
  }

  let total = 0;
  let failures = 0;

  for await (const line of streamDumperLines()) {
    let parsed: CapturedPayload;
    try {
      parsed = JSON.parse(line) as CapturedPayload;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[validate-sdk-output] could not parse dumper line as JSON: ${msg}\n` +
          `  line: ${line}`,
      );
      failures++;
      total++;
      continue;
    }

    total++;
    const { scenario, path, body } = parsed;
    const mapping = PATH_SCHEMA[path];
    if (mapping === undefined) {
      console.error(`FAIL [${scenario}] POST ${path} — unmapped path`);
      failures++;
      continue;
    }

    const validate = compileFor(mapping);
    if (validate === null) {
      console.error(
        `FAIL [${scenario}] POST ${path} — schemas/${mapping.schemaFile} ` +
          `is missing #/definitions/${mapping.definitionName}`,
      );
      failures++;
      continue;
    }

    const ok = validate(body) as boolean;
    if (ok) {
      console.log(
        `OK   [${scenario}] POST ${path} → ` +
          `schemas/${mapping.schemaFile}#/definitions/${mapping.definitionName}`,
      );
    } else {
      console.error(
        `FAIL [${scenario}] POST ${path} → ` +
          `schemas/${mapping.schemaFile}#/definitions/${mapping.definitionName}`,
      );
      console.error(formatAjvErrors(validate.errors));
      failures++;
    }
  }

  if (total === 0) {
    console.error(
      '[validate-sdk-output] dumper produced no captures — refusing to ' +
        'pass a silent run',
    );
    process.exit(1);
  }

  if (failures > 0) {
    console.error(
      `\n${failures} of ${total} captured payload(s) failed schema validation`,
    );
    process.exit(1);
  }

  console.log(`\nsummary: ${total} captured payload(s) validated, 0 failures`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[validate-sdk-output] unhandled error: ${msg}`);
  process.exit(1);
});
