// A push endpoint for tests: it decrypts each Web Push it receives (RFC 8291 aes128gcm) and keeps the payloads in
// `received`, so a test can send through push.mjs without reaching a real push service. With `needs` set, it also
// answers GET /_hub/needs.json with it, standing in for the hub.
// fakeDevice(endpoint) takes requests through its `fetch`, in process; startFakeDevice() serves the same on a port of
// 127.0.0.1, for a push.mjs in another process (KICKFLIP_HUB_PORT naming the port for needs.json).
import crypto from 'node:crypto';
import http from 'node:http';

const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();

export function fakeDevice(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  const uaPublic = ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  const received = [];
  const decrypt = (buf) => {
    const salt = buf.subarray(0, 16);
    const idlen = buf[20];
    const asPublic = buf.subarray(21, 21 + idlen);
    const data = buf.subarray(21 + idlen);
    const ikm = hmac(hmac(auth, ecdh.computeSecret(asPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
    const prk = hmac(salt, ikm);
    const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
    const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
    const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
    decipher.setAuthTag(data.subarray(-16));
    const plain = Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]);
    return JSON.parse(plain.subarray(0, plain.lastIndexOf(2)).toString());
  };
  const device = {
    received,
    needs: null,
    subscription: { endpoint, keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') }, origin: 'https://hub.invalid' },
    // Answers a POST to the endpoint with 201 and a GET of /_hub/needs.json with needs while it is set; else 404.
    fetch: async (url, { method = 'GET', body } = {}) => {
      if (method === 'GET' && new URL(url).pathname === '/_hub/needs.json' && device.needs) return Response.json(device.needs);
      if (method !== 'POST' || String(url) !== endpoint) return new Response(null, { status: 404 });
      received.push(decrypt(Buffer.from(body)));
      return new Response(null, { status: 201 });
    },
  };
  return device;
}

export async function startFakeDevice() {
  let device;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const r = await device.fetch(`${origin}${req.url}`, { method: req.method, body: req.method === 'GET' ? undefined : Buffer.concat(chunks) });
    res.writeHead(r.status, { 'content-type': 'application/json' }).end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;
  device = fakeDevice(`${origin}/device`);
  return Object.assign(device, { port, close: () => new Promise((resolve) => server.close(resolve)) });
}
