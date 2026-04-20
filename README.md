# resolvetrace-contract

Public contract repository for ResolveTrace.

## Status

Bootstrap repository. This repository defines the interface surface first; implementation repositories consume it.

## Purpose

`resolvetrace-contract` is the single source of truth for the public client-to-server boundary:

- SDK packages
- HTTP API specifications
- JSON schemas
- compatibility and versioning rules

If a type, payload, or endpoint crosses the SDK/server boundary, it belongs here.

## Scope

Planned contents:

- `sdk/`
- `api-spec/`
- `schemas/`
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

## Contributing

Treat interface changes as high-impact changes. Update schemas, specifications, generated artifacts, and changelog entries together.

## License

Apache License 2.0. See [LICENSE](./LICENSE).
