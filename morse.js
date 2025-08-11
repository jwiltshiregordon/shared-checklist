export const MORSE = {
  A: ".-",
  B: "-...",
  C: "-.-.",
  D: "-..",
  E: ".",
  F: "..-.",
  G: "--.",
  H: "....",
  I: "..",
  J: ".---",
  K: "-.-",
  L: ".-..",
  M: "--",
  N: "-.",
  O: "---",
  P: ".--.",
  Q: "--.-",
  R: ".-.",
  S: "...",
  T: "-",
  U: "..-",
  V: "...-",
  W: ".--",
  X: "-..-",
  Y: "-.--",
  Z: "--..",
  0: "-----",
  1: ".----",
  2: "..---",
  3: "...--",
  4: "....-",
  5: ".....",
  6: "-....",
  7: "--...",
  8: "---..",
  9: "----.",
};

export const REV = new Map(Object.entries(MORSE).map(([k, v]) => [v, k]));

export function encode(text) {
  const upper = text.toUpperCase();
  const out = [];
  for (const ch of upper) {
    if (ch === " ") {
      out.push("/");
      continue;
    }
    const code = MORSE[ch];
    if (code) out.push(code);
  }
  return out.join(" ");
}

export function decode(morse) {
  return morse
    .split(" ")
    .map((code) => (code === "/" ? " " : REV.get(code) || ""))
    .join("");
}
