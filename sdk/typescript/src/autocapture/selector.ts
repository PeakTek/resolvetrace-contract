/**
 * Privacy-safe masked element descriptors.
 *
 * Auto-capture (frustration signals, error/resource breadcrumbs) needs a
 * *stable* way to point at the element a user interacted with — but doc-18
 * `never_collect_raw` forbids ever serializing inner text, input values,
 * hidden-field values, payment data, or query-string values. So we never read
 * `textContent` or `.value`; instead we synthesize a **masked selector**: a
 * short CSS-ish path built from the tag name plus a small allow-list of safe
 * structural attributes (`role`, `data-rt-*`, `type`, sanitized `id`/`class`,
 * `name` for form controls).
 *
 * Two hard rules:
 *   1. NEVER emit user-typed content. Only attribute *names* and structural
 *      tokens — and only attribute *values* that come from the allow-list and
 *      survive PII-shape scrubbing.
 *   2. Honor masking. If an element (or an ancestor) is marked sensitive via
 *      `data-rt-mask` / `data-private` / `type=password` / a user mask
 *      selector, we collapse it to an opaque `[masked]` token and walk no
 *      deeper into its identifying attributes.
 *
 * Every value that does get included is additionally routed through the
 * Stage-1 scrubber (`scrubString`) by the caller's `describeTarget`, so even a
 * developer who stuffed an email into an `id` cannot leak it.
 *
 * A2 reuses `describeTarget` for the `error.resource` target descriptor and
 * any element-oriented breadcrumb.
 */

import { scrubString, shouldMaskElement } from '../scrubber.js';

/** Opaque token substituted for any masked / sensitive element. */
export const MASKED_TOKEN = '[masked]';

/** Max path depth we walk up the ancestor chain when building a selector. */
const MAX_SELECTOR_DEPTH = 4;

/** Max characters in the final descriptor (defense-in-depth against bloat). */
const MAX_DESCRIPTOR_LEN = 256;

/**
 * Tags whose elements are "interactive-looking" for dead-click purposes.
 * Mirrors the spirit of the ARIA interactive-role set without pulling in a
 * dependency.
 */
const INTERACTIVE_TAGS: ReadonlySet<string> = new Set([
  'A',
  'BUTTON',
  'INPUT',
  'SELECT',
  'TEXTAREA',
  'SUMMARY',
  'OPTION',
  'LABEL',
]);

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'menuitem',
  'tab',
  'checkbox',
  'radio',
  'switch',
  'option',
  'combobox',
  'slider',
  'spinbutton',
  'textbox',
  'searchbox',
]);

/**
 * Attribute values longer than this, or that look like free text / PII, are
 * dropped rather than risk leaking content that was stuffed into an attribute.
 */
const MAX_ATTR_VALUE_LEN = 48;

/** A conservative "looks like a stable token, not prose/PII" guard. */
function isSafeAttrToken(value: string): boolean {
  if (value.length === 0 || value.length > MAX_ATTR_VALUE_LEN) return false;
  // Reject anything with whitespace (prose) or characters common in PII/text.
  // Allow the usual identifier punctuation used in CSS / data-* values.
  return /^[A-Za-z0-9_\-:.]+$/.test(value);
}

/**
 * Heuristic: an `id` / `class` token that *looks* like it could carry PII
 * (e.g. an email, a long digit run) is dropped. The scrubber catches obvious
 * PII shapes too, but we prefer to never include the token at all.
 */
function looksLikePii(token: string): boolean {
  if (/@/.test(token)) return true; // email-ish
  if (/\d{5,}/.test(token)) return true; // long digit run (ids, card frags)
  return false;
}

