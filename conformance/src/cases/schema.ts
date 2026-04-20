/**
 * Schema conformance: the server accepts every `valid-*.json` fixture in
 * `schemas/fixtures/` and rejects every `invalid-*.json` fixture with HTTP 400.
 *
 * Each fixture file emits one result so the customer can see exactly which
 * row failed rather than a single aggregate pass/fail.
 *
 * We only drive the POST endpoints whose request bodies appear in the
 * fixture corpus: events, replay, session. Response-only fixtures
 * (api-responses/) are used to shape-check server error bodies elsewhere
 * (see rate-limit.ts); they are not pushed at the server.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { postJson } from '../http.ts';
import type { CaseDefinition, CaseResult, ResolvedConformanceConfig } from '../types.ts';

/**
 * Map of fixture directory ({@link schemas/fixtures/<module>/<Definition>/})
 * to the HTTP path the server exposes for that body shape. Unmapped
 * definitions are skipped with a notice so future contract additions do not
 * silently widen the harness.
 */
const DEFINITION_ROUTES: Record<string, { path: string; expectSuccessStatus: number }> = {
  'events/EventBatchRequest': { path: '/v1/events', expectSuccessStatus: 202 },
  'replay/ReplaySignedUrlRequest': {
    path: '/v1/replay/signed-url',
    expectSuccessStatus: 201,
  },
  'replay/ReplayManifestRequest': { path: '/v1/replay/complete', expectSuccessStatus: 200 },
  'session/SessionStartRequest': { path: '/v1/session/start', expectSuccessStatus: 201 },
  'session/SessionEndRequest': { path: '/v1/session/end', expectSuccessStatus: 200 },
};

interface FixtureFile {
  routeKey: string;
  fileName: string;
  fullPath: string;
  isValid: boolean;
}

async function enumerateFixtures(
  fixturesRoot: string,
): Promise<{ mapped: FixtureFile[]; skippedDefinitions: string[] }> {
  const mapped: FixtureFile[] = [];
  const skippedDefinitions: string[] = [];
  const modules = await fs.readdir(fixturesRoot, { withFileTypes: true });
  for (const mod of modules) {
    if (!mod.isDirectory()) continue;
    const modDir = path.join(fixturesRoot, mod.name);
    const defs = await fs.readdir(modDir, { withFileTypes: true });
    for (const def of defs) {
      if (!def.isDirectory()) continue;
      const routeKey = `${mod.name}/${def.name}`;
      if (!DEFINITION_ROUTES[routeKey]) {
        skippedDefinitions.push(routeKey);
        continue;
      }
      const defDir = path.join(modDir, def.name);
      const files = await fs.readdir(defDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const isValid = file.startsWith('valid-');
        const isInvalid = file.startsWith('invalid-');
        if (!isValid && !isInvalid) continue;
        mapped.push({
          routeKey,
          fileName: file,
          fullPath: path.join(defDir, file),
          isValid,
        });
      }
    }
  }
  return { mapped, skippedDefinitions };
}

function fixturesRootPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'schemas', 'fixtures');
}

async function run(config: ResolvedConformanceConfig): Promise<CaseResult[]> {
  const fixturesRoot = fixturesRootPath();

  if (config.skipNetwork) {
    return [
      {
        id: 'schema.fixtures',
        description: 'Server accepts all valid-*.json fixtures and rejects invalid-*.json with 400',
        status: 'skip',
        durationMs: 0,
        message: '--skip-network set',
      },
    ];
  }

  let fixtures: FixtureFile[];
  let skippedDefinitions: string[];
  try {
    const enumerated = await enumerateFixtures(fixturesRoot);
    fixtures = enumerated.mapped;
    skippedDefinitions = enumerated.skippedDefinitions;
  } catch (err) {
    return [
      {
        id: 'schema.enumerate',
        description: 'Enumerate fixtures under schemas/fixtures/',
        status: 'fail',
        durationMs: 0,
        message: err instanceof Error ? err.message : String(err),
      },
    ];
  }

  const results: CaseResult[] = [];

  for (const fixture of fixtures) {
    const started = performance.now();
    const id = `schema.${fixture.routeKey.replace('/', '.')}.${fixture.fileName.replace(/\.json$/, '')}`;
    const description = `${fixture.isValid ? 'valid' : 'invalid'} fixture ${fixture.routeKey}/${fixture.fileName}`;
    try {
      const raw = await fs.readFile(fixture.fullPath, 'utf-8');
      const body = JSON.parse(raw);
      const route = DEFINITION_ROUTES[fixture.routeKey]!;
      const response = await postJson({
        endpoint: config.endpoint,
        path: route.path,
        apiKey: config.apiKey,
        body,
      });
      const durationMs = performance.now() - started;

      if (fixture.isValid) {
        if (response.status >= 200 && response.status < 300) {
          results.push({ id, description, status: 'pass', durationMs });
        } else {
          results.push({
            id,
            description,
            status: 'fail',
            durationMs,
            message: `expected 2xx, got ${response.status}`,
            details: { body: response.bodyJson ?? response.bodyText.slice(0, 256) },
          });
        }
      } else {
        if (response.status === 400) {
          results.push({ id, description, status: 'pass', durationMs });
        } else {
          results.push({
            id,
            description,
            status: 'fail',
            durationMs,
            message: `expected 400, got ${response.status}`,
            details: { body: response.bodyJson ?? response.bodyText.slice(0, 256) },
          });
        }
      }
    } catch (err) {
      results.push({
        id,
        description,
        status: 'fail',
        durationMs: performance.now() - started,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (const defKey of skippedDefinitions) {
    results.push({
      id: `schema.${defKey.replace('/', '.')}.skipped`,
      description: `no route mapping for fixture module ${defKey}`,
      status: 'skip',
      durationMs: 0,
      message: 'definition has no POST route; skipped intentionally',
    });
  }

  return results;
}

export const schemaCase: CaseDefinition = {
  id: 'schema.fixtures',
  description: 'Server accepts all valid-*.json fixtures and rejects invalid-*.json with 400',
  run,
};
