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
                                source module. Carries $schema, $id, and a
                                `definitions` block whose keys are the TypeBox
                                export names in that module. Committed so
                                consumers without a TypeScript toolchain can
                                read the contract directly.
  fixtures/
    <module>/                         layout B (flat): fixtures here validate
      valid-<tag>.json                against the module's primary definition
      invalid-<tag>.json              (see "Primary definition" below)
    <module>/
      <DefinitionName>/               layout A (per-definition): pick this
        valid-<tag>.json              layout when one module has several
        invalid-<tag>.json            shapes worth fixturing separately
```

The `.ts` files in `src/` are authoritative. The `.json` files next to them
are regenerated output — **do not edit `schemas/*.json` by hand**. Any change
there will be overwritten on the next `npm run build:schemas`.

## Pipeline

| Command | What it does |
| --- | --- |
| `npm run build:schemas` | Imports every `schemas/src/<module>.ts`, collects every TypeBox export whose value has a JSON-Schema shape, and emits `schemas/<module>.json` with `$schema`, `$id`, and a `definitions` block. Idempotent. |
| `npm run validate:fixtures` | Registers every module schema with ajv (draft 2020-12) and validates every fixture under `schemas/fixtures/<module>/<DefinitionName>/`. `valid-*` fixtures must validate; `invalid-*` fixtures must be rejected. |
| `npm run validate:openapi` | Structurally validates `../api-spec/openapi.yaml` with `@seriousme/openapi-schema-validator`. |
| `npm run typecheck` | Runs `tsc --noEmit` over `schemas/src/**` and `scripts/**`. |
| `npm run check:all` | Runs typecheck -> build:schemas -> validate:fixtures -> validate:openapi. Fails fast. This is the local equivalent of the CI gate. |

## Module-level metadata (optional)

If a module wants to set its emitted file's top-level `title` / `description`,
it exports a constant named `MODULE_META`:

```ts
export const MODULE_META = {
  title: 'Events endpoint schemas',
  description:
    'Schemas for the payload of POST /v1/events and the envelope within.',
} as const;
```

`MODULE_META` is the only reserved export name. Any other export whose value
looks like a TypeBox schema is emitted under `definitions`.

## Primary definition (layout B)

When fixtures sit directly under `schemas/fixtures/<module>/` (layout B),
the fixture gate needs to pick one definition inside the module to validate
against. Resolution order:

1. The module JSON carries a top-level `"x-primary-definition": "<Name>"`.
   Hand-edit the emitted JSON, or have `build:schemas` preserve a custom
   field by adding it as an extra top-level key on the module's TypeBox
   output. **Recommended** when a module has more than one definition.
2. The module has exactly one entry under `"definitions"`. No hint needed.
3. Neither holds: the run fails with a diagnostic naming the fixture path.

## When to edit what

- **Adding or changing a field:** edit the corresponding `schemas/src/*.ts`
  file, then run `npm run build:schemas`. Commit both the `.ts` change and the
  regenerated `.json`. Reviewers diff the emitted JSON to see the contract
  delta explicitly.
- **Adding a fixture:** drop it under
  `schemas/fixtures/<module>/<DefinitionName>/` using the `valid-*` /
  `invalid-*` naming convention. Running `npm run validate:fixtures` locally
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