function safeAttr(el: Element, name: string): string | null {
  if (!el.getAttribute) return null;
  const raw = el.getAttribute(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (!isSafeAttrToken(trimmed)) return null;
  if (looksLikePii(trimmed)) return null;
  return trimmed;
}

/** Pick the first stable, non-PII class token (if any). */
function safeClassToken(el: Element): string | null {
  const cls = (el as { className?: unknown }).className;
  if (typeof cls !== 'string' || cls.length === 0) return null;
  for (const token of cls.split(/\s+/)) {
    const t = token.trim();
    if (t.length === 0) continue;
    if (!isSafeAttrToken(t)) continue;
    if (looksLikePii(t)) continue;
    return t;
  }
  return null;
}

/**
 * True when an element (or, transitively, one of its ancestors) is sensitive
 * per the scrubber's masking rules. Ancestor masking matters: a masked form
 * wrapper should mask the descriptor of a click inside it.
 */
export function isMaskedTarget(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string>,
): boolean {
  let cur: Element | null = el ?? null;
  let depth = 0;
  while (cur && depth < 32) {
    if (shouldMaskElement(cur, userSelectors)) return true;
    cur = cur.parentElement;
    depth++;
  }
  return false;
}

/**
 * True when an element looks interactive (clickable) — used by the dead-click
 * heuristic to avoid flagging clicks on plain text / layout nodes.
 */
export function isInteractiveTarget(el: Element | null | undefined): boolean {
  if (!el || !el.tagName) return false;
  if (INTERACTIVE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute?.('role');
  if (role && INTERACTIVE_ROLES.has(role.toLowerCase())) return true;
  // Explicit click affordances.
  if (el.hasAttribute?.('onclick')) return true;
  if (el.hasAttribute?.('tabindex')) return true;
  if (el.hasAttribute?.('data-rt-click')) return true;
  return false;
}

/** Build the single-element token (no ancestor path). */
function describeElement(
  el: Element,
  userSelectors: ReadonlyArray<string>,
): string {
  // Masked element → opaque token, never look at its identifying attributes.
  if (shouldMaskElement(el, userSelectors)) return MASKED_TOKEN;

  const tag = (el.tagName || 'unknown').toLowerCase();
  const parts: string[] = [tag];

  // Stable role / data-rt-* hooks first — these are explicit author intent.
  const role = safeAttr(el, 'role');
  if (role) parts.push(`[role=${role}]`);

  // Generic data-rt-* discovery: include the *names* of rt hooks and safe
  // values. These are author-controlled and the canonical labeling channel.
  if (el.attributes) {
    for (let i = 0; i < el.attributes.length; i++) {
      const attr = el.attributes.item(i);
      if (!attr) continue;
      const name = attr.name;
      if (name === 'data-rt-mask') continue; // handled by masking above
      if (!name.startsWith('data-rt-')) continue;
      const val = safeAttr(el, name);
      parts.push(val ? `[${name}=${val}]` : `[${name}]`);
    }
  }

  // For form controls, the `type` and `name` are structural, not content.
  if (tag === 'input' || tag === 'button') {
    const type = safeAttr(el, 'type');
    if (type) parts.push(`[type=${type}]`);
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') {
    const name = safeAttr(el, 'name');
    if (name) parts.push(`[name=${name}]`);
  }

  // Sanitized id / first class — only if safe, non-PII.
  const id = safeAttr(el, 'id');
  if (id) parts.push(`#${id}`);
  else {
    const cls = safeClassToken(el);
    if (cls) parts.push(`.${cls}`);
  }

  return parts.join('');
}

/**
 * Build a stable, masked descriptor for an element by walking up to
 * `MAX_SELECTOR_DEPTH` ancestors. The result is a `>`-joined CSS-ish path that
 * is stable across renders but carries NO user content.
 *
 * Every produced string is finally routed through the Stage-1 scrubber so any
 * residual PII shape is redacted, satisfying the "no new bypass path" rule.
 */
export function describeTarget(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string> = [],
): string {
  if (!el || !el.tagName) return 'unknown';

  // If the element or an ancestor is masked, do not build an identifying path.
  if (isMaskedTarget(el, userSelectors)) return MASKED_TOKEN;

  const segments: string[] = [];
  let cur: Element | null = el;
  let depth = 0;
  while (cur && depth < MAX_SELECTOR_DEPTH) {
    segments.unshift(describeElement(cur, userSelectors));
    // Stop at the body — the path above it adds no signal.
    if (cur.tagName === 'BODY' || cur.tagName === 'HTML') break;
    cur = cur.parentElement;
    depth++;
  }

  let descriptor = segments.join(' > ');
  if (descriptor.length > MAX_DESCRIPTOR_LEN) {
    descriptor = descriptor.slice(0, MAX_DESCRIPTOR_LEN);
  }

  // Final safety net: route the whole descriptor through the scrubber. This is
  // the same Stage-1 pass `capture()` runs, so no string escapes unscrubbed.
  return scrubString(descriptor).value;
}

/**
 * Build a masked descriptor for a `<form>` (or the closest enclosing form) so
 * repeated-submit can key on a stable per-form identity.
 */
export function describeForm(
  el: Element | null | undefined,
  userSelectors: ReadonlyArray<string> = [],
): string {
  let form: Element | null = el ?? null;
  let depth = 0;
  while (form && form.tagName !== 'FORM' && depth < 8) {
    form = form.parentElement;
    depth++;
  }
  if (!form) return describeTarget(el, userSelectors);
  return describeTarget(form, userSelectors);
}
