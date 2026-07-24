# Changelog

All notable changes to the ResolveTrace contract (SDK, OpenAPI spec, JSON schemas) are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] — 2026-07-23

TypeScript SDK: **server-advertised replay clip capability**. The backend now
tells each session whether it may curate multiple replay clips, and the SDK
adapts the "Report a problem" record widget with no client configuration —
single-clip by default, multi-clip when the backend advertises it. Pre-1.0 — the
public API is not yet stable.

### Added
- OpenAPI / JSON schemas: optional `replay: { clips: 'single' | 'multi' }` on
  `SessionStartResponse`. A backend advertises the replay clip capability it
  grants a session; absent means the single-clip baseline (older backends).
  Additive and backward-compatible (oasdiff: new optional response property).
- OpenAPI / JSON schemas: optional `clipIndex` (integer ≥ 0) on
  `ReplaySignedUrlRequest` — the 0-based index of the clip a replay chunk belongs
  to. The SDK sends it **only for clips beyond the first**, so single-clip uploads
  stay wire-compatible with backends that predate the field, and a `clipIndex > 0`
  only ever reaches a backend that advertised multi-clip.
- TypeScript SDK: `client.session.replayClips` (`'single' | 'multi'`) surfaces the
  server-advertised clip capability for the current session (defaults to
  `'single'`; persisted so a page reload restores it).

### Changed
- TypeScript SDK: the **config-mounted** report widget's clip mode is now decided
  by the server capability rather than client config. `reportWidget: { record:
  true }` adapts automatically — the widget offers multi-clip curation only when
  the backend advertises it, and single-clip otherwise. On the first session-start
  after mount it re-mounts if the granted capability differs from the single-clip
  default. (A host mounting the widget imperatively via `mountReportWidget` still
  controls `record.clips` directly.)

## [0.3.0] — 2026-07-16

TypeScript SDK feature release: **user-driven session recording** — a buffered
"review" replay mode where nothing uploads until the user submits, surfaced
through the "Report a problem" widget's opt-in record mode. Pre-1.0 — the public
API is not yet stable.

### Added
- TypeScript SDK: **buffered "review" replay mode** (`autoCapture.replay.mode:
  'review'`). Like `'manual'`, recording is bounded by `client.replay.start()` /
  `stop()` spans, but captured chunks are **buffered locally and uploaded only on
  `client.replay.submit()`** — nothing leaves the device until then. New curation
  handle on `client.replay`: `listClips()`, `removeClip(id)`, `submit()`, and
  `discard()`. Removing a clip leaves a sequence gap the server tolerates; a
  session change or teardown discards unsubmitted clips.
- TypeScript SDK: opt-in **record mode for the "Report a problem" widget**
  (`reportWidget.record: true | { clips: 'single' | 'multi' }`). Adds a Record
  button, a full-screen recording frame, and pause/resume + per-clip curate +
  submit/discard controls — all excluded from capture via `data-rt-mask`. The
  widget drives a neutral `recorder` surface; mount-time `onRecordStart` /
  `onBeforeSubmit` hooks let the host arrange consent (fail-closed: a rejection
  aborts recording / submit).
- TypeScript SDK: report-widget launcher + consent options —
  `reportWidget.launcher: 'button' | 'icon' | 'none'` (compact icon, or no
  floating launcher so the host opens it via the mount handle's `open()`); and
  `consentNotice` + `policyUrl` + `policyLinkText` render a consent line and a
  (scheme-validated) Privacy Policy / Terms link above the Record button.

### Changed
- TypeScript SDK: the report widget now **confirms then auto-closes** after a
  send/submit. Clicking Submit (recording) or Send report (text) immediately
  disables the button and shows a `sendingText` ("Sending…") label, then a brief
  success confirmation, then hides after ~1.5s — closing the window where a slow
  upload invited a double-submit. The recording controls bar is also
  **draggable** by its status pill (the masked frame stays put).

### Fixed
- TypeScript SDK: masked replay now **continues chunk sequence numbers across
  capture spans within a session**. Previously each `replay.start()` built a
  fresh chunker numbered from `0`, so a second recording in the same session
  reused `(sessionId, sequence)` keys and **overwrote** the first on the server —
  only the latest span was retrievable. The recorder now carries a per-session
  sequence high-water mark and seeds each span's chunker with it (resetting only
  when the session itself changes).

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
