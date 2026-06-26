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

/** The minimal client surface the widget needs (keeps it decoupled + testable). */
export interface ReportWidgetClient {
  reportProblem(input: ReportProblemInput): string;
}

/**
 * Mount-time options: the shared `ReportWidgetOptions` plus an optional
 * explicit DOM mount target (only meaningful when mounting directly, not via
 * the serializable client config).
 */
export interface MountReportWidgetOptions extends ReportWidgetOptions {
  /** Optional explicit mount target. Defaults to `document.body`. */
  container?: HTMLElement;
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

  panel.appendChild(heading);
  panel.appendChild(textarea);
  panel.appendChild(status);
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
