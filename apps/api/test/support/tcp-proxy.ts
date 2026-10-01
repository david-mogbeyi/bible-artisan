import { type AddressInfo, connect, createServer, type Socket } from 'node:net';

export type ProxyMode = 'forward' | 'blackhole';

export interface TcpProxy {
  readonly port: number;
  /** `forward` pipes to the target; `blackhole` accepts and never answers (a hung server). */
  mode: ProxyMode;
  /** Connections accepted since start (each one a database connect attempt). */
  readonly connections: number;
  /** Client sockets currently open, in either mode. */
  readonly openSockets: number;
  /** `url` with its host and port replaced by this proxy's. */
  urlFor(url: string): string;
  /** Destroys every open connection (the database went away). */
  dropAll(): void;
  close(): Promise<void>;
}

/** A local TCP proxy in front of `target` (e.g. the test PostgreSQL), switchable at runtime. */
export async function startTcpProxy(target: { host: string; port: number }): Promise<TcpProxy> {
  const sockets = new Set<Socket>();
  let connections = 0;
  let mode: ProxyMode = 'forward';

  const server = createServer((client) => {
    connections += 1;
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    client.on('error', () => client.destroy());
    if (mode === 'blackhole') {
      // Read and discard (never answer), so the client hanging up is noticed and counted.
      client.resume();
      return;
    }
    const upstream = connect(target.port, target.host);
    sockets.add(upstream);
    upstream.on('close', () => {
      sockets.delete(upstream);
      client.destroy();
    });
    upstream.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
    client.pipe(upstream).pipe(client);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    port,
    get mode() {
      return mode;
    },
    set mode(next: ProxyMode) {
      mode = next;
    },
    get connections() {
      return connections;
    },
    get openSockets() {
      // Client-side sockets only: each forwarded connection also has an upstream socket.
      return [...sockets].filter((socket) => socket.localPort === port).length;
    },
    urlFor(url: string): string {
      const proxied = new URL(url);
      proxied.hostname = '127.0.0.1';
      proxied.port = String(port);
      return proxied.toString();
    },
    dropAll(): void {
      for (const socket of sockets) socket.destroy();
    },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** Host and port of a postgres:// URL. */
export function hostAndPort(url: string): { host: string; port: number } {
  const parsed = new URL(url);
  return { host: parsed.hostname || 'localhost', port: Number(parsed.port || 5432) };
}
