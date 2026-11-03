// Huge CSI counts (ticket 163, #305): every xterm a Session's output goes to must take them
// fast. Unclamped, xterm.js 6 takes about 0.75 µs per count for IL, DL, SU and SD (over a minute
// for these) and runs out of memory on IL; REP is slower still per count.

/** The count: eight digits, far past any screen. */
export const HUGE = 99999999;

/** Each CSI that takes a count, with HUGE: IL, DL, ICH, DCH, ECH, SU, SD, CUF, CUB, REP (after a
 * character to repeat), CUP and CHT. */
export const HUGE_CSI: [name: string, seq: string][] = [
  ["IL", `\x1b[${HUGE}L`],
  ["DL", `\x1b[${HUGE}M`],
  ["ICH", `\x1b[${HUGE}@`],
  ["DCH", `\x1b[${HUGE}P`],
  ["ECH", `\x1b[${HUGE}X`],
  ["SU", `\x1b[${HUGE}S`],
  ["SD", `\x1b[${HUGE}T`],
  ["CUF", `\x1b[${HUGE}C`],
  ["CUB", `\x1b[${HUGE}D`],
  ["REP", `x\x1b[${HUGE}b`],
  ["CUP", `\x1b[${HUGE};${HUGE}H`],
  ["CHT", `\x1b[${HUGE}I`],
];

/** What a terminal may spend on one of them, in ms: generous for a busy machine (clamped, each
 * takes a few ms), and nowhere near the seconds to minutes they take unclamped. */
export const HUGE_CSI_MS = 3000;

/** `seq` split in two inside its count, as two reads of a Session can split it. */
export function splitInCount(seq: string): [string, string] {
  const at = seq.indexOf(String(HUGE)) + 4;
  return [seq.slice(0, at), seq.slice(at)];
}
