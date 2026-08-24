import http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  openSse,
  startDocsHarness,
  type DocsHarness,
  type SseFrame,
} from '../helpers/docs-harness.js';

/**
 * The live update channel (spec sections 54 to 70, 130, 131, 150 to 154).
 *
 * These tests are the difference between "the documentation updates" and "the
 * documentation updates without the browser being reloaded", which is the whole
 * promise of this milestone.
 */

let harness: DocsHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

function operationFrames(frames: readonly SseFrame[]): SseFrame[] {
  return frames.filter((frame) => frame.event.startsWith('operation.'));
}

describe('server-sent events', () => {
  it('greets a new client with the current revision', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      expect(client.frames[0]?.event).toBe('ready');
      expect(client.frames[0]?.data.revision).toBe(harness.runtime.openApi.getRevision());
      // A handshake, not a contract change (spec section 63).
      expect(operationFrames(client.frames)).toHaveLength(0);
    } finally {
      client.close();
    }
  });

  it('announces a newly discovered operation', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);
      await harness.call('/schema?id=1');
      await client.waitFor((frames) => operationFrames(frames).length > 0);

      const [event] = operationFrames(client.frames);

      expect(event?.event).toBe('operation.discovered');
      expect(event?.data.method).toBe('GET');
      expect(event?.data.path).toBe('/schema');
      expect(event?.data.revision).toBe(harness.runtime.openApi.getRevision());
      expect(typeof event?.data.operationId).toBe('string');
    } finally {
      client.close();
    }
  });

  it('carries no raw path, query, header or body in the payload', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      // A credential-shaped segment, the way a password-reset link carries one.
      // A merely unusual-looking literal such as `EVENT_PATH_SECRET` is a route
      // name, and Faz 3 deliberately keeps those: the guarantee is about
      // credentials, not about capital letters.
      const pathCredential = 'r_9f3c1ae64b7d40f2ab18c7e5d0916b3a';

      await harness.call(`/reset/${pathCredential}?token=EVENT_QUERY_SECRET`, {
        headers: { Authorization: 'Bearer EVENT_HEADER_SECRET' },
      });
      await client.waitFor((frames) => operationFrames(frames).length > 0);

      const serialised = JSON.stringify(client.frames);

      for (const marker of [
        pathCredential,
        'EVENT_QUERY_SECRET',
        'EVENT_HEADER_SECRET',
        'token=',
      ]) {
        expect(serialised).not.toContain(marker);
      }

      // The template, not the request target (spec section 55).
      expect(operationFrames(client.frames)[0]?.data.path).toBe('/reset/{token}');
    } finally {
      client.close();
    }
  });

  it('does not spam events for identical traffic', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      for (let index = 0; index < 10; index += 1) {
        await harness.call('/json');
      }

      await harness.waitForOperations(1);
      // Give any further events a chance to arrive before counting them.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const events = operationFrames(client.frames);
      const updates = events.filter((frame) => frame.event === 'operation.updated');

      expect(events.filter((frame) => frame.event === 'operation.discovered')).toHaveLength(1);
      // Requiredness legitimately turns on once the third sample confirms it.
      // Everything after that teaches the document nothing, so it says nothing
      // (spec sections 57 and 151).
      expect(updates.length).toBeLessThanOrEqual(1);
      expect(events.length).toBeLessThanOrEqual(2);
    } finally {
      client.close();
    }
  });

  it('announces a structural change to an existing operation', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      await harness.call('/users/1');
      await client.waitFor((frames) => operationFrames(frames).length >= 1);

      // A query parameter nobody had sent before: the same operation, a
      // different contract (spec section 152).
      await harness.call('/users/1?page=2');
      await client.waitFor((frames) => operationFrames(frames).length >= 2);

      const events = operationFrames(client.frames);

      expect(events[0]?.event).toBe('operation.discovered');
      expect(events[1]?.event).toBe('operation.updated');
      expect(events[1]?.data.path).toBe('/users/{userId}');
      expect(Number(events[1]?.data.revision)).toBeGreaterThan(Number(events[0]?.data.revision));
    } finally {
      client.close();
    }
  });

  it('announces a status nobody had seen before', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      await harness.call('/status/200');
      await client.waitFor((frames) => operationFrames(frames).length >= 1);

      await harness.call('/status/404');
      await client.waitFor((frames) => operationFrames(frames).length >= 2);

      const events = operationFrames(client.frames);

      expect(events[1]?.event).toBe('operation.updated');
      expect(events[1]?.data.path).toBe(events[0]?.data.path);
    } finally {
      client.close();
    }
  });

  it('reports the revision the document actually has', async () => {
    harness = await startDocsHarness();
    const client = await openSse(harness.docsOrigin);

    try {
      await client.waitFor((frames) => frames.length > 0);

      await harness.call('/schema?id=1');
      await client.waitFor((frames) => operationFrames(frames).length > 0);

      // The event and the document must never disagree: there is one revision
      // counter and it lives in OpenApiService (spec sections 60 and 61).
      const event = operationFrames(client.frames).at(-1);
      const document = harness.runtime.openApi.getDocument() as {
        'x-wirequill': { revision: number };
      };

      expect(event?.data.revision).toBe(document['x-wirequill'].revision);
    } finally {
      client.close();
    }
  });

  it('fans out to every connected client', async () => {
    harness = await startDocsHarness();
    const first = await openSse(harness.docsOrigin);
    const second = await openSse(harness.docsOrigin);

    try {
      await first.waitFor((frames) => frames.length > 0);
      await second.waitFor((frames) => frames.length > 0);

      await harness.call('/schema?id=1');

      await first.waitFor((frames) => operationFrames(frames).length > 0);
      await second.waitFor((frames) => operationFrames(frames).length > 0);

      expect(operationFrames(first.frames)[0]?.data.path).toBe('/schema');
      expect(operationFrames(second.frames)[0]?.data.path).toBe('/schema');
    } finally {
      first.close();
      second.close();
    }
  });

  it('keeps serving the remaining clients after one disconnects', async () => {
    harness = await startDocsHarness();
    const leaving = await openSse(harness.docsOrigin);
    const staying = await openSse(harness.docsOrigin);

    try {
      await leaving.waitFor((frames) => frames.length > 0);
      await staying.waitFor((frames) => frames.length > 0);

      leaving.close();
      // The server has to notice the socket is gone before the count is right.
      await waitForClients(harness, 1);

      await harness.call('/schema?id=1');
      await staying.waitFor((frames) => operationFrames(frames).length > 0);

      expect(operationFrames(staying.frames)).toHaveLength(1);
      expect(operationFrames(leaving.frames)).toHaveLength(0);
    } finally {
      staying.close();
    }
  });

  it('releases every client when the runtime stops, and stops quickly', async () => {
    const local = await startDocsHarness();
    const first = await openSse(local.docsOrigin);
    const second = await openSse(local.docsOrigin);

    await first.waitFor((frames) => frames.length > 0);
    await second.waitFor((frames) => frames.length > 0);

    const startedAt = Date.now();
    await local.runtime.stop();
    const elapsed = Date.now() - startedAt;

    // The Faz 1 WebSocket hang, in a new costume: an SSE response is a request
    // that never finishes, and `server.close()` waits for every request
    // (spec sections 68 and 69).
    expect(elapsed).toBeLessThan(2_000);

    first.close();
    second.close();
    await local.backend.close();
  });

  it('refuses an upgrade on the docs port rather than leaving a socket open', async () => {
    harness = await startDocsHarness();
    const address = new URL(harness.docsOrigin);

    // A socket Node has handed to an upgrade handler is a socket `close()` no
    // longer waits for — the exact shape of the Faz 1 shutdown hang. Nothing on
    // this port upgrades, so the handshake is refused outright.
    const upgraded = await new Promise<boolean>((resolve) => {
      const outgoing = http.request({
        host: address.hostname,
        port: address.port,
        path: '/__wirequill/events',
        headers: { Connection: 'Upgrade', Upgrade: 'websocket' },
      });

      outgoing.on('upgrade', () => resolve(true));
      outgoing.on('error', () => resolve(false));
      outgoing.on('response', (response) => {
        response.resume();
        resolve(false);
      });
      outgoing.end();
    });

    expect(upgraded).toBe(false);
  });
});

async function waitForClients(target: DocsHarness, count: number): Promise<void> {
  const deadline = Date.now() + 5_000;

  while (target.runtime.docsSseClientCount !== count) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${String(count)} event-stream clients`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
