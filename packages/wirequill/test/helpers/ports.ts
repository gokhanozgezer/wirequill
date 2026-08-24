import net from 'node:net';

/**
 * Asks the operating system for a free TCP port and releases it again.
 *
 * There is an unavoidable race between releasing the port and the code under
 * test binding it, but tests must not hardcode ports: a developer running the
 * real proxy on 3000 would otherwise see unrelated failures.
 */
export function getFreePort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();

      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('could not determine a free port'));
        return;
      }

      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

/** Holds a port open so a bind conflict can be tested deterministically. */
export async function occupyPort(
  port: number,
  host = '127.0.0.1',
): Promise<{ close(): Promise<void> }> {
  const server = net.createServer();

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve();
    });
  });

  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}
