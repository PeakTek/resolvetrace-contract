/**
 * Optional one-click "Report a problem" widget (Wave-25, browser-only).
 *
 * A dependency-light, vanilla-DOM widget: a floating button that opens a
 * minimal form (a textarea + submit) and routes the description to
 * `client.reportProblem()`, showing a success or error state. It is opt-in
 * (the host calls `mountReportWidget(...)` or sets the `reportWidget` config
 * option) and a guarded no-op outside a browser.
 *
 * Hard rule: this widget must NEVER break the host app. Every DOM operation
 * and every callback is wrapped so a failure degrades to a no-op (best-effort
 * reported via the client's error channel) rather than throwing into the page.
 *
 * Styling is minimal and overridable: every element carries a stable
 * `data-rt-report` hook and class so a host can restyle via CSS, and the
 * inline base styles are only applied when no `className` override is given.
 */

import type { ReportProblemInput } from './report.js';
import type { ReportWidgetOptions, ReportWidgetPosition } from './types.js';

export type { ReportWidgetOptions, ReportWidgetPosition } from './types.js';

/** One buffered replay clip surfaced to the widget's curation UI (neutral). */
export interface ReportWidgetClip {
  /** Stable clip id (for `removeClip`). */
  readonly id: number;
  /** Clip length in ms, for display only. */
  readonly durationMs: number;
}

/**
 * The neutral recording surface the widget drives — typically mapped onto
 * `client.replay.*`. No consent / tier / upload-policy logic lives here;
 * `submit()` is the ONLY method that uploads.
 */
export interface ReportWidgetRecorder {
  /** Begin (or, after a pause, resume as a NEW clip) a capture span. */
  start(): Promise<boolean>;
  /** Finalize the current span into a buffered clip; never uploads. */
  stop(): void;
  /** The buffered clips awaiting submit. */
  listClips(): ReportWidgetClip[];
  /** Drop one buffered clip by id. */
  removeClip(id: number): void;
  /** Upload the kept clips. */
  submit(): Promise<void>;
  /** Drop the buffer without uploading. */
  discard(): void;
}

/** The minimal client surface the widget needs (keeps it decoupled + testable). */
export interface ReportWidgetClient {
  reportProblem(input: ReportProblemInput): string;
  /**
   * Optional recording surface. Present only when the host wires record mode
   * (see `ReportWidgetOptions.record`); absent → the classic text reporter.
   */
  recorder?: ReportWidgetRecorder;
}

/**
 * Mount-time options: the shared `ReportWidgetOptions` plus mount-only hooks
 * (an explicit DOM target and the record lifecycle callbacks — none of which
 * are serializable, so they live here rather than in the client config).
 */
export interface MountReportWidgetOptions extends ReportWidgetOptions {
  /** Optional explicit mount target. Defaults to `document.body`. */
  container?: HTMLElement;
  /**
   * Awaited once when recording first starts (idle → recording). **Reject to
   * ABORT** recording (fail-closed) — e.g. record the user's consent here.
   */
  onRecordStart?: () => void | Promise<void>;
  /**
   * Awaited immediately before uploading on submit. **Reject to ABORT** the
   * submit (the clips are kept so the user can retry).
   */
  onBeforeSubmit?: () => void | Promise<void>;
}

/** Handle returned by `mountReportWidget` for teardown / inspection. */
export interface ReportWidgetHandle {
  /** Open the report form programmatically. No-op if torn down. */
  open(): void;
  /** Close the report form. No-op if torn down. */
  close(): void;
  /** Remove all DOM + listeners. Idempotent; never throws. */
  destroy(): void;
  /** The widget's root element, or `null` when not mounted (e.g. non-browser). */
  readonly root: HTMLElement | null;
}

const POSITION_STYLES: Record<ReportWidgetPosition, Partial<CSSStyleDeclaration>> =
  {
    'bottom-right': { bottom: '16px', right: '16px' },
    'bottom-left': { bottom: '16px', left: '16px' },
    'top-right': { top: '16px', right: '16px' },
    'top-left': { top: '16px', left: '16px' },
  };

