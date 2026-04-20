# Schemas

This directory is the single source of truth for every data shape that crosses
the ResolveTrace client/server boundary.

## Layout

```
schemas/
  src/                          TypeBox source modules (authoring surface)
    index.ts                    re-exports every schema symbol
    <module>.ts                 one file per schema module (events, session,
                                replay, api-responses, ...)
  <module>.json                 emitted JSON Schema 2020-12 document, one per
                                source module. Carries $schema, $id, title,
                                description, and a `definitions` block whose
                                keys are the TypeBox export names in that
                                module. Committed so consumers without a
                                TypeScript toolchain can read the contract
                                directly.
  fixtures/
    <module>/
      <DefinitionName>/               per-definition subdirectory: every
        valid-<tag>.json              fixture lives under the exact
        invalid-<tag>.json            definition it is meant to validate
                                      against. This is the standard layout
                                      for every module.
```

The `.ts` files in `src/` are authoritative. The `.json` files next to them
are regenerated output — **do not edit `schemas/*.json` by hand**. Any change
there will be overwritten on the next `npm run build:schemas`.

## Pipeline

| Command | What it does |
| --- | --- |
| `npm run build:schemas` | Imports every `schemas/src/<module>.ts`, collects every TypeBox export whose value has a JSON-Schema shape, and emits `schemas/<module>.json` with `$schema`, `$id`, `title`, `description`, and a `definitions` block. Idempotent. |
| `npm run validate:fixtures` | Registers every module schema with ajv (draft 2020-12) and validates every fixture under `schemas/fixtures/<module>/<DefinitionName>/`. Fixtures named `valid-*` must validate; fixtures named `invalid-*` must be rejected. |
| `npm run validate:openapi` | Structurally validates `../api-spec/openapi.yaml` with `@seriousme/openapi-schema-validator`. |
| `npm run typecheck` | Runs `tsc --noEmit` over `schemas/src/**` and `scripts/**`. |
| `npm run check:all` | Runs typecheck -> build:schemas -> validate:fixtures -> validate:openapi. Fails fast. This is the local equivalent of the CI gate. |

## Module-level metadata

Every `schemas/src/<module>.ts` file exports a constant named `MODULE_META`
that sets the emitted file's top-level `title` and `description`:

```ts
export const MODULE_META = {
  title: 'ResolveTrace event envelope and batch',
  description:
    'Wire-format schemas for events sent to POST /v1/events, including the per-event envelope and batch request shape.',
} as const;
```

`MODULE_META` is the only reserved export name. Any other export whose value
looks like a TypeBox schema is emitted under `definitions`.

## Fixture layout

Every fixture lives under a per-definition subdirectory:

```
schemas/fixtures/<module>/<DefinitionName>/valid-<tag>.json
schemas/fixtures/<module>/<DefinitionName>/invalid-<tag>.json
```

The `<DefinitionName>` segment is the exact TypeBox export name (e.g.
`EventBatchRequest`, `SessionStartRequest`, `RateLimitErrorResponse`). The
fixture gate uses this directory name to pick the `#/definitions/<Name>`
sub-schema the fixture is validated against. Files named `valid-*` must
validate; files named `invalid-*` must be rejected.

This layout is used uniformly across every module — even modules where only
one definition is currently fixtured — so contributors always know where to
drop a new fixture.

## When to edit what

- **Adding or changing a field:** edit the corresponding `schemas/src/*.ts`
  file, then run `npm run build:schemas`. Commit both the `.ts` change and the
  regenerated `.json`. Reviewers diff the emitted JSON to see the contract
  delta explicitly.
- **Adding a fixture:** drop it under
  `schemas/fixtures/<module>/<DefinitionName>/` using the `valid-*` /
  `invalid-*` naming convention. If the target `<DefinitionName>` directory
  does not exist yet, create it. Running `npm run validate:fixtures` locally
  proves the fixture is classified correctly.
- **Adding a new schema module:** create `schemas/src/<name>.ts`, re-export
  its symbols from `schemas/src/index.ts`, run `build:schemas`, add fixtures.

## Consumers

The emitted `schemas/*.json` files are the public interface for downstream
consumers:

- The TypeScript SDK is published as `@peaktek/resolvetrace-sdk` by a separate
  pipeline that reads this repo's emitted JSON Schemas.
- The Python SDK regenerates its Pydantic models with
  `datamodel-code-generator` against the same JSON Schemas.

Sibling artifacts: [`../api-spec/openapi.yaml`](../api-spec/openapi.yaml)
references these schemas via `$ref`; [`../CHANGELOG.md`](../CHANGELOG.md)
records every contract-affecting change.
