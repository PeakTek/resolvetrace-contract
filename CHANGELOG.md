# Changelog

All notable changes to the ResolveTrace contract (SDK, OpenAPI spec, JSON schemas) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

*No changes yet.*

## [0.1.0] — 2026-04-20

### Added
- OpenAPI 3.1 specification for the ingest surface (`/v1/events`, `/v1/replay/signed-url`, `/v1/replay/complete`, `/v1/session/start`, `/v1/session/end`).
- JSON Schema (2020-12) definitions for the event envelope, replay-chunk manifest, session lifecycle, and standard error / rate-limit response shapes.
- TypeBox source files authoring the above schemas under `schemas/src/`.
- Sample fixtures for conformance validation — valid and invalid payloads under `schemas/fixtures/`.
