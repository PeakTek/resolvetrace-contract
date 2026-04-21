/**
 * validate-openapi.ts
 *
 * Runs structural validation over `api-spec/openapi.yaml` using
 * @seriousme/openapi-schema-validator (supports OpenAPI 3.0.x and 3.1.x,
 * auto-detecting from the document).
 *
 * The spec uses external `$ref`s into `schemas/*.json` (e.g.
 * `../schemas/events.json#/definitions/EventBatchRequest`). The underlying
 * validator only resolves internal refs, so we pre-dereference the spec
 * with `@apidevtools/json-schema-ref-parser` and hand the inlined object
 * to the validator.
 *
 * Exits non-zero on any validation error. Missing spec is also an error —
 * the file is expected to exist once A7 lands the OpenAPI surface.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import $RefParserImport from '@apidevtools/json-schema-ref-parser';
import { Validator } from '@seriousme/openapi-schema-validator';

// NodeNext-ESM + CJS-default-export interop: unwrap a possibly-wrapped default.
const $RefParser =
  ($RefParserImport as unknown as { default?: typeof $RefParserImport })
    .default ?? $RefParserImport;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..');
const OPENAPI_PATH = resolve(REPO_ROOT, 'api-spec/openapi.yaml');

async function main(): Promise<void> {
  if (!existsSync(OPENAPI_PATH)) {
    console.error(
      `[validate-openapi] spec not found: ${OPENAPI_PATH}\n` +
        'Expected api-spec/openapi.yaml to exist.',
    );
    process.exit(1);
  }

  // Dereference external `$ref`s (relative paths are resolved against the
  // spec's own directory) before handing the spec to the structural validator.
  let dereferenced: unknown;
  try {
    dereferenced = await $RefParser.dereference(OPENAPI_PATH);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      `[validate-openapi] failed to dereference external $refs in ` +
        `api-spec/openapi.yaml: ${msg}`,
    );
    process.exit(1);
  }

  const validator = new Validator();
  const result = await validator.validate(
    dereferenced as Parameters<Validator['validate']>[0],
  );

  if (result.valid) {
    const spec = validator.specification as { openapi?: string } | undefined;
    const version = spec?.openapi ?? 'unknown';
    console.log(
      `[validate-openapi] api-spec/openapi.yaml is structurally valid ` +
        `(OpenAPI ${version})`,
    );
    return;
  }

  console.error('[validate-openapi] api-spec/openapi.yaml FAILED validation:');
  const errors = result.errors;
  if (Array.isArray(errors)) {
    for (const err of errors) {
      console.error(`  - ${JSON.stringify(err)}`);
    }
  } else if (errors !== undefined) {
    console.error(`  - ${JSON.stringify(errors)}`);
  }
  process.exit(1);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.stack ?? err.message : String(err);
  console.error(`[validate-openapi] unhandled error: ${msg}`);
  process.exit(1);
});
