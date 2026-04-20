/**
 * validate-openapi.ts
 *
 * Runs structural validation over `api-spec/openapi.yaml` using
 * @seriousme/openapi-schema-validator (supports OpenAPI 3.0.x and 3.1.x,
 * auto-detecting from the document).
 *
 * Exits non-zero on any validation error. Missing spec is also an error —
 * the file is expected to exist once A7 lands the OpenAPI surface.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Validator } from '@seriousme/openapi-schema-validator';

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

  const validator = new Validator();
  const result = await validator.validate(OPENAPI_PATH);

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
