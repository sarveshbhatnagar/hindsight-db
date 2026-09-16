import { randomFillSync } from "node:crypto";

const buf = new Uint8Array(16);
const hex: string[] = [];
for (let i = 0; i < 256; i++) hex.push(i.toString(16).padStart(2, "0"));

let lastMs = 0;
let seq = 0;

/**
 * UUID v7 (RFC 9562): a 48-bit millisecond timestamp, a 12-bit sequence in
 * `rand_a` so ids minted in the same millisecond still sort in creation
 * order (method 3 of the RFC), then 62 random bits.
 *
 * Time-ordered ids keep B-tree inserts sequential and make ids meaningful
 * when debugging. This is the default id generator for every store.
 */
export function uuidv7(now: number = Date.now()): string {
  if (now > lastMs) {
    lastMs = now;
    seq = 0;
  } else {
    // Same (or earlier — clock went backwards) millisecond: keep ordering by
    // advancing the sequence, spilling into the next ms if it overflows.
    if (++seq > 0xfff) {
      lastMs++;
      seq = 0;
    }
    now = lastMs;
  }
  randomFillSync(buf, 8, 8); // rand_b only; bytes 0..7 are set below
  buf[0] = (now / 2 ** 40) & 0xff;
  buf[1] = (now / 2 ** 32) & 0xff;
  buf[2] = (now / 2 ** 24) & 0xff;
  buf[3] = (now / 2 ** 16) & 0xff;
  buf[4] = (now / 2 ** 8) & 0xff;
  buf[5] = now & 0xff;
  buf[6] = 0x70 | (seq >> 8); // version 7 + high 4 bits of the sequence
  buf[7] = seq & 0xff; // low 8 bits of the sequence
  buf[8] = (buf[8]! & 0x3f) | 0x80; // RFC 4122 variant
  let s = "";
  for (let i = 0; i < 16; i++) {
    s += hex[buf[i]!];
    if (i === 3 || i === 5 || i === 7 || i === 9) s += "-";
  }
  return s;
}
