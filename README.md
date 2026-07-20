# resolvetrace-contract

Public contract repository for ResolveTrace.

## Purpose

`resolvetrace-contract` is the single source of truth for the public client-to-server boundary:

- SDK packages
- HTTP API specifications
- JSON schemas
- compatibility and versioning rules

If a type, payload, or endpoint crosses the SDK/server boundary, it belongs here.

## Layout

- `sdk/` — the client SDKs (`sdk/js` is the maintained surface; `sdk/python` is frozen — see its README).
- `api-spec/` — `openapi.yaml`, the HTTP API specification.
- `schemas/` — TypeBox sources (`schemas/src/*.ts`) compiled to published JSON Schemas, plus the `schemas/fixtures/` corpus.
- `conformance/` — black-box harness that verifies a deployment against the contract. See [`conformance/README.md`](./conformance/README.md) for the customer-facing guide.
- `CHANGELOG.md`

This repository intentionally does not contain:

- server runtime code
- deployment or infrastructure code
- tenant-specific or environment-specific logic
- customer data, secrets, or internal operational material

## Design Rules

- Client behavior must remain deployment-agnostic.
- Implementations consume this contract; they do not redefine it.
- Breaking changes require a new major version and a new API namespace.
- Additive changes should preserve backward compatibility within a major version.

## Compatibility Goal

The self-hosted server and managed ResolveTrace deployments are expected to implement the same public contract. Client migration between deployment models should require an endpoint change, not SDK rewrites.

## Feature availability across deployments

One contract, three deployment tiers. The SDK surface is byte-identical everywhere; which capabilities the **server** honors is what differs — so a host-set primitive (e.g. `autoCapture.replay.mode: 'manual'` + `client.replay.start()/stop()`) is always safe to call, and the app developer picks the mode matching their backend. Baseline features (capture, sessions, auto masked replay, report widget) run on the self-hosted OSS build; consent-gated **manual** replay and per-tenant replay policy are **ResolveTrace Platform** (managed); dedicated-isolation and SSO/audit-export land in **Enterprise**. See the [SDK feature-availability table](./sdk/typescript/README.md#feature-availability-by-deployment) for the per-capability breakdown.

## Contributing

Treat interface changes as high-impact changes. Update schemas, specifications, generated artifacts, and changelog entries together.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
