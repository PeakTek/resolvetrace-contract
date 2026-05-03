/**
 * In-memory identity state set by `client.identify(...)`.
 *
 * Kept deliberately separate from the session manager: identity is a
 * decoration that flows through every event envelope and the next
 * `/v1/session/start` body, but it does NOT drive session lifecycle
 * (no rollover, no network call by itself).
 */

import type { ActorIdentity } from './types.js';

/** Snapshot of the current identity, or null when none is set. */
export interface IdentitySnapshot {
  userId: string;
  traits?: Record<string, unknown>;
}

/** Holds the current identity decoration in memory. */
export class IdentityState {
  private current: IdentitySnapshot | null = null;

  /** Replace the current identity. Pass `null` for `userId` to clear. */
  set(userId: string | null, traits?: Record<string, unknown>): void {
    if (userId === null) {
      this.current = null;
      return;
    }
    if (typeof userId !== 'string' || userId.length === 0) {
      throw new TypeError('identify(userId, traits?) requires a non-empty string user id or null.');
    }
    const next: IdentitySnapshot = { userId };
    if (traits !== undefined) {
      if (traits === null || typeof traits !== 'object') {
        throw new TypeError('identify(userId, traits?) requires `traits` to be an object if provided.');
      }
      next.traits = { ...traits };
    }
    this.current = next;
  }

  /** Read the current identity snapshot, or `null` if none is set. */
  get(): IdentitySnapshot | null {
    return this.current;
  }

  /** Clear the current identity. */
  clear(): void {
    this.current = null;
  }

  /**
   * Build the `actor` decoration for an event envelope, or `undefined` when
   * no identity is currently held.
   */
  toActor(): ActorIdentity | undefined {
    if (this.current === null) return undefined;
    const out: ActorIdentity = { userId: this.current.userId };
    if (this.current.traits !== undefined) {
      out.traits = { ...this.current.traits };
    }
    return out;
  }
}
