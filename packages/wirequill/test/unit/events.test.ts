import { describe, expect, it } from 'vitest';
import { WireQuillEventBus } from '../../src/events/event-bus.js';
import type { WireQuillEvent } from '../../src/events/types.js';

function discovered(path: string, revision = 1): WireQuillEvent {
  return {
    type: 'operation.discovered',
    revision,
    operationId: `op-${path}`,
    method: 'GET',
    path,
  };
}

function updated(path: string, revision = 2): WireQuillEvent {
  return { ...discovered(path, revision), type: 'operation.updated' };
}

describe('WireQuillEventBus', () => {
  it('delivers discovery events to every subscriber', () => {
    const bus = new WireQuillEventBus();
    const first: WireQuillEvent[] = [];
    const second: WireQuillEvent[] = [];

    bus.subscribe((event) => first.push(event));
    bus.subscribe((event) => second.push(event));

    bus.emit(discovered('/users'));

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0]?.type).toBe('operation.discovered');
    expect(first[0]?.path).toBe('/users');
  });

  it('delivers update events', () => {
    const bus = new WireQuillEventBus();
    const seen: WireQuillEvent[] = [];

    bus.subscribe((event) => seen.push(event));
    bus.emit(updated('/users/{userId}', 7));

    expect(seen).toEqual([
      {
        type: 'operation.updated',
        revision: 7,
        operationId: 'op-/users/{userId}',
        method: 'GET',
        path: '/users/{userId}',
      },
    ]);
  });

  it('stops delivering once a subscriber disposes', () => {
    const bus = new WireQuillEventBus();
    const seen: WireQuillEvent[] = [];

    const dispose = bus.subscribe((event) => seen.push(event));
    bus.emit(discovered('/one'));

    dispose();
    bus.emit(discovered('/two'));

    expect(seen.map((event) => event.path)).toEqual(['/one']);
    expect(bus.listenerCount).toBe(0);
  });

  it('tolerates a disposer being called twice', () => {
    const bus = new WireQuillEventBus();
    const dispose = bus.subscribe(() => undefined);

    dispose();
    expect(() => dispose()).not.toThrow();
    expect(bus.listenerCount).toBe(0);
  });

  it('isolates a throwing subscriber from the others', () => {
    const bus = new WireQuillEventBus();
    const seen: string[] = [];

    bus.subscribe(() => {
      throw new Error('a browser went away mid-write');
    });
    bus.subscribe((event) => seen.push(event.path));

    // A failing listener must not surface here: this call sits on the tail of
    // request processing (spec section 129).
    expect(() => bus.emit(discovered('/checkout'))).not.toThrow();
    expect(seen).toEqual(['/checkout']);
  });

  it('lets a subscriber unsubscribe from inside delivery', () => {
    const bus = new WireQuillEventBus();
    const seen: string[] = [];

    const dispose = bus.subscribe((event) => {
      seen.push(event.path);
      dispose();
    });

    bus.emit(discovered('/first'));
    bus.emit(discovered('/second'));

    expect(seen).toEqual(['/first']);
  });

  it('clears every subscriber at once', () => {
    const bus = new WireQuillEventBus();
    bus.subscribe(() => undefined);
    bus.subscribe(() => undefined);

    bus.clear();

    expect(bus.listenerCount).toBe(0);
  });
});
