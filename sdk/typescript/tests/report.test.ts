/**
 * Wave-25: in-app problem reporting (report API + one-click widget).
 *
 * Runs under vitest's `node` environment. For the API tests we read the
 * emitted `support.report_submitted` event off the recording fetch transport;
 * for the widget tests we install a minimal hand-rolled DOM on `globalThis`
 * (no jsdom dependency), matching the convention used by the auto-capture and
 * dumper harnesses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createClient } from '../src/client.js';
import { mountReportWidget } from '../src/report-widget.js';
import { buildReportEvent } from '../src/report.js';

const ENDPOINT = 'https://ingest.example.com';
const VALID_CODE = 'AB7K2MNP';

/** Let fire-and-forget session-start (+ supportCode) resolve. */
async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * Recording transport: answers `/v1/session/start` with the given body, every
 * other path with a bare 202, and records every outbound events batch body.
 */
function recordingTransport(start: { supportCode?: string } = {}): {
  fetch: typeof fetch;
  events: () => Array<Record<string, unknown>>;
} {
  const batches: string[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/v1/session/start')) {
      const body = JSON.stringify({
        sessionId: 'x',
        acceptedAt: '2026-06-25T00:00:00.000Z',
        ...(start.supportCode ? { supportCode: start.supportCode } : {}),
      });
      return new Response(body, {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.endsWith('/v1/events') && typeof init?.body === 'string') {
      batches.push(init.body);
    }
    return new Response('', { status: 202 });
  });
  const events = () => {
    const out: Array<Record<string, unknown>> = [];
    for (const b of batches) {
      const parsed = JSON.parse(b) as { events: Array<Record<string, unknown>> };
      out.push(...parsed.events);
    }
    return out;
  };
  return { fetch: impl as unknown as typeof fetch, events };
}

function reportEvents(
  events: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return events.filter((e) => e.type === 'support.report_submitted');
}

// ---------------------------------------------------------------------------
// reportProblem — event shape, supportCode, recent context, scrubbing
// ---------------------------------------------------------------------------

describe('client.reportProblem', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits a support.report_submitted carrying the description and returns an event id', async () => {
    const t = recordingTransport();
    const client = createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });

    const id = client.reportProblem({ description: 'The page is broken' });
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

    await client.flush();
    const reports = reportEvents(t.events());
    expect(reports).toHaveLength(1);
    const report = reports[0]!;
    expect(report.type).toBe('support.report_submitted');
    expect(report.schemaVersion).toBe(1);
    const attrs = report.attributes as Record<string, unknown>;
    expect(attrs.description).toBe('The page is broken');
    expect(attrs.source).toBe('api');
  });

  it('attaches the session supportCode (in attributes, not context)', async () => {
    const t = recordingTransport({ supportCode: VALID_CODE });
    const client = createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });

    // Start the session + let the support code resolve first.
    client.capture({ type: 'view.start' });
    await settle();
    expect(client.session.supportCode).toBe(VALID_CODE);

    client.reportProblem({ description: 'help' });
    await client.flush();

    const report = reportEvents(t.events())[0]!;
    const attrs = report.attributes as Record<string, unknown>;
    expect(attrs.supportCode).toBe(VALID_CODE);
    // supportCode rides on attributes; no synthesized top-level context.
    expect(report.context).toBeUndefined();
  });

  it('attaches a metadata-only recent-context trail (type/capturedAt only — no raw attributes)', async () => {
    const t = recordingTransport();
    const client = createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });

    // These breadcrumbs carry sensitive attribute values that must NOT leak
    // into the report's recentContext (it is metadata-only).
    client.capture({ type: 'view.start', attributes: { secretField: 'hunter2' } });
    client.capture({ type: 'action.click', attributes: { ssn: '457-55-5462' } });
    client.reportProblem({ description: 'broken' });
    await client.flush();

    const report = reportEvents(t.events())[0]!;
    const attrs = report.attributes as Record<string, unknown>;
    const recent = attrs.recentContext as Array<Record<string, unknown>>;
    expect(recent.map((r) => r.type)).toEqual(['view.start', 'action.click']);
    // Only metadata keys are present — no copied attribute values.
    for (const entry of recent) {
      expect(Object.keys(entry).sort()).toEqual(['capturedAt', 'type']);
      expect(JSON.stringify(entry)).not.toContain('hunter2');
      expect(JSON.stringify(entry)).not.toContain('457-55-5462');
    }
    // The report event never breadcrumbs itself.
    expect(recent.find((r) => r.type === 'support.report_submitted')).toBeUndefined();
  });

  it('scrubs the user description — a typed secret (email) is absent from the emitted event', async () => {
    const t = recordingTransport();
    const client = createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });

    client.reportProblem({
      description: 'reach me at secret.user@example.com when fixed',
    });
    await client.flush();

    const report = reportEvents(t.events())[0]!;
    const serialized = JSON.stringify(report);
    // The secret email is gone; the redaction token is present.
    expect(serialized).not.toContain('secret.user@example.com');
    const attrs = report.attributes as Record<string, unknown>;
    expect(attrs.description).toContain('[REDACTED:regex:email]');
    expect((report.scrubber as { applied: string[] }).applied).toContain('regex:email');
  });

  it('throws a TypeError on a missing/blank description', () => {
    const t = recordingTransport();
    const client = createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });
    expect(() => client.reportProblem({ description: '   ' })).toThrow(TypeError);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => client.reportProblem({} as any)).toThrow(TypeError);
  });

  it('mirrors supportCode onto a caller-supplied full context', () => {
    const event = buildReportEvent({
      input: {
        description: 'x',
        context: {
          releaseVersion: 'web@1',
          locale: 'en-CA',
          market: 'CA',
          diagnosticsLevel: 'standard',
        },
      },
      supportCode: VALID_CODE,
      recentContext: [],
      source: 'api',
    });
    expect(event.context?.supportCode).toBe(VALID_CODE);
    expect((event.attributes as Record<string, unknown>).supportCode).toBe(VALID_CODE);
  });
});

