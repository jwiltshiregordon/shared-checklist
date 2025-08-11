import test from 'node:test';
import assert from 'node:assert/strict';
import { encode, decode } from './morse.js';

test('encode SOS', () => {
  assert.equal(encode('SOS'), '... --- ...');
});

test('decode SOS', () => {
  assert.equal(decode('... --- ...'), 'SOS');
});

test('round trip with space', () => {
  const msg = 'HELLO WORLD';
  assert.equal(decode(encode(msg)), msg);
});
