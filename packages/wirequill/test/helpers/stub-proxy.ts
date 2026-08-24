import type { ProxyAddress, ProxyServer } from '../../src/proxy/types.js';

export interface StubProxy extends ProxyServer {
  startCalls: number;
  stopCalls: number;
}

/**
 * A `ProxyServer` that binds nothing.
 *
 * Runtime unit tests are about lifecycle ordering, not about sockets. Binding a
 * real port there would make them fight each other and any proxy the developer
 * happens to be running.
 */
export function createStubProxy(
  address: ProxyAddress = { host: '127.0.0.1', port: 3000 },
  behaviour: { failOnStart?: Error } = {},
): StubProxy {
  const stub: StubProxy = {
    startCalls: 0,
    stopCalls: 0,

    start: async () => {
      stub.startCalls += 1;
      if (behaviour.failOnStart !== undefined) {
        throw behaviour.failOnStart;
      }
      await Promise.resolve();
    },

    stop: async () => {
      stub.stopCalls += 1;
      await Promise.resolve();
    },

    address: () => address,
  };

  return stub;
}