// ---------------------------------------------------------------------------
// Widget — mount / submit / teardown in a simulated DOM; guarded outside browser
// ---------------------------------------------------------------------------

/** A tiny DOM element stand-in supporting just what the widget touches. */
class FakeEl {
  tagName: string;
  type = '';
  rows = 0;
  value = '';
  textContent = '';
  placeholder = '';
  className = '';
  hidden = false;
  disabled = false;
  parentNode: FakeEl | null = null;
  readonly style: Record<string, string> = {};
  readonly children: FakeEl[] = [];
  private readonly attrs = new Map<string, string>();
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }
  setAttribute(n: string, v: string): void {
    this.attrs.set(n, v);
  }
  getAttribute(n: string): string | null {
    return this.attrs.has(n) ? this.attrs.get(n)! : null;
  }
  appendChild(child: FakeEl): FakeEl {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child: FakeEl): FakeEl {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }
  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }
  addEventListener(type: string, cb: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    arr.push(cb);
    this.listeners.set(type, arr);
  }
  removeEventListener(type: string, cb: () => void): void {
    const arr = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      arr.filter((h) => h !== cb),
    );
  }
  focus(): void {
    /* no-op */
  }
  click(): void {
    for (const cb of this.listeners.get('click') ?? []) cb();
  }
  /** Recursively find the first descendant with data-rt-report === role. */
  byRole(role: string): FakeEl | null {
    if (this.getAttribute('data-rt-report') === role) return this;
    for (const c of this.children) {
      const found = c.byRole(role);
      if (found) return found;
    }
    return null;
  }
}

class FakeDocument {
  body = new FakeEl('body');
  createElement(tag: string): FakeEl {
    return new FakeEl(tag);
  }
}

function installDom(): { restore: () => void; doc: FakeDocument } {
  const doc = new FakeDocument();
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
  const restore = () => {
    if (saved) Object.defineProperty(globalThis, 'document', saved);
    else Object.defineProperty(globalThis, 'document', { configurable: true, value: undefined });
  };
  return { restore, doc };
}

