import { MORSE, REV } from './morse-table.js';
export { MORSE, REV };

export function encode(text) {
  const upper = text.toUpperCase();
  const out = [];
  for (const ch of upper) {
    if (ch === ' ') {
      out.push('/');
      continue;
    }
    const code = MORSE[ch];
    if (code) out.push(code);
  }
  return out.join(' ');
}

export function decode(morse) {
  return morse
    .split(' ')
    .map((code) => (code === '/' ? ' ' : REV.get(code) || ''))
    .join('');
}
