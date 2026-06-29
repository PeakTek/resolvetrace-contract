# Changelog

All notable changes to the ResolveTrace contract (SDK, OpenAPI spec, JSON schemas) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

*No changes yet.*

## [0.2.0] — 2026-06-28

TypeScript SDK stability release: fixes the masked-replay crash flood and makes
session / support-code handling survive page reloads. Pre-1.0 — the public API
is not yet stable.

### Added
- TypeScript SDK: `flush({ keepalive })` so a final flush can complete during
  page unload (e.g. from a `pagehide` handler) while still sending the
  `Authorization` header (which `navigator.sendBeacon` cannot).

### Changed
- TypeScript SDK: upgraded `rrweb` from `2.0.0-alpha.4` to `2.0.1`.
- TypeScript SDK: the replay recorder now passes rrweb an `errorHandler`, so
  recorder-internal failures are reported to diagnostics instead of escaping to
  `window.onerror` (where the SDK's own `error.js` capture would re-record them
  into the session).
- TypeScript SDK: `session.shutdown()` now clears the persisted session, so an
  explicit teardown starts a fresh session on the next load; a plain reload
  still resumes the same session.

### Fixed
- TypeScript SDK: eliminated the `node.matches is not a function` crash flood in
  masked session replay (the rrweb upgrade fixes an unguarded `isBlocked` call
  on non-element nodes).
- TypeScript SDK: the server-minted support code now survives a page reload — it
  is persisted with the session and restored network-free, instead of leaving
  `client.session.supportCode` null (UI stuck on "starting session…") after a
  refresh.

## [0.1.0] — 2026-04-20

### Added
- OpenAPI 3.1 specification for the ingest surface (`/v1/events`, `/v1/replay/signed-url`, `/v1/replay/complete`, `/v1/session/start`, `/v1/session/end`).
- JSON Schema (2020-12) definitions for the event envelope, replay-chunk manifest, session lifecycle, and standard error / rate-limit response shapes.
- TypeBox source files authoring the above schemas under `schemas/src/`.
- Sample fixtures for conformance validation — valid and invalid payloads under `schemas/fixtures/`.
