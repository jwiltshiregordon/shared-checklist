import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeAudio, decodeAudio } from './audio.js';

function addNoise(samples, amp = 0.05) {
  return Float32Array.from(samples, (x) => x + (Math.random() * 2 - 1) * amp);
}

test('audio round trip SOS', () => {
  const msg = 'SOS';
  const encoded = encodeAudio(msg);
  const noisy = addNoise(encoded);
  assert.equal(decodeAudio(noisy), msg);
});

test('audio round trip with space', () => {
  const msg = 'HELLO WORLD';
  const wpm = 18;
  const encoded = encodeAudio(msg, { wpm });
  const noisy = addNoise(encoded);
  assert.equal(decodeAudio(noisy, { wpm }), msg);
});
