/**
 * validate-fixtures.ts
 *
 * Runs the fixture gate: every fixture under `schemas/fixtures/` is validated
 * against a named sub-schema (a `definitions` entry) of a module file under
 * `schemas/*.json`.
 *
 * Two supported layouts — pick whichever reads better per module:
 *
 *   A. Per-definition subdirectory (when one module has multiple request or
 *      response shapes worth fixturing independently):
 *
 *        schemas/fixtures/<module>/<DefinitionName>/valid-<tag>.json
 *        schemas/fixtures/<module>/<DefinitionName>/invalid-<tag>.json
 *
 *   B. Flat module directory (when there is one natural "primary" schema —
 *      typically the request payload for that endpoint):
 *
 *        schemas/fixtures/<module>/valid-<tag>.json
 *        schemas/fixtures/<module>/invalid-<tag>.json
 *
 *      Target-definition resolution for layout B, in order:
 *        1. If the module's committed JSON contains a top-level
 *           "x-primary-definition": "<Name>" hint, that is used.
 *        2. Otherwise, if the module has exactly one entry under
 *           "definitions", that entry is used.
 *        3. Otherwise, the run fails with a diagnostic asking the authors to
 *           pick layout A or add the hint.
 *
 * Filename conventions:
 *   - `valid-*.json`   — MUST validate. Failure = red.
 *   - `invalid-*.json` — MUST NOT validate. Success = red.
 *
 * Other failure modes that fail the run:
 *   - Fixture path does not match either layout.
 *   - Referenced module JSON is missing, unparseable, or lacks the named
 *     `#/definitions/<DefinitionName>`.
 *
 * On success, prints a summary like:
 *   `42 valid fixtures passed, 17 invalid fixtures correctly rejected, 0 failures`
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import Ajv2020Import from 'ajv/dist/2020.js';
import type { AnySchemaObject, ErrorObject, ValidateFunction } from 'ajv';
import addFormatsImport from 'ajv-formats';

// Under NodeNext, CJS default exports surface as the module namespace whose
// `.default` is the actual class/function. Cast through the namespace type.
const Ajv2020 = Ajv2020Import as unknown as typeof Ajv2020Import.default;
const addFormats =
  addFormatsImport as unknown as typeof addFormatsImport.default;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const SCHEMAS_DIR = resolve(REPO_ROOT, 'schemas');
const FIXTURES_DIR = resolve(SCHEMAS_DIR, 'fixtures');

type Expectation = 'valid' | 'invalid';

interface Fixture {
  readonly moduleName: string;
  readonly definitionName: string;
  readonly fixturePath: string;
  readonly relPath: string;
  readonly expectation: Expectation;
}

interface Failure {
  readonly fixture: Fixture;
  readonly reason: string;
  readonly errors?: readonly ErrorObject[] | null | undefined;
}

function listJsonFilesRecursive(root: string): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const full = resolve(dir, name);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile() && extname(name) === '.json') {
        out.push(full);
      }
    }
  }
  walk(root);
  return out.sort();
}

/**
 * Half-classified result for layout B: we know the module and the expectation
 * from the filename, but not the definition name — that is filled in later,
 * once we load the module schema.
 */
interface PendingFixture {
  readonly moduleName: string;
  readonly fixturePath: string;
  readonly relPath: string;
  readonly expectation: Expectation;
}

type ClassifyResult =
  | { readonly kind: 'fixture'; readonly fixture: Fixture }
  | { readonly kind: 'pending'; readonly pending: PendingFixture }
  | null;

function classifyFixture(fixturePath: string): ClassifyResult {
  const rel = relative(FIXTURES_DIR, fixturePath).replace(/\\/g, '/');
  const parts = rel.split('/');

  // Layout A: <module>/<DefinitionName>/<filename>
  if (parts.length === 3) {
    const moduleName = parts[0];
    const definitionName = parts[1];
    const filename = parts[2];
    if (!moduleName || !definitionName || !filename) return null;

    let expectation: Expectation | null = null;
    if (filename.startsWith('valid-')) expectation = 'valid';
    else if (filename.startsWith('invalid-')) expectation = 'invalid';
    if (expectation === null) return null;

    return {
      kind: 'fixture',
      fixture: {
        moduleName,
        definitionName,
        fixturePath,
        relPath: rel,
        expectation,
      },
    };
  }

  // Layout B: <module>/<filename>
  if (parts.length === 2) {
    const moduleName = parts[0];
    const filename = parts[1];
    if (!moduleName || !filename) return null;

    let expectation: Expectation | null = null;
    if (filename.startsWith('valid-')) expectation = 'valid';
    else if (filename.startsWith('invalid-')) expectation = 'invalid';
    if (expectation === null) return null;

    return {
      kind: 'pending',
      pending: { moduleName, fixturePath, relPath: rel, expectation },
    };
  }

  return null;
}

