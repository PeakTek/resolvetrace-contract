import { describe, expect, it } from 'vitest';
import { IdentityState } from '../src/identity.js';

describe('IdentityState', () => {
  it('starts unset', () => {
    const id = new IdentityState();
    expect(id.get()).toBeNull();
    expect(id.toActor()).toBeUndefined();
  });

  it('set / get / clear round-trip with traits', () => {
    const id = new IdentityState();
    id.set('u_42', { plan: 'pro' });
    expect(id.get()).toEqual({ userId: 'u_42', traits: { plan: 'pro' } });
    expect(id.toActor()).toEqual({ userId: 'u_42', traits: { plan: 'pro' } });
    id.clear();
    expect(id.get()).toBeNull();
    expect(id.toActor()).toBeUndefined();
  });

  it('set without traits omits the traits field on the actor', () => {
    const id = new IdentityState();
    id.set('u_42');
    expect(id.toActor()).toEqual({ userId: 'u_42' });
  });

  it('set(null) clears state', () => {
    const id = new IdentityState();
    id.set('u_42');
    id.set(null);
    expect(id.get()).toBeNull();
  });

  it('rejects empty userId', () => {
    const id = new IdentityState();
    expect(() => id.set('')).toThrow(TypeError);
  });

  it('rejects non-object traits', () => {
    const id = new IdentityState();
    expect(() => id.set('u', 'oops' as unknown as Record<string, unknown>)).toThrow(TypeError);
  });

  it('toActor returns a defensive copy of traits', () => {
    const id = new IdentityState();
    const traits: Record<string, unknown> = { plan: 'pro' };
    id.set('u_42', traits);
    const a = id.toActor()!;
    expect(a.traits).toEqual({ plan: 'pro' });
    // Mutating the returned object must not leak into state.
    (a.traits as Record<string, unknown>).plan = 'free';
    expect(id.get()!.traits).toEqual({ plan: 'pro' });
  });
});
