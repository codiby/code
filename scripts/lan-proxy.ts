/**
 * Expone el bridge (que la app de escritorio ata a 127.0.0.1) en la IP LAN,
 * sin reconstruir Electron. Es un proxy TCP crudo: no toca los bytes, así que
 * HTTP y los upgrades a WebSocket pasan igual, y el header `Host` llega tal
 * cual lo mandó el cliente.
 *
 *   bun run scripts/lan-proxy.ts [ipLan] [puerto] [puertoDestino]
 *
 * Escucha en la IP LAN concreta en vez de 0.0.0.0 para no chocar con el
 * socket que el bridge ya tiene abierto en 127.0.0.1 del mismo puerto.
 */
import { networkInterfaces } from 'node:os';

function lanIp(): string {
  for (const addrs of Object.values(networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return addr.address;
    }
  }
  throw new Error('No encontré una IP LAN IPv4');
}

const listenHost = process.argv[2] || lanIp();
const listenPort = Number(process.argv[3] || 3111);
const targetPort = Number(process.argv[4] || 3111);

interface Bridge {
  upstream: ReturnType<typeof Bun.connect> extends Promise<infer T> ? T | null : never;
  pending: Uint8Array[];
}

Bun.listen<Bridge>({
  hostname: listenHost,
  port: listenPort,
  socket: {
    open(client) {
      // Se asigna antes del primer await: `data` puede dispararse mientras la
      // conexión al upstream todavía se está abriendo.
      client.data = { upstream: null, pending: [] };

      Bun.connect({
        hostname: '127.0.0.1',
        port: targetPort,
        socket: {
          data: (_s, chunk) => client.write(chunk),
          close: () => client.end(),
          error: () => client.end(),
        },
      })
        .then(upstream => {
          client.data.upstream = upstream;
          for (const chunk of client.data.pending) upstream.write(chunk);
          client.data.pending.length = 0;
        })
        .catch(() => client.end());
    },
    data(client, chunk) {
      const { upstream, pending } = client.data;
      if (upstream) upstream.write(chunk);
      else pending.push(chunk);
    },
    close: client => client.data?.upstream?.end(),
    error: client => client.data?.upstream?.end(),
  },
});

console.log(`lan-proxy: ${listenHost}:${listenPort} -> 127.0.0.1:${targetPort}`);
