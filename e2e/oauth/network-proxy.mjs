import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';

// WebKit can leave an intercepted, cancelled request waiting for its protocol ACK.
// Enforce browser egress outside interception; forward the real HTTP exchange unchanged.
export async function startNetworkProxy(origins) {
  const hits = new Map(origins.map(origin => {
    const url = new URL(origin);
    assert.ok(url.origin === origin && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname));
    return [origin, 0];
  }));
  const sockets = new Set(), upstreams = new Set();
  let blocked = 0;
  const server = createServer((incoming, outgoing) => {
    let url;
    try { url = new URL(incoming.url); } catch { /* Reject origin-form and malformed proxy requests. */ }
    if (!url || url.username || url.password || !hits.has(url.origin)) {
      blocked++;
      outgoing.writeHead(403, { 'content-type': 'text/plain' }).end('Unplanned browser origin');
      return;
    }
    hits.set(url.origin, hits.get(url.origin) + 1);
    const headers = { ...incoming.headers, host: url.host, connection: 'close' };
    delete headers['proxy-connection'];
    const upstream = request(url, { method: incoming.method, agent: false, headers }, response => {
      outgoing.writeHead(response.statusCode, { ...response.headers, connection: 'close' });
      response.pipe(outgoing);
    });
    upstreams.add(upstream);
    upstream.once('close', () => upstreams.delete(upstream));
    upstream.once('error', () => { if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
    incoming.once('aborted', () => upstream.destroy());
    outgoing.once('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  const denyTunnel = (_request, socket) => { blocked++; socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); };
  server.on('connect', denyTunnel);
  server.on('upgrade', denyTunnel);
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    evidence: () => ({ blocked, requestsByOrigin: [...hits.values()] }),
    assertTraffic() {
      assert.equal(blocked, 0, 'OAuth browser attempted an unplanned origin or tunnel');
      assert.ok([...hits.values()].every(count => count > 0), 'OAuth browser bypassed its egress proxy');
    },
    async close() {
      const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      for (const upstream of upstreams) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
}
