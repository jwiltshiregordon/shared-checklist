import { encode, decode } from './morse.js';

// Duration of a single Morse unit in samples
function unitSamples(sampleRate, wpm) {
  return Math.floor((sampleRate * 1.2) / wpm);
}

export function encodeAudio(text, { sampleRate = 8000, wpm = 20 } = {}) {
  const unit = unitSamples(sampleRate, wpm);
  const codes = encode(text).split(' ');
  const out = [];
  const pushTone = (units) => {
    const len = units * unit;
    for (let i = 0; i < len; i++) out.push(1);
  };
  const pushGap = (units) => {
    const len = units * unit;
    for (let i = 0; i < len; i++) out.push(0);
  };

  for (const code of codes) {
    if (code === '/') {
      pushGap(7);
      continue;
    }
    for (let i = 0; i < code.length; i++) {
      const sym = code[i];
      pushTone(sym === '.' ? 1 : 3);
      if (i < code.length - 1) pushGap(1);
    }
    pushGap(3);
  }
  // Remove trailing gap
  out.splice(out.length - 3 * unit);
  return Float32Array.from(out);
}

export function decodeAudio(samples, { sampleRate = 8000, wpm = 20, threshold = 0.2 } = {}) {
  const unit = unitSamples(sampleRate, wpm);
  const morse = [];
  let i = 0;
  let symbol = [];
  const isTone = (x) => Math.abs(x) > threshold;
  while (i < samples.length) {
    const on = isTone(samples[i]);
    const start = i;
    while (i < samples.length && isTone(samples[i]) === on) i++;
    const units = Math.round((i - start) / unit);
    if (on) {
      symbol.push(units > 2 ? '-' : '.');
    } else {
      if (units >= 7) {
        if (symbol.length) morse.push(symbol.join(''));
        morse.push('/');
        symbol = [];
      } else if (units >= 3) {
        if (symbol.length) morse.push(symbol.join(''));
        symbol = [];
      } // gaps <3 units are between symbols
    }
  }
  if (symbol.length) morse.push(symbol.join(''));
  return decode(morse.join(' '));
}
