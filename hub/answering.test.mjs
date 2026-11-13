import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAnswering, MISSES } from './answering.mjs';

const miss = (a, n) => { for (let i = 0; i < n; i++) a.record('s', false); };

test('a port site that misses one probe stays up', () => {
  const a = createAnswering();
  a.record('s', true);
  miss(a, 1);
  assert.equal(a.state('s'), 'up');
});

test('a port site that misses 3 probes in a row reads down', () => {
  const a = createAnswering();
  a.record('s', true);
  miss(a, MISSES - 1);
  assert.equal(a.state('s'), 'up');
  miss(a, 1);
  assert.equal(a.state('s'), 'down');
});

test('one success brings a down site back up and resets the count', () => {
  const a = createAnswering();
  miss(a, MISSES);
  assert.equal(a.state('s'), 'down');
  a.record('s', true);
  assert.equal(a.state('s'), 'up');
  miss(a, MISSES - 1);
  assert.equal(a.state('s'), 'up');
});

test('a site reads starting until it is probed, and while its first misses are few', () => {
  const a = createAnswering();
  assert.equal(a.state('s'), 'starting');
  miss(a, 1);
  assert.equal(a.state('s'), 'starting');
});

test('a forgotten site reads starting again', () => {
  const a = createAnswering();
  a.record('s', true);
  a.forget('s');
  assert.equal(a.state('s'), 'starting');
  assert.deepEqual(a.routes(), []);
});