/** True when a real browser DOM is available. */
function hasDom(): boolean {
  const g = globalThis as { document?: unknown };
  return typeof g.document !== 'undefined' && g.document !== null;
}

/** Apply a style map without throwing on exotic/jsdom CSSStyleDeclaration. */
function applyStyle(el: HTMLElement, style: Partial<CSSStyleDeclaration>): void {
  try {
    Object.assign(el.style, style);
  } catch {
    /* ignore — styling is cosmetic */
  }
}

/** Format milliseconds as `m:ss` for the recording elapsed-time pill. */
function fmtClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Wall-clock ms; wrapped so a frozen environment can't break the widget. */
function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

/**
 * Mount the report widget. Returns a handle for teardown. Outside a browser
 * (or when `enabled === false`), returns an inert handle whose methods are
 * no-ops and whose `root` is `null`. Never throws into the host app.
 */
export function mountReportWidget(
  client: ReportWidgetClient,
  options: MountReportWidgetOptions = {},
): ReportWidgetHandle {
  const inert: ReportWidgetHandle = {
    open() {
      /* no-op */
    },
    close() {
      /* no-op */
    },
    destroy() {
      /* no-op */
    },
    root: null,
  };

  if (options.enabled === false) return inert;
  if (!hasDom()) return inert;
  if (!client || typeof client.reportProblem !== 'function') return inert;

  const doc = (globalThis as unknown as { document: Document }).document;
  const recordObj =
    typeof options.record === 'object' && options.record !== null
      ? options.record
      : undefined;
  const opts = {
    position: options.position ?? 'bottom-right',
    buttonText: options.buttonText ?? 'Report a problem',
    title: options.title ?? 'Report a problem',
    placeholder: options.placeholder ?? 'Describe what went wrong…',
    submitText: options.submitText ?? 'Send report',
    successText:
      options.successText ?? 'Thanks — your report has been sent.',
    errorText:
      options.errorText ?? 'Sorry, the report could not be sent. Please try again.',
    className: options.className,
    container: options.container,
    // Record mode is active only when requested AND the client wired a recorder.
    record: Boolean(options.record) && typeof client.recorder === 'object',
    recordClips: (recordObj?.clips === 'multi' ? 'multi' : 'single') as
      | 'single'
      | 'multi',
    onRecordStart: options.onRecordStart,
    onBeforeSubmit: options.onBeforeSubmit,
    recordButtonText: options.recordButtonText ?? 'Record',
    pauseText: options.pauseText ?? 'Pause',
    resumeText: options.resumeText ?? 'Resume',
    submitClipsText: options.submitClipsText ?? 'Submit',
    discardText: options.discardText ?? 'Discard',
    recordingLabel: options.recordingLabel ?? 'Recording',
    pausedLabel: options.pausedLabel ?? 'Paused',
  } as const;

  try {
    return build(client, doc, opts);
  } catch {
    // Any failure during construction degrades to the inert handle so the host
    // page is never broken by the widget.
    return inert;
  }
}

interface ResolvedWidgetOptions {
  position: ReportWidgetPosition;
  buttonText: string;
  title: string;
  placeholder: string;
  submitText: string;
  successText: string;
  errorText: string;
  className?: string | undefined;
  container?: HTMLElement | undefined;
  // Record mode.
  record: boolean;
  recordClips: 'single' | 'multi';
  onRecordStart?: (() => void | Promise<void>) | undefined;
  onBeforeSubmit?: (() => void | Promise<void>) | undefined;
  recordButtonText: string;
  pauseText: string;
  resumeText: string;
  submitClipsText: string;
  discardText: string;
  recordingLabel: string;
  pausedLabel: string;
}