describe('mountReportWidget', () => {
  let dom: { restore: () => void; doc: FakeDocument };

  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
    vi.restoreAllMocks();
  });

  it('mounts a button + form into the document and tears down on destroy', () => {
    const client = { reportProblem: vi.fn(() => 'EVENTID') };
    const handle = mountReportWidget(client);
    expect(handle.root).not.toBeNull();
    expect(dom.doc.body.children).toHaveLength(1);
    expect(handle.root!.byRole('button')).not.toBeNull();
    expect(handle.root!.byRole('textarea')).not.toBeNull();

    handle.destroy();
    expect(dom.doc.body.children).toHaveLength(0);
    // Idempotent.
    expect(() => handle.destroy()).not.toThrow();
  });

  it('submits the textarea through reportProblem and shows success', () => {
    const reportProblem = vi.fn(() => 'EVENTID01234567890123456789');
    const handle = mountReportWidget({ reportProblem });
    const root = handle.root!;

    // Open the panel, type a description, click submit.
    (root.byRole('button') as unknown as FakeEl).click();
    const textarea = root.byRole('textarea') as unknown as FakeEl;
    textarea.value = 'The submit button is dead';
    (root.byRole('submit') as unknown as FakeEl).click();

    expect(reportProblem).toHaveBeenCalledTimes(1);
    expect(reportProblem.mock.calls[0]![0]).toMatchObject({
      description: 'The submit button is dead',
    });
    const status = root.byRole('status') as unknown as FakeEl;
    expect(status.hidden).toBe(false);
    expect(status.textContent.length).toBeGreaterThan(0);
  });

  it('does not call reportProblem on an empty description', () => {
    const reportProblem = vi.fn(() => 'EVENTID');
    const handle = mountReportWidget({ reportProblem });
    const root = handle.root!;
    (root.byRole('button') as unknown as FakeEl).click();
    (root.byRole('submit') as unknown as FakeEl).click();
    expect(reportProblem).not.toHaveBeenCalled();
  });

  it('never throws when reportProblem throws — shows the error state', () => {
    const reportProblem = vi.fn(() => {
      throw new Error('boom');
    });
    const handle = mountReportWidget({ reportProblem });
    const root = handle.root!;
    (root.byRole('button') as unknown as FakeEl).click();
    (root.byRole('textarea') as unknown as FakeEl).value = 'x';
    expect(() => (root.byRole('submit') as unknown as FakeEl).click()).not.toThrow();
    const status = root.byRole('status') as unknown as FakeEl;
    expect(status.hidden).toBe(false);
  });

  it('is a guarded no-op outside a browser (no document)', () => {
    dom.restore(); // remove the fake document for this case
    const handle = mountReportWidget({ reportProblem: vi.fn(() => 'X') });
    expect(handle.root).toBeNull();
    expect(() => {
      handle.open();
      handle.close();
      handle.destroy();
    }).not.toThrow();
    // Re-install so afterEach restore is symmetric.
    dom = installDom();
  });

  it('honors enabled:false as a no-op', () => {
    const handle = mountReportWidget({ reportProblem: vi.fn(() => 'X') }, { enabled: false });
    expect(handle.root).toBeNull();
    expect(dom.doc.body.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Widget — record mode (overlay + controls, curate, submit; never-throw)
// ---------------------------------------------------------------------------

interface FakeClip {
  id: number;
  durationMs: number;
}
function fakeRecorder(): {
  rec: {
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    listClips: ReturnType<typeof vi.fn>;
    removeClip: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  };
  setClips: (c: FakeClip[]) => void;
} {
  let clips: FakeClip[] = [];
  const rec = {
    start: vi.fn(async () => true),
    stop: vi.fn(() => {}),
    listClips: vi.fn(() => clips),
    removeClip: vi.fn((id: number) => {
      clips = clips.filter((c) => c.id !== id);
    }),
    submit: vi.fn(async () => {}),
    discard: vi.fn(() => {
      clips = [];
    }),
  };
  return { rec, setClips: (c) => (clips = c) };
}

describe('mountReportWidget — record mode', () => {
  let dom: { restore: () => void; doc: FakeDocument };
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
    vi.restoreAllMocks();
  });

  const click = (el: unknown): void => (el as unknown as FakeEl).click();

  it('builds a Record button + a masked overlay and controls (multi: pause + clips)', () => {
    const { rec } = fakeRecorder();
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    const root = handle.root!;
    expect(root.byRole('record')).not.toBeNull();
    const overlay = root.byRole('record-overlay')!;
    expect(overlay).not.toBeNull();
    expect(overlay.getAttribute('data-rt-mask')).toBe(''); // excluded from capture
    const controls = root.byRole('record-controls')!;
    expect(controls.getAttribute('data-rt-mask')).toBe('');
    expect(root.byRole('record-pause')).not.toBeNull();
    expect(root.byRole('record-submit')).not.toBeNull();
    expect(root.byRole('record-discard')).not.toBeNull();
    // Overlay + controls are hidden until recording starts (via inline display,
    // since an inline display would otherwise defeat the `hidden` attribute).
    expect(overlay.style.display).toBe('none');
    expect(controls.style.display).toBe('none');
    handle.destroy();
  });

  it('single-clip mode omits the pause button and clip list', () => {
    const { rec } = fakeRecorder();
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: true }, // defaults to single
    );
    const root = handle.root!;
    expect(root.byRole('record')).not.toBeNull();
    expect(root.byRole('record-pause')).toBeNull();
    expect(root.byRole('record-clips')).toBeNull();
    expect(root.byRole('record-submit')).not.toBeNull();
    handle.destroy();
  });

  it('does NOT build record UI without a recorder (falls back to text reporter)', () => {
    const handle = mountReportWidget({ reportProblem: vi.fn(() => 'X') }, { record: true });
    const root = handle.root!;
    expect(root.byRole('record')).toBeNull();
    expect(root.byRole('record-overlay')).toBeNull();
    handle.destroy();
  });

  it('Record awaits onRecordStart BEFORE recorder.start()', async () => {
    const { rec } = fakeRecorder();
    const order: string[] = [];
    const onRecordStart = vi.fn(async () => {
      order.push('consent');
    });
    rec.start.mockImplementation(async () => {
      order.push('start');
      return true;
    });
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' }, onRecordStart },
    );
    click(handle.root!.byRole('record'));
    await settle();
    expect(onRecordStart).toHaveBeenCalledTimes(1);
    expect(rec.start).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['consent', 'start']);
    handle.destroy();
  });

  it('a rejected onRecordStart aborts — recorder.start() is never called', async () => {
    const { rec } = fakeRecorder();
    const onRecordStart = vi.fn(async () => {
      throw new Error('consent denied');
    });
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' }, onRecordStart },
    );
    expect(() => click(handle.root!.byRole('record'))).not.toThrow();
    await settle();
    expect(rec.start).not.toHaveBeenCalled();
    handle.destroy();
  });

  it('multi mode: pause stops, a clip renders + removes, resume starts a new span', async () => {
    const { rec, setClips } = fakeRecorder();
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    const root = handle.root!;
    click(root.byRole('record'));
    await settle();
    expect(rec.start).toHaveBeenCalledTimes(1);
    // Recording started → the frame + controls are now visible.
    expect(root.byRole('record-overlay')!.style.display).toBe('block');
    expect(root.byRole('record-controls')!.style.display).toBe('flex');

    setClips([{ id: 7, durationMs: 3000 }]);
    click(root.byRole('record-pause')); // pause → stop + render clips
    await settle();
    expect(rec.stop).toHaveBeenCalled();
    const removeBtn = root.byRole('record-clip-remove');
    expect(removeBtn).not.toBeNull();
    click(removeBtn);
    expect(rec.removeClip).toHaveBeenCalledWith(7);

    click(root.byRole('record-pause')); // resume → start (new clip)
    await settle();
    expect(rec.start).toHaveBeenCalledTimes(2);
    handle.destroy();
  });

  it('Submit awaits onBeforeSubmit, then calls submit exactly once (never before)', async () => {
    const { rec } = fakeRecorder();
    const order: string[] = [];
    const onBeforeSubmit = vi.fn(async () => {
      order.push('beforeSubmit');
    });
    rec.submit.mockImplementation(async () => {
      order.push('submit');
    });
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' }, onBeforeSubmit },
    );
    const root = handle.root!;
    click(root.byRole('record'));
    await settle();
    expect(rec.submit).not.toHaveBeenCalled();

    click(root.byRole('record-submit'));
    await settle();
    expect(onBeforeSubmit).toHaveBeenCalledTimes(1);
    expect(rec.submit).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['beforeSubmit', 'submit']);
  });

  it('Discard calls discard and never submit', async () => {
    const { rec } = fakeRecorder();
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    const root = handle.root!;
    click(root.byRole('record'));
    await settle();
    click(root.byRole('record-discard'));
    expect(rec.discard).toHaveBeenCalledTimes(1);
    expect(rec.submit).not.toHaveBeenCalled();
  });

  it('never throws when the recorder throws on every method', async () => {
    const rec = {
      start: vi.fn(async () => {
        throw new Error('boom');
      }),
      stop: vi.fn(() => {
        throw new Error('boom');
      }),
      listClips: vi.fn(() => {
        throw new Error('boom');
      }),
      removeClip: vi.fn(() => {
        throw new Error('boom');
      }),
      submit: vi.fn(async () => {
        throw new Error('boom');
      }),
      discard: vi.fn(() => {
        throw new Error('boom');
      }),
    };
    const handle = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    const root = handle.root!;
    expect(() => click(root.byRole('record'))).not.toThrow();
    await settle();
    // start() threw → treated as not-started; never propagates.
    expect(() => handle.destroy()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Widget — refinements: launcher, submit feedback + auto-close, consent, drag
// ---------------------------------------------------------------------------

describe('mountReportWidget — refinements', () => {
  let dom: { restore: () => void; doc: FakeDocument };
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const click = (el: unknown): void => (el as unknown as FakeEl).click();

  it("launcher 'icon' renders a compact glyph button with an aria-label; 'button' shows text", () => {
    const iconH = mountReportWidget(
      { reportProblem: vi.fn(() => 'X') },
      { launcher: 'icon', buttonText: 'Report' },
    );
    const iconBtn = iconH.root!.byRole('button')!;
    expect(iconBtn.textContent).not.toBe('Report'); // a glyph, not the label
    expect(iconBtn.getAttribute('aria-label')).toBe('Report');
    iconH.destroy();

    const textH = mountReportWidget(
      { reportProblem: vi.fn(() => 'X') },
      { launcher: 'button', buttonText: 'Report' },
    );
    expect(textH.root!.byRole('button')!.textContent).toBe('Report');
    textH.destroy();
  });

  it("launcher 'none' mounts no floating button but handle.open() still shows the panel", () => {
    const h = mountReportWidget({ reportProblem: vi.fn(() => 'X') }, { launcher: 'none' });
    const root = h.root!;
    expect(root.byRole('button')).toBeNull(); // no floating launcher
    const panel = root.byRole('panel') as unknown as FakeEl;
    expect(panel.hidden).toBe(true);
    h.open();
    expect(panel.hidden).toBe(false);
    h.destroy();
  });

  it('recording Submit disables immediately + shows the sending label (no double-submit)', async () => {
    const { rec } = fakeRecorder();
    const h = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' }, sendingText: 'Sending…' },
    );
    const root = h.root!;
    click(root.byRole('record'));
    await settle();

    const submitBtn = root.byRole('record-submit') as unknown as FakeEl;
    click(submitBtn); // synchronous prefix runs: disable + label
    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.textContent).toBe('Sending…');

    // A second click while sending is ignored (submitting guard).
    click(submitBtn);
    await settle();
    expect(rec.submit).toHaveBeenCalledTimes(1);
    h.destroy();
  });

  it('text Send report shows success then auto-closes after ~1.5s', () => {
    vi.useFakeTimers();
    const reportProblem = vi.fn(() => 'EVENTID01234567890123456789');
    const h = mountReportWidget({ reportProblem });
    const root = h.root!;
    click(root.byRole('button')); // open
    (root.byRole('textarea') as unknown as FakeEl).value = 'busted';
    const submitBtn = root.byRole('submit') as unknown as FakeEl;
    click(submitBtn);

    const panel = root.byRole('panel') as unknown as FakeEl;
    const status = root.byRole('status') as unknown as FakeEl;
    expect(status.hidden).toBe(false); // success shown
    expect(submitBtn.disabled).toBe(true); // disabled during the window
    expect(panel.hidden).toBe(false); // not closed yet

    vi.advanceTimersByTime(1500);
    expect(panel.hidden).toBe(true); // auto-closed
    h.destroy();
  });

  it('renders the consent notice + a safe policy link above Record', () => {
    const { rec } = fakeRecorder();
    const h = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      {
        record: { clips: 'multi' },
        consentNotice: 'Submitting means you consent.',
        policyUrl: 'https://example.com/privacy',
        policyLinkText: 'Privacy Policy',
      },
    );
    const root = h.root!;
    const consent = root.byRole('consent')!;
    expect(consent).not.toBeNull();
    expect(consent.children.some((c) => c.textContent.includes('consent'))).toBe(true);
    const link = root.byRole('policy-link')!;
    expect(link.getAttribute('href')).toBe('https://example.com/privacy');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel') ?? '').toContain('noopener');
    expect(link.textContent).toBe('Privacy Policy');
    h.destroy();
  });

  it('omits the consent block when no notice/url is given', () => {
    const { rec } = fakeRecorder();
    const h = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    expect(h.root!.byRole('consent')).toBeNull();
    expect(h.root!.byRole('policy-link')).toBeNull();
    h.destroy();
  });

  it('the status pill is a drag handle (cursor: grab)', () => {
    const { rec } = fakeRecorder();
    const h = mountReportWidget(
      { reportProblem: vi.fn(() => 'X'), recorder: rec },
      { record: { clips: 'multi' } },
    );
    const pill = h.root!.byRole('record-status') as unknown as FakeEl;
    expect(pill.style.cursor).toBe('grab');
    h.destroy();
  });
});