function resolvePrimaryDefinition(
  moduleName: string,
  moduleSchema: AnySchemaObject,
): string | null {
  const hint = moduleSchema['x-primary-definition'];
  if (typeof hint === 'string' && hint.length > 0) {
    return hint;
  }
  const defs = moduleSchema['definitions'];
  if (defs !== undefined && defs !== null && typeof defs === 'object') {
    const keys = Object.keys(defs as Record<string, unknown>);
    if (keys.length === 1) {
      // Guaranteed by the .length === 1 check.
      return keys[0] ?? null;
    }
  }
  return null;
}

function loadModuleSchema(moduleName: string): AnySchemaObject {
  const modulePath = resolve(SCHEMAS_DIR, `${moduleName}.json`);
  const body = readFileSync(modulePath, 'utf8');
  const parsed = JSON.parse(body) as AnySchemaObject;
  return parsed;
}

function loadFixture(fixturePath: string): unknown {
  const body = readFileSync(fixturePath, 'utf8');
  return JSON.parse(body) as unknown;
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

async function main(): Promise<void> {
  const ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // Register every module schema so cross-module $ref (if any) resolves.
  // Unknown formats used as hints by authors (e.g. `format: "ulid"`) are
  // registered as no-ops so ajv doesn't reject them in strict mode.
  ajv.addFormat('ulid', true);

  const fixturePaths = listJsonFilesRecursive(FIXTURES_DIR);
  if (fixturePaths.length === 0) {
    console.log(
      '[validate-fixtures] no fixtures under schemas/fixtures/ — ' +
        'nothing to check',
    );
    return;
  }

  const fixtures: Fixture[] = [];
  const pending: PendingFixture[] = [];
  const unclassified: string[] = [];
  for (const p of fixturePaths) {
    const r = classifyFixture(p);
    if (r === null) {
      unclassified.push(relative(REPO_ROOT, p).replace(/\\/g, '/'));
    } else if (r.kind === 'fixture') {
      fixtures.push(r.fixture);
    } else {
      pending.push(r.pending);
    }
  }

  if (unclassified.length > 0) {
    console.error(
      '[validate-fixtures] fixture files whose expectation could not be ' +
        'inferred from path — expected\n' +
        '  schemas/fixtures/<module>/<DefinitionName>/(valid|invalid)-*.json  or\n' +
        '  schemas/fixtures/<module>/(valid|invalid)-*.json:',
    );
    for (const p of unclassified) console.error(`  ${p}`);
    process.exit(1);
  }

  // Eagerly register + index every module schema referenced by a fixture.
  const registeredModules = new Set<string>();
  const moduleSchemas = new Map<string, AnySchemaObject>();
  const referencedModules = new Set<string>([
    ...fixtures.map((f) => f.moduleName),
    ...pending.map((p) => p.moduleName),
  ]);
  for (const moduleName of referencedModules) {
    let moduleSchema: AnySchemaObject;
    try {
      moduleSchema = loadModuleSchema(moduleName);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[validate-fixtures] could not load schemas/${moduleName}.json: ${msg}\n` +
          `  (hint: run \`npm run build:schemas\` first)`,
      );
      process.exit(1);
    }
    try {
      ajv.addSchema(moduleSchema);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[validate-fixtures] ajv rejected schemas/${moduleName}.json: ${msg}`,
      );
      process.exit(1);
    }
    moduleSchemas.set(moduleName, moduleSchema);
    registeredModules.add(moduleName);
  }

  // Resolve pending (layout B) fixtures now that module schemas are loaded.
  for (const p of pending) {
    const moduleSchema = moduleSchemas.get(p.moduleName);
    if (moduleSchema === undefined) {
      // Shouldn't happen — we just populated the map from referencedModules.
      console.error(
        `[validate-fixtures] internal error: no schema for module '${p.moduleName}'`,
      );
      process.exit(1);
    }
    const primary = resolvePrimaryDefinition(p.moduleName, moduleSchema);
    if (primary === null) {
      console.error(
        `[validate-fixtures] ${p.relPath} lives directly under ` +
          `schemas/fixtures/${p.moduleName}/, but schemas/${p.moduleName}.json ` +
          'has multiple definitions and no "x-primary-definition" hint. ' +
          'Either move fixtures into schemas/fixtures/<module>/<DefinitionName>/ ' +
          `or add "x-primary-definition": "<Name>" to the module JSON.`,
      );
      process.exit(1);
    }
    fixtures.push({
      moduleName: p.moduleName,
      definitionName: primary,
      fixturePath: p.fixturePath,
      relPath: p.relPath,
      expectation: p.expectation,
    });
  }

  // Build one compiled validator per (module, definition) pair.
  const compiled = new Map<string, ValidateFunction>();
  function keyFor(moduleName: string, definitionName: string): string {
    return `${moduleName}#${definitionName}`;
  }
  function compileFor(fixture: Fixture): ValidateFunction | null {
    const key = keyFor(fixture.moduleName, fixture.definitionName);
    const cached = compiled.get(key);
    if (cached !== undefined) return cached;

    const moduleSchema = moduleSchemas.get(fixture.moduleName);
    if (moduleSchema === undefined) return null;
    const defs = moduleSchema['definitions'];
    if (
      defs === undefined ||
      defs === null ||
      typeof defs !== 'object' ||
      !(fixture.definitionName in (defs as Record<string, unknown>))
    ) {
      return null;
    }
    const moduleId = moduleSchema['$id'];
    if (typeof moduleId !== 'string' || moduleId.length === 0) return null;

    // Reference into the registered module by $id + JSON Pointer fragment.
    // ajv resolves this against the schema we added above.
    const refSchema: AnySchemaObject = {
      $ref: `${moduleId}#/definitions/${fixture.definitionName}`,
    };
    const validate = ajv.compile(refSchema);
    compiled.set(key, validate);
    return validate;
  }

  fixtures.sort((a, b) => a.relPath.localeCompare(b.relPath));

  let validPassed = 0;
  let invalidRejected = 0;
  const failures: Failure[] = [];

  for (const fixture of fixtures) {
    const validate = compileFor(fixture);
    if (validate === null) {
      failures.push({
        fixture,
        reason:
          `schemas/${fixture.moduleName}.json has no ` +
          `#/definitions/${fixture.definitionName}`,
      });
      continue;
    }

    let data: unknown;
    try {
      data = loadFixture(fixture.fixturePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({ fixture, reason: `failed to parse fixture: ${msg}` });
      continue;
    }

    const ok = validate(data) as boolean;
    if (fixture.expectation === 'valid') {
      if (ok) {
        validPassed++;
      } else {
        failures.push({
          fixture,
          reason: 'expected to VALIDATE but ajv rejected it',
          errors: validate.errors,
        });
      }
    } else {
      if (!ok) {
        invalidRejected++;
      } else {
        failures.push({
          fixture,
          reason: 'expected to be REJECTED but ajv accepted it',
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error(`[validate-fixtures] ${failures.length} failure(s):\n`);
    for (const f of failures) {
      console.error(`  ${f.fixture.relPath}`);
      console.error(`    module:      ${f.fixture.moduleName}`);
      console.error(`    definition:  ${f.fixture.definitionName}`);
      console.error(`    expectation: ${f.fixture.expectation}`);
      console.error(`    reason:      ${f.reason}`);
      if (f.errors !== undefined) {
        console.error(`    ajv errors:\n${formatAjvErrors(f.errors)}`);
      }
      console.error('');
    }
    console.error(
      `summary: ${validPassed} valid fixtures passed, ` +
        `${invalidRejected} invalid fixtures correctly rejected, ` +
        `${failures.length} failures`,
    );
    process.exit(1);
  }

  console.log(
    `summary: ${validPassed} valid fixtures passed, ` +
      `${invalidRejected} invalid fixtures correctly rejected, ` +
      `0 failures`,
  );
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[validate-fixtures] unhandled error: ${msg}`);
  process.exit(1);
});