function build(
  client: ReportWidgetClient,
  doc: Document,
  opts: ResolvedWidgetOptions,
): ReportWidgetHandle {
  const styled = opts.className === undefined;
  let destroyed = false;
  let open = false;

  // Root container.
  const root = doc.createElement('div');
  root.setAttribute('data-rt-report', 'root');
  if (opts.className !== undefined) root.className = opts.className;
  if (styled) {
    applyStyle(root, {
      position: 'fixed',
      zIndex: '2147483000',
      ...POSITION_STYLES[opts.position],
      fontFamily:
        'system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif',
    });
  }

  // Floating button.
  const button = doc.createElement('button');
  button.type = 'button';
  button.setAttribute('data-rt-report', 'button');
  button.textContent = opts.buttonText;
  button.setAttribute('aria-haspopup', 'dialog');
  if (styled) {
    applyStyle(button, {
      cursor: 'pointer',
      border: 'none',
      borderRadius: '999px',
      padding: '10px 16px',
      fontSize: '14px',
      background: '#1f2937',
      color: '#ffffff',
      boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    });
  }

  // Form panel (hidden until opened).
  const panel = doc.createElement('div');
  panel.setAttribute('data-rt-report', 'panel');
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', opts.title);
  panel.hidden = true;
  if (styled) {
    applyStyle(panel, {
      width: '280px',
      marginBottom: '10px',
      padding: '14px',
      borderRadius: '10px',
      background: '#ffffff',
      color: '#111827',
      boxShadow: '0 6px 24px rgba(0,0,0,0.2)',
      border: '1px solid #e5e7eb',
    });
  }

  const heading = doc.createElement('div');
  heading.setAttribute('data-rt-report', 'title');
  heading.textContent = opts.title;
  if (styled) {
    applyStyle(heading, {
      fontWeight: '600',
      fontSize: '15px',
      marginBottom: '8px',
    });
  }

  const textarea = doc.createElement('textarea');
  textarea.setAttribute('data-rt-report', 'textarea');
  textarea.placeholder = opts.placeholder;
  textarea.rows = 4;
  if (styled) {
    applyStyle(textarea, {
      width: '100%',
      boxSizing: 'border-box',
      resize: 'vertical',
      padding: '8px',
      fontSize: '14px',
      borderRadius: '6px',
      border: '1px solid #d1d5db',
    });
  }

  const status = doc.createElement('div');
  status.setAttribute('data-rt-report', 'status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  if (styled) {
    applyStyle(status, { fontSize: '13px', marginTop: '8px' });
  }

  const submit = doc.createElement('button');
  submit.type = 'button';
  submit.setAttribute('data-rt-report', 'submit');
  submit.textContent = opts.submitText;
  if (styled) {
    applyStyle(submit, {
      marginTop: '10px',
      cursor: 'pointer',
      border: 'none',
      borderRadius: '6px',
      padding: '8px 14px',
      fontSize: '14px',
      background: '#2563eb',
      color: '#ffffff',
    });
  }

  // --- Record mode elements (created only when a recorder is wired) --------
  const rec = opts.record && client.recorder ? client.recorder : null;
  const multi = opts.recordClips === 'multi';
  const recordButton = rec ? doc.createElement('button') : null;
  const overlay = rec ? doc.createElement('div') : null;
  const controls = rec ? doc.createElement('div') : null;
  const statusPill = rec ? doc.createElement('div') : null;
  const pauseButton = rec && multi ? doc.createElement('button') : null;
  const clipsList = rec && multi ? doc.createElement('div') : null;
  const submitClipsButton = rec ? doc.createElement('button') : null;
  const discardButton = rec ? doc.createElement('button') : null;

  if (recordButton) {
    recordButton.type = 'button';
    recordButton.setAttribute('data-rt-report', 'record');
    recordButton.textContent = opts.recordButtonText;
    if (styled) {
      applyStyle(recordButton, {
        marginTop: '10px',
        marginRight: '8px',
        cursor: 'pointer',
        border: 'none',
        borderRadius: '6px',
        padding: '8px 14px',
        fontSize: '14px',
        background: '#dc2626',
        color: '#ffffff',
      });
    }
  }

  panel.appendChild(heading);
  panel.appendChild(textarea);
  panel.appendChild(status);
  if (recordButton) panel.appendChild(recordButton);
  panel.appendChild(submit);
  root.appendChild(panel);
  root.appendChild(button);

  function setStatus(message: string, kind: 'ok' | 'error'): void {
    try {
      status.textContent = message;
      status.hidden = false;
      if (styled) {
        applyStyle(status, { color: kind === 'ok' ? '#047857' : '#b91c1c' });
      }
    } catch {
      /* ignore */
    }
  }

  function clearStatus(): void {
    try {
      status.textContent = '';
      status.hidden = true;
    } catch {
      /* ignore */
    }
  }

  function doOpen(): void {
    if (destroyed) return;
    open = true;
    try {
      panel.hidden = false;
      clearStatus();
      textarea.value = '';
      if (typeof textarea.focus === 'function') textarea.focus();
    } catch {
      /* ignore */
    }
  }

  function doClose(): void {
    if (destroyed) return;
    open = false;
    try {
      panel.hidden = true;
    } catch {
      /* ignore */
    }
  }

  function onButtonClick(): void {
    if (open) doClose();
    else doOpen();
  }

  function onSubmit(): void {
    if (destroyed) return;
    let description = '';
    try {
      description = (textarea.value ?? '').trim();
    } catch {
      description = '';
    }
    if (description.length === 0) {
      setStatus('Please describe the problem first.', 'error');
      return;
    }
    try {
      const id = client.reportProblem({ description });
      if (typeof id === 'string' && id.length > 0) {
        setStatus(opts.successText, 'ok');
        try {
          textarea.value = '';
        } catch {
          /* ignore */
        }
      } else {
        // Empty id means the capture was dropped (e.g. no active session).
        setStatus(opts.errorText, 'error');
      }
    } catch {
      setStatus(opts.errorText, 'error');
    }
  }

  // --- Record-mode state machine (idle → recording → paused → submitted) ---
  type RecState = 'idle' | 'recording' | 'paused' | 'submitted';
  let recState: RecState = 'idle';
  let tick: ReturnType<typeof setInterval> | null = null;
  let elapsedBaseMs = 0; // accumulated recorded time (excludes paused gaps)
  let segmentStartMs = 0; // wall-clock when the current recording segment began

  function elapsedMs(): number {
    return (
      elapsedBaseMs +
      (recState === 'recording' ? Math.max(0, nowMs() - segmentStartMs) : 0)
    );
  }

  function setPillText(text: string): void {
    if (!statusPill) return;
    try {
      statusPill.textContent = text;
    } catch {
      /* ignore */
    }
  }

  function renderStatusPill(): void {
    const label = recState === 'paused' ? opts.pausedLabel : opts.recordingLabel;
    setPillText(`● ${label} ${fmtClock(elapsedMs())}`);
  }

  function renderClips(): void {
    if (!rec || !clipsList) return;
    try {
      while (clipsList.firstChild) clipsList.removeChild(clipsList.firstChild);
      rec.listClips().forEach((clip, i) => {
        const row = doc.createElement('div');
        row.setAttribute('data-rt-report', 'record-clip');
        row.setAttribute('data-rt-clip-id', String(clip.id));
        if (styled) {
          applyStyle(row, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            fontSize: '12px',
            marginTop: '4px',
          });
        }
        const label = doc.createElement('span');
        label.textContent = `Clip ${i + 1} · ${fmtClock(clip.durationMs)}`;
        const remove = doc.createElement('button');
        remove.type = 'button';
        remove.setAttribute('data-rt-report', 'record-clip-remove');
        remove.setAttribute('aria-label', `Remove clip ${i + 1}`);
        remove.textContent = '✕';
        if (styled) {
          applyStyle(remove, {
            cursor: 'pointer',
            border: 'none',
            background: 'transparent',
            color: '#fca5a5',
            fontSize: '13px',
          });
        }
        remove.addEventListener('click', () => {
          try {
            rec.removeClip(clip.id);
          } catch {
            /* ignore */
          }
          renderClips();
        });
        row.appendChild(label);
        row.appendChild(remove);
        clipsList.appendChild(row);
      });
    } catch {
      /* ignore */
    }
  }

  function setOverlayStyle(): void {
    if (!overlay || !styled) return;
    applyStyle(overlay, {
      border: recState === 'paused' ? '4px dashed #d97706' : '4px solid #dc2626',
    });
  }

  function showRecordingUi(): void {
    if (overlay) overlay.style.display = 'block';
    if (controls) controls.style.display = 'flex';
  }
  function hideRecordingUi(): void {
    if (overlay) overlay.style.display = 'none';
    if (controls) controls.style.display = 'none';
  }

  function startTick(): void {
    stopTick();
    try {
      tick = setInterval(() => renderStatusPill(), 1000);
      const t = tick as unknown as { unref?: () => void };
      if (typeof t?.unref === 'function') t.unref();
    } catch {
      tick = null;
    }
  }
  function stopTick(): void {
    if (tick !== null) {
      try {
        clearInterval(tick);
      } catch {
        /* ignore */
      }
      tick = null;
    }
  }

  function updatePauseButton(): void {
    if (!pauseButton) return;
    pauseButton.textContent =
      recState === 'paused' ? opts.resumeText : opts.pauseText;
    pauseButton.setAttribute('aria-pressed', recState === 'paused' ? 'true' : 'false');
  }

  async function onRecordClick(): Promise<void> {
    if (!rec || recState === 'recording' || recState === 'paused') return;
    // Fail-closed consent hook: if it rejects, do NOT start capturing.
    try {
      if (opts.onRecordStart) await opts.onRecordStart();
    } catch {
      setStatus(opts.errorText, 'error');
      return;
    }
    let ok = false;
    try {
      ok = await rec.start();
    } catch {
      ok = false;
    }
    if (!ok) {
      setStatus(opts.errorText, 'error');
      return;
    }
    recState = 'recording';
    elapsedBaseMs = 0;
    segmentStartMs = nowMs();
    doClose(); // close the panel; the frame + controls take over
    setOverlayStyle();
    showRecordingUi();
    updatePauseButton();
    renderClips();
    renderStatusPill();
    startTick();
    try {
      if (controls && typeof controls.focus === 'function') controls.focus();
    } catch {
      /* ignore */
    }
  }

  async function onPauseClick(): Promise<void> {
    if (!rec) return;
    if (recState === 'recording') {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      elapsedBaseMs += Math.max(0, nowMs() - segmentStartMs);
      recState = 'paused';
      stopTick();
      setOverlayStyle();
      updatePauseButton();
      renderClips();
      renderStatusPill();
    } else if (recState === 'paused') {
      let ok = false;
      try {
        ok = await rec.start();
      } catch {
        ok = false;
      }
      if (!ok) return;
      recState = 'recording';
      segmentStartMs = nowMs();
      setOverlayStyle();
      updatePauseButton();
      renderStatusPill();
      startTick();
    }
  }

  async function onSubmitClips(): Promise<void> {
    if (!rec) return;
    if (recState === 'recording') {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
      elapsedBaseMs += Math.max(0, nowMs() - segmentStartMs);
    }
    stopTick();
    // Pre-submit hook (e.g. record consent). Reject → keep clips, stay paused.
    try {
      if (opts.onBeforeSubmit) await opts.onBeforeSubmit();
    } catch {
      recState = 'paused';
      setOverlayStyle();
      showRecordingUi();
      updatePauseButton();
      setPillText(opts.errorText);
      return;
    }
    try {
      await rec.submit();
    } catch {
      /* the SDK submit is itself never-throw; ignore defensively */
    }
    recState = 'submitted';
    hideRecordingUi();
    doOpen();
    setStatus(opts.successText, 'ok');
  }

  function onDiscardClick(): void {
    if (!rec) return;
    try {
      rec.discard();
    } catch {
      /* ignore */
    }
    stopTick();
    recState = 'idle';
    elapsedBaseMs = 0;
    hideRecordingUi();
    renderClips();
  }

  /** Style + assemble the overlay + controls bar and attach them to `root`. */
  function buildRecordUi(): void {
    if (!overlay || !controls || !statusPill || !submitClipsButton || !discardButton) {
      return;
    }
    overlay.setAttribute('data-rt-report', 'record-overlay');
    overlay.setAttribute('data-rt-mask', '');
    overlay.setAttribute('aria-hidden', 'true');
    // Visibility is toggled via inline `display` (not the `hidden` attribute):
    // the controls carry an inline `display`, which would override the UA
    // `[hidden] { display: none }`, so both use `display` for consistency.
    overlay.style.display = 'none';
    if (styled) {
      applyStyle(overlay, {
        position: 'fixed',
        top: '0',
        left: '0',
        right: '0',
        bottom: '0',
        boxSizing: 'border-box',
        border: '4px solid #dc2626',
        pointerEvents: 'none',
        zIndex: '2147483646',
      });
    }

    controls.setAttribute('data-rt-report', 'record-controls');
    controls.setAttribute('data-rt-mask', '');
    controls.setAttribute('role', 'region');
    controls.setAttribute('aria-label', opts.recordingLabel);
    controls.setAttribute('tabindex', '-1');
    controls.style.display = 'none';
    if (styled) {
      applyStyle(controls, {
        position: 'fixed',
        bottom: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        flexDirection: 'column',
        gap: '6px',
        maxWidth: '90vw',
        padding: '10px 12px',
        borderRadius: '10px',
        background: '#111827',
        color: '#ffffff',
        boxShadow: '0 6px 24px rgba(0,0,0,0.35)',
        pointerEvents: 'auto',
        zIndex: '2147483647',
        fontSize: '13px',
      });
    }

    statusPill.setAttribute('data-rt-report', 'record-status');
    statusPill.setAttribute('role', 'status');
    statusPill.setAttribute('aria-live', 'polite');
    statusPill.textContent = `● ${opts.recordingLabel} 0:00`;

    const row = doc.createElement('div');
    if (styled) applyStyle(row, { display: 'flex', alignItems: 'center', gap: '8px' });

    const styleCtl = (
      el: HTMLButtonElement,
      part: string,
      text: string,
      bg: string,
    ): void => {
      el.type = 'button';
      el.setAttribute('data-rt-report', part);
      el.textContent = text;
      if (styled) {
        applyStyle(el, {
          cursor: 'pointer',
          border: 'none',
          borderRadius: '6px',
          padding: '5px 10px',
          fontSize: '12px',
          background: bg,
          color: '#ffffff',
        });
      }
    };
    if (pauseButton) {
      styleCtl(pauseButton, 'record-pause', opts.pauseText, '#374151');
      pauseButton.setAttribute('aria-pressed', 'false');
    }
    styleCtl(submitClipsButton, 'record-submit', opts.submitClipsText, '#2563eb');
    styleCtl(discardButton, 'record-discard', opts.discardText, '#6b7280');

    controls.appendChild(statusPill);
    if (clipsList) {
      clipsList.setAttribute('data-rt-report', 'record-clips');
      clipsList.setAttribute('data-rt-mask', '');
      controls.appendChild(clipsList);
    }
    if (pauseButton) row.appendChild(pauseButton);
    row.appendChild(submitClipsButton);
    row.appendChild(discardButton);
    controls.appendChild(row);

    root.appendChild(overlay);
    root.appendChild(controls);
  }

  if (rec) {
    buildRecordUi();
    recordButton?.addEventListener('click', () => void onRecordClick());
    pauseButton?.addEventListener('click', () => void onPauseClick());
    submitClipsButton?.addEventListener('click', () => void onSubmitClips());
    discardButton?.addEventListener('click', () => void onDiscardClick());
  }

  button.addEventListener('click', onButtonClick);
  submit.addEventListener('click', onSubmit);

  const target = opts.container ?? doc.body;
  try {
    target.appendChild(root);
  } catch {
    /* if mounting fails the handle still works as an inert no-op */
  }

  let removed = false;
  function destroy(): void {
    if (removed) return;
    removed = true;
    destroyed = true;
    open = false;
    stopTick();
    // End any live recording span on teardown. This NEVER submits / uploads —
    // unsubmitted clips are dropped, which is the correct privacy default.
    try {
      if (rec && (recState === 'recording' || recState === 'paused')) rec.stop();
    } catch {
      /* ignore */
    }
    try {
      button.removeEventListener('click', onButtonClick);
      submit.removeEventListener('click', onSubmit);
    } catch {
      /* ignore */
    }
    try {
      root.parentNode?.removeChild(root);
    } catch {
      /* ignore */
    }
  }

  return {
    open: doOpen,
    close: doClose,
    destroy,
    root,
  };
}
