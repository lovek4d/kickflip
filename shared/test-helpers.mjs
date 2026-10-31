import net from 'node:net';
import assert from 'node:assert/strict';
import { setTimeout } from 'node:timers/promises';

export async function freePorts(count = 1) {
  const servers = [];
  try {
    const ports = [];
    for (let i = 0; i < count; i++) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
      ports.push(server.address().port);
    }
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

export async function until(predicate, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, message);
    await setTimeout(20);
  }
}