// ---------------------------------------------------------------------------
// Config validation for the reportWidget option + client auto-mount
// ---------------------------------------------------------------------------

describe('reportWidget config', () => {
  let dom: { restore: () => void; doc: FakeDocument };
  beforeEach(() => {
    dom = installDom();
  });
  afterEach(() => {
    dom.restore();
    vi.restoreAllMocks();
  });

  it('auto-mounts the widget when reportWidget is enabled', () => {
    const t = recordingTransport();
    createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch, reportWidget: true });
    expect(dom.doc.body.children.length).toBeGreaterThan(0);
  });

  it('rejects unknown reportWidget keys and bad positions', () => {
    const t = recordingTransport();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { bogus: true } as any,
      }),
    ).toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { position: 'middle' } as any,
      }),
    ).toThrow();
  });

  it('does not auto-mount when reportWidget is omitted', () => {
    const t = recordingTransport();
    createClient({ apiKey: 'rt_test', endpoint: ENDPOINT, transport: t.fetch });
    expect(dom.doc.body.children).toHaveLength(0);
  });

  it('accepts record options and rejects a bad clips value / unknown sub-key', () => {
    const t = recordingTransport();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        reportWidget: { record: { clips: 'multi' } },
      }),
    ).not.toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { record: { clips: 'lots' } as any },
      }),
    ).toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { record: { bogus: true } as any },
      }),
    ).toThrow();
  });

  it('auto-mounts record UI when reportWidget.record is set (recorder wired to client.replay)', () => {
    const t = recordingTransport();
    createClient({
      apiKey: 'rt_test',
      endpoint: ENDPOINT,
      transport: t.fetch,
      reportWidget: { record: { clips: 'multi' } },
      autoCapture: { replay: { enabled: true, mode: 'review' } },
    });
    // The floating root mounted; the record button is present (recorder wired).
    const root = dom.doc.body.children[0]!;
    expect(root.byRole('record')).not.toBeNull();
  });

  it('accepts launcher + consent options; rejects a bad launcher / unsafe policyUrl', () => {
    const t = recordingTransport();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        reportWidget: {
          launcher: 'icon',
          consentNotice: 'ok',
          policyUrl: 'https://x/p',
          policyLinkText: 'Policy',
        },
      }),
    ).not.toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { launcher: 'floaty' } as any,
      }),
    ).toThrow();
    expect(() =>
      createClient({
        apiKey: 'rt_test',
        endpoint: ENDPOINT,
        transport: t.fetch,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reportWidget: { policyUrl: 'javascript:alert(1)' } as any,
      }),
    ).toThrow();
  });
});
