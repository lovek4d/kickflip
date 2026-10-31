// A push endpoint on 127.0.0.1 for tests: it decrypts each Web Push it receives (RFC 8291 aes128gcm) and keeps the
// payloads in `received`, so a test can send through push.mjs without reaching a real push service.
import crypto from 'node:crypto';
import http from 'node:http';

const hmac = (key, input) => crypto.createHmac('sha256', key).update(input).digest();

export async function startFakeDevice() {
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
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/device') { res.writeHead(404).end(); return; }
      received.push(decrypt(Buffer.concat(chunks)));
      res.writeHead(201).end();
    });
  });
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    port,
    received,
    subscription: { endpoint: `http://127.0.0.1:${port}/device`, keys: { p256dh: uaPublic.toString('base64url'), auth: auth.toString('base64url') }, origin: 'https://hub.invalid' },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
