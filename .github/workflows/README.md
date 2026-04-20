# CI workflows

This repo is the single source of truth for the ResolveTrace SDK-to-server
contract. The workflows here exist to prevent accidental drift between the
TypeBox schema sources, the emitted JSON Schemas, the OpenAPI spec, and the
fixture corpus. Every PR targeting `main` runs the full gate, and every push
to `main` runs it again so the branch stays green.

## Workflows

### `anti-drift.yml`

Runs five jobs. All are required; none can be bypassed.

| Job | What it does | Typical failure means |
| --- | --- | --- |
| `typecheck` | `npm ci` + `npm run typecheck` | TypeScript error in a TypeBox schema or helper. Fix locally and push. |
| `build-schemas` | `npm run build:schemas`, then `git diff --exit-code schemas/*.json` | You edited `schemas/*.json` by hand, or you forgot to run `npm run build:schemas` after editing `schemas/src/*.ts`. Run the build and commit the regenerated JSON. |
| `validate-fixtures` | `npm run validate:fixtures` (ajv against the fixture corpus) | A fixture under `schemas/samples/` no longer matches its schema. Either the fixture is stale or the schema change was unintentional. |
| `validate-openapi` | `npm run validate:openapi` | `api-spec/openapi.yaml` is structurally invalid (bad `$ref`, missing required field, etc.). |
| `oasdiff` | Compares `api-spec/openapi.yaml` on the PR branch against `main` | A breaking change (removed path, removed required field, type change, etc.) was introduced without coordinating a contract version bump. |

The `oasdiff` job also posts an OpenAPI changelog comment to the PR so
reviewers can see what moved at a glance. A non-breaking diff is fine and
will not fail the job — only breaking changes fail it.

## Running the checks locally

All five checks map to npm scripts you can run from the repo root:

```bash
npm ci
npm run typecheck
npm run build:schemas
npm run validate:fixtures
npm run validate:openapi
npm run check:all       # runs all of the above
```

`oasdiff` is not wired into an npm script because it needs both the base
and PR revisions of `api-spec/openapi.yaml`. To preview locally:

```bash
docker run --rm -v "$PWD:/specs" tufin/oasdiff:v1.11.6 \
  breaking /specs/api-spec/openapi.yaml /specs/api-spec/openapi.yaml
```

## Interpreting a red CI run

1. Open the failing job in the GitHub Actions tab.
2. Match the job name against the table above.
3. Fix the underlying issue and push a new commit — **do not** ask a
   reviewer to bypass the gate. The gate is intentionally non-bypassable;
   if the check is wrong, the right response is to update the contract or
   the fixture, not to suppress the check.

Infrastructure flakes (runner crash, GitHub API timeout) can be retried
via the standard "Re-run failed jobs" button. Content checks cannot.
