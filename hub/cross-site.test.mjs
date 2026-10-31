import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossSite, isJSON } from '../starter/cross-site.mjs';

test('fetch metadata and Origin each refuse requests from another site', () => {
  for (const headers of [
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site' },
    { 'sec-fetch-site': '' },
    { 'sec-fetch-site': 'cross-site', origin: 'https://mac.example', host: 'mac.example' },
    { origin: 'https://other.example', host: 'mac.example' },
    { origin: 'null', host: 'mac.example' },
    { origin: 'invalid', host: 'mac.example' },
    { origin: '', host: 'mac.example' },
    { origin: 'https://mac.example:4500', host: 'mac.example:4600' },
    { origin: 'https://mac.example', host: '127.0.0.1', 'x-forwarded-host': 'other.example' },
    { 'sec-fetch-site': 'same-origin', origin: 'https://other.example', host: 'mac.example' },
    { 'sec-fetch-site': 'none', origin: 'https://other.example', host: 'mac.example' },
  ]) assert.equal(crossSite(headers), true, JSON.stringify(headers));
});

test('same-origin pages, direct navigation and non-browser callers pass', () => {
  for (const headers of [
    {},
    { 'sec-fetch-site': 'same-origin' },
    { 'sec-fetch-site': 'none' },
    { origin: 'https://MAC.example:4500', host: 'mac.example:4500' },
    { origin: 'https://mac.example', host: '127.0.0.1', 'x-forwarded-host': 'mac.example' },
    { 'sec-fetch-site': 'same-origin', origin: 'https://mac.example', host: 'mac.example' },
  ]) assert.equal(crossSite(headers), false, JSON.stringify(headers));
});

test('JSON bodies require the application/json media type', () => {
  for (const value of ['application/json', 'application/json; charset=utf-8', ' Application/JSON ']) {
    assert.equal(isJSON({ 'content-type': value }), true, value);
  }
  for (const value of [undefined, '', 'text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data', 'application/jsonp', 'application/json, text/plain']) {
    assert.equal(isJSON({ 'content-type': value }), false, String(value));
  }
});
