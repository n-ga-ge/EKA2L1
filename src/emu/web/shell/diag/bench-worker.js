// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The speed test of the diagnostics ("Test this device" in environment.js):
// how fast this device does the kind of work the emulator does.
//
// The emulator's cost is one thread interpreting ARM code in WebAssembly:
// fetch an instruction, jump on its kind, read and write the guest's
// registers and memory, again. The test is that in small: an interpreter for
// a made-up processor of 16 instructions, in WebAssembly, running a guest
// program shaped like a frame of a 2004 game (a textured picture drawn pixel
// by pixel through a palette, copied to the screen, then some branchy
// bookkeeping): the same shape as the guest of tools/wasm-spike in the site's
// repository, which measures the real interpreter. It is not the emulator's
// interpreter, so its speed says how fast a device is beside another one,
// not how many frames a game will draw.
//
// The page has no build step, so the WebAssembly module is put together here,
// byte by byte (buildModule). The same interpreter exists in JavaScript
// (runJs): it tells whether the module computes what it should, and it is
// what runs where the module cannot be made. The two are scored against
// different reference speeds (environment.js).
//
// As a worker (new Worker(url, { type: 'module' })) it takes one message,
// { cmd: 'run', ms, engine }, and answers { ok: true, engine, mips, bestMips,
// slices, ms } or { ok: false, error }. `engine: 'js'` asks for the
// JavaScript interpreter although the other would do: that is how its
// reference speed is measured. Nothing here touches a worker's globals when
// it is imported, so a test can import it and call the parts.

// --- the made-up processor ----------------------------------------------------
//
// Sixteen registers of 32 bits. An instruction is one 32-bit word:
//   bits 0-7 the operation, 8-11 register d, 12-15 register n, and in bits
//   16-31 either register m (bits 16-19) or a 16-bit number.
// Memory addresses wrap at 1 MiB. A branch counts in instructions from the
// one after it. An operation that does not exist stops the run.

const OP = {
  movi: 0, // d = number
  add: 1, // d = n + m
  sub: 2, // d = n - m
  and: 3, // d = n & m
  xor: 4, // d = n ^ m
  orr: 5, // d = n | m
  mul: 6, // d = n * m
  shli: 7, // d = n << number
  shri: 8, // d = n >>> number
  addi: 9, // d = n + number (signed)
  andi: 10, // d = n & number
  ldb: 11, // d = byte at n + m
  ldw: 12, // d = word at n + m
  stw: 13, // word at n + m = d
  bne: 14, // branch when d != n
  blt: 15, // branch when d < n (signed)
};

// Where things are in the interpreter's memory (the WebAssembly module's, or
// an ArrayBuffer of the same size for the JavaScript one).
const REGS = 0x00; // 16 words
const PC = 0x40; // the next instruction's index, kept between runs
const CODE = 0x100; // the guest program
const RAM = 0x100000; // the guest's memory, 1 MiB
const PAGES = 32; // of 64 KiB: 2 MiB in all

// The guest's memory.
const TEX = 0x00000; // a 64x64 texture, a byte a texel
const PAL = 0x02000; // 8 light levels of 256 colours, a word each
const ENTS = 0x04000; // 64 words of "game state"
const FB = 0x10000; // the screen, 176x208 words
const BACK = 0x40000; // the picture being drawn
const W = 176;
const H = 208;

// The guest program. One turn of its outer loop is a frame, about 750,000
// instructions; it never ends.
function guestProgram() {
  const code = [];
  const labels = {};
  const branches = [];
  const word = (op, d, n, low) => code.push(op | (d << 8) | (n << 12) | ((low & 0xffff) << 16));
  const label = (name) => { labels[name] = code.length; };
  const three = (op) => (d, n, m) => word(op, d, n, m);
  const branch = (op) => (d, n, target) => { branches.push([code.length, target]); word(op, d, n, 0); };
  const movi = (d, number) => word(OP.movi, d, 0, number);
  const [add, sub, and, xor, orr, mul] = [OP.add, OP.sub, OP.and, OP.xor, OP.orr, OP.mul].map(three);
  const [shli, shri, addi, andi] = [OP.shli, OP.shri, OP.addi, OP.andi].map(three);
  const [ldb, ldw, stw] = [OP.ldb, OP.ldw, OP.stw].map(three);
  const [bne, blt] = [OP.bne, OP.blt].map(branch);
  // r11 is always 0; r12 counts frames; r13 is the random number.
  movi(11, 0);
  movi(12, 0);
  movi(13, 12345);

  label('frame');
  addi(12, 12, 1);
  movi(6, 0); // y
  movi(7, BACK >> 16);
  shli(7, 7, 16); // where the next pixel goes
  label('row');
  addi(0, 6, -H / 2); // d = |y - H/2| + 8
  blt(11, 0, 'below');
  sub(0, 11, 0);
  label('below');
  addi(0, 0, 8);
  shri(9, 0, 4); // the row's light level, 0 to 7
  andi(9, 9, 7);
  shli(9, 9, 10);
  addi(8, 9, PAL); // its palette
  movi(9, 0x1234); // the texture steps of this row
  mul(3, 0, 9);
  addi(3, 3, 0x4000);
  andi(4, 12, 0xffff);
  addi(4, 4, -0x8000);
  shli(9, 6, 6);
  add(4, 4, 9);
  movi(9, 977); // where the row starts in the texture
  mul(1, 12, 9);
  movi(9, 0x2345);
  mul(9, 6, 9);
  add(1, 1, 9);
  movi(9, 331);
  mul(2, 12, 9);
  movi(5, W);
  movi(14, 0xfc0);
  label('pixel');
  shri(0, 2, 10);
  and(0, 0, 14);
  shri(9, 1, 16);
  andi(9, 9, 63);
  orr(0, 0, 9);
  ldb(0, 0, 11); // the texel
  shli(0, 0, 2);
  ldw(0, 8, 0); // its colour in this light
  stw(0, 7, 11);
  addi(7, 7, 4);
  add(1, 1, 3);
  add(2, 2, 4);
  addi(5, 5, -1);
  bne(5, 11, 'pixel');
  addi(6, 6, 1);
  movi(9, H);
  bne(6, 9, 'row');

  movi(7, BACK >> 16); // the finished picture goes to the screen
  shli(7, 7, 16);
  movi(10, FB >> 16);
  shli(10, 10, 16);
  movi(5, W * H);
  label('copy');
  ldw(0, 7, 11);
  stw(0, 10, 11);
  addi(7, 7, 4);
  addi(10, 10, 4);
  addi(5, 5, -1);
  bne(5, 11, 'copy');

  movi(6, 0); // 64 things change, each by the luck of a random number
  movi(10, ENTS);
  label('thing');
  movi(9, 25173);
  mul(13, 13, 9);
  addi(13, 13, 13849);
  shri(9, 13, 8);
  shli(0, 6, 2);
  ldw(1, 10, 0);
  andi(2, 9, 1);
  bne(2, 11, 'odd');
  andi(2, 9, 2);
  bne(2, 11, 'two');
  shri(2, 1, 1);
  shli(3, 1, 31);
  orr(1, 2, 3);
  bne(10, 11, 'kept'); // r10 is never 0: always taken
  label('odd');
  andi(2, 9, 0xff);
  add(1, 1, 2);
  bne(10, 11, 'kept');
  label('two');
  shli(2, 9, 3);
  xor(1, 1, 2);
  label('kept');
  stw(1, 10, 0);
  addi(6, 6, 1);
  movi(9, 64);
  bne(6, 9, 'thing');

  movi(5, 4096); // a hash over bytes of the screen
  movi(7, FB >> 16);
  shli(7, 7, 16);
  movi(2, 0);
  movi(3, 0x0100);
  shli(3, 3, 16);
  addi(3, 3, 0x0193);
  label('hash');
  ldb(0, 7, 11);
  xor(2, 2, 0);
  mul(2, 2, 3);
  addi(7, 7, 7);
  addi(5, 5, -1);
  bne(5, 11, 'hash');
  andi(0, 2, 63);
  shli(0, 0, 2);
  ldw(1, 10, 0);
  xor(1, 1, 2);
  stw(1, 10, 0);
  bne(10, 11, 'frame');

  for (const [at, target] of branches) code[at] |= ((labels[target] - (at + 1)) & 0xffff) << 16;
  return Int32Array.from(code);
}

const PROGRAM = guestProgram();

// Puts the interpreter's memory into its starting state: the program, the
// texture, the palettes, and nothing else.
export function seed(buffer) {
  const m8 = new Uint8Array(buffer);
  const m32 = new Int32Array(buffer);
  m8.fill(0);
  m32.set(PROGRAM, CODE >> 2);
  for (let i = 0; i < 64 * 64; i++) m8[RAM + TEX + i] = ((i ^ (i >> 6)) * 37) & 255;
  for (let light = 0; light < 8; light++) {
    for (let colour = 0; colour < 256; colour++) m32[((RAM + PAL) >> 2) + light * 256 + colour] = Math.imul(colour * (light + 1), 0x010101) ^ (light << 28);
  }
  for (let i = 0; i < 64; i++) m32[((RAM + ENTS) >> 2) + i] = Math.imul(i + 1, 0x9e3779b1);
}

// One number for the state the guest is in: the registers, the game state
// and a sample of the screen.
export function checksum(buffer) {
  const m32 = new Int32Array(buffer);
  let sum = 0x811c9dc5;
  const mix = (value) => { sum = Math.imul(sum ^ value, 0x01000193); };
  for (let i = REGS >> 2; i <= PC >> 2; i++) mix(m32[i]);
  for (let i = 0; i < 64; i++) mix(m32[((RAM + ENTS) >> 2) + i]);
  for (let i = 0; i < W * H; i += 97) mix(m32[((RAM + FB) >> 2) + i]);
  return sum >>> 0;
}

// What the guest's state must be after so many instructions from the start:
// an interpreter that gets anything else is not measured.
export const CHECK = { steps: 1000000, sum: 0x2927cddc };

// --- the interpreter in JavaScript --------------------------------------------

// Runs at most `steps` instructions and returns how many were left when the
// guest stopped (0 unless it met an operation that does not exist).
export function runJs(m32, m8, steps) {
  let pc = m32[PC >> 2];
  while (steps > 0) {
    steps--;
    const ins = m32[(CODE >> 2) + pc];
    pc++;
    const d = (ins >>> 8) & 15;
    const n = (ins >>> 12) & 15;
    const m = (ins >>> 16) & 15;
    switch (ins & 255) {
      case OP.movi: m32[d] = ins >>> 16; continue;
      case OP.add: m32[d] = m32[n] + m32[m]; continue;
      case OP.sub: m32[d] = m32[n] - m32[m]; continue;
      case OP.and: m32[d] = m32[n] & m32[m]; continue;
      case OP.xor: m32[d] = m32[n] ^ m32[m]; continue;
      case OP.orr: m32[d] = m32[n] | m32[m]; continue;
      case OP.mul: m32[d] = Math.imul(m32[n], m32[m]); continue;
      case OP.shli: m32[d] = m32[n] << (ins >>> 16); continue;
      case OP.shri: m32[d] = m32[n] >>> (ins >>> 16); continue;
      case OP.addi: m32[d] = m32[n] + (ins >> 16); continue;
      case OP.andi: m32[d] = m32[n] & (ins >>> 16); continue;
      case OP.ldb: m32[d] = m8[RAM + ((m32[n] + m32[m]) & 0xfffff)]; continue;
      case OP.ldw: m32[d] = m32[(RAM + ((m32[n] + m32[m]) & 0xffffc)) >> 2]; continue;
      case OP.stw: m32[(RAM + ((m32[n] + m32[m]) & 0xffffc)) >> 2] = m32[d]; continue;
      case OP.bne: if (m32[d] !== m32[n]) pc += ins >> 16; continue;
      case OP.blt: if (m32[d] < m32[n]) pc += ins >> 16; continue;
      default:
    }
    break;
  }
  m32[PC >> 2] = pc;
  return steps;
}

// --- the interpreter in WebAssembly -------------------------------------------

// Numbers as WebAssembly writes them (LEB128), unsigned and signed.
function unsigned(value) {
  const out = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    out.push(value ? byte | 0x80 : byte);
  } while (value);
  return out;
}

function signed(value) {
  const out = [];
  for (;;) {
    const byte = value & 0x7f;
    value >>= 7;
    if ((value === 0 && !(byte & 0x40)) || (value === -1 && (byte & 0x40))) return [...out, byte];
    out.push(byte | 0x80);
  }
}

// The module, as its bytes. It has a memory of PAGES pages ("memory") and
// one function, "run": the same as runJs above, on that memory.
//
//   run(steps):
//     pc = memory[PC]
//     loop: stop when steps is 0; steps--; ins = code[pc]; pc++
//           jump on the low byte of ins to one of 16 pieces of code, each of
//           which ends by going round the loop again; anything else stops
//     memory[PC] = pc; return steps
export function buildModule() {
  // Instructions of WebAssembly, by their bytes.
  const I = {
    block: [0x02, 0x40], loop: [0x03, 0x40], end: 0x0b, br: 0x0c, brIf: 0x0d, brTable: 0x0e,
    eqz: 0x45, eq: 0x46, geS: 0x4e, add: 0x6a, sub: 0x6b, mul: 0x6c, and: 0x71, or: 0x72, xor: 0x73, shl: 0x74, shrS: 0x75, shrU: 0x76,
  };
  const STEPS = 0; // the function's parameter and its two variables
  const PCV = 1;
  const INS = 2;
  const get = (variable) => [0x20, variable];
  const set = (variable) => [0x21, variable];
  const number = (value) => [0x41, ...signed(value)];
  const load = (offset) => [0x28, 2, ...unsigned(offset)]; // a word; the address is on the stack
  const loadByte = (offset) => [0x2d, 0, ...unsigned(offset)];
  const store = (offset) => [0x36, 2, ...unsigned(offset)]; // address and word are on the stack

  // A register's address: its number is 4 bits of the instruction, `shift`
  // bits up; shifted two less it is the number times four.
  const D = 6;
  const N = 10;
  const M = 14;
  const where = (shift) => [...get(INS), ...number(shift), I.shrU, ...number(0x3c), I.and];
  const register = (shift) => [...where(shift), ...load(REGS)];
  const immediate = [...get(INS), ...number(16), I.shrU];
  const immediateSigned = [...get(INS), ...number(16), I.shrS];
  const three = (op) => [...where(D), ...register(N), ...register(M), op, ...store(REGS)];
  const withNumber = (op, value = immediate) => [...where(D), ...register(N), ...value, op, ...store(REGS)];
  const address = (mask) => [...register(N), ...register(M), I.add, ...number(mask), I.and];
  // A branch: go round the loop when the condition does not hold, else move pc first.
  const branch = (unless) => (round) => [...register(D), ...register(N), unless, I.brIf, round, ...get(PCV), ...immediateSigned, I.add, ...set(PCV)];

  // The code of each operation, in the order of OP.
  const operations = [
    [...where(D), ...immediate, ...store(REGS)],
    three(I.add), three(I.sub), three(I.and), three(I.xor), three(I.or), three(I.mul),
    withNumber(I.shl), withNumber(I.shrU), withNumber(I.add, immediateSigned), withNumber(I.and),
    [...where(D), ...address(0xfffff), ...loadByte(RAM), ...store(REGS)],
    [...where(D), ...address(0xffffc), ...load(RAM), ...store(REGS)],
    [...address(0xffffc), ...register(D), ...store(RAM)],
    branch(I.eq), branch(I.geS),
  ];
  const count = operations.length;

  // A jump table leaves one of count + 1 nested blocks; the code after the
  // end of block i is operation i, and after the outermost is "stop". From
  // operation i the loop is count - i blocks out.
  const body = [
    1, 2, 0x7f, // two variables, 32-bit integers
    ...number(PC), ...load(0), ...set(PCV),
    ...I.block,
    ...I.loop,
    ...get(STEPS), I.eqz, I.brIf, 1,
    ...get(STEPS), ...number(1), I.sub, ...set(STEPS),
    ...get(PCV), ...number(2), I.shl, ...load(CODE), ...set(INS),
    ...get(PCV), ...number(1), I.add, ...set(PCV),
    ...Array.from({ length: count + 1 }, () => I.block).flat(),
    ...get(INS), ...number(255), I.and,
    I.brTable, count, ...Array.from({ length: count }, (_, i) => i), count,
    ...operations.flatMap((code, i) => [I.end, ...(typeof code === 'function' ? code(count - i) : code), I.br, count - i]),
    I.end,
    I.br, 1, // not an operation: leave the loop
    I.end,
    I.end,
    ...number(PC), ...get(PCV), ...store(0),
    ...get(STEPS),
    I.end,
  ];

  const section = (id, content) => [id, ...unsigned(content.length), ...content];
  const name = (text) => [text.length, ...Array.from(text, (letter) => letter.charCodeAt(0))];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]), // one kind of function: a number in, a number out
    ...section(3, [1, 0]), // one function, of that kind
    ...section(5, [1, 0, PAGES]), // one memory
    ...section(7, [2, ...name('memory'), 2, 0, ...name('run'), 0, 0]), // what is exported
    ...section(10, [1, ...unsigned(body.length), ...body]), // the function's code
  ]);
}

// --- measuring ------------------------------------------------------------------

// An engine is { name, buffer(), run(steps) }.
export function jsEngine() {
  const buffer = new ArrayBuffer(PAGES * 65536);
  const m32 = new Int32Array(buffer);
  const m8 = new Uint8Array(buffer);
  return { name: 'js', buffer: () => buffer, run: (steps) => runJs(m32, m8, steps) };
}

export function wasmEngine() {
  const instance = new WebAssembly.Instance(new WebAssembly.Module(buildModule()));
  return { name: 'wasm', buffer: () => instance.exports.memory.buffer, run: instance.exports.run };
}

// Whether the engine computes what the guest program must.
export function verify(engine) {
  seed(engine.buffer());
  engine.run(CHECK.steps);
  return checksum(engine.buffer()) === CHECK.sum;
}

// The WebAssembly engine where it can be made and is right, else the
// JavaScript one, else null. With `only` 'js', the JavaScript one or null.
export function pickEngine(only) {
  for (const make of only === 'js' ? [jsEngine] : [wasmEngine, jsEngine]) {
    try {
      const engine = make();
      if (verify(engine)) return engine;
    } catch (error) {
      // The next one.
    }
  }
  return null;
}

const SLICE_MS = 50;
// A slice is at least ten of the guest's frames: the parts of a frame run at
// different speeds, and a slice of less than a few frames can be one fast
// part (a slice of a tenth of a frame reads up to a third too fast).
const SLICE_STEPS = 8000000;

// The smallest step this clock makes, in milliseconds, or Infinity when it
// did not move while it was watched (a clock of 100 ms, as a browser gives
// that hides the device from fingerprinting).
export function clockGrain(now = () => performance.now()) {
  let grain = Infinity;
  let last = now();
  for (let i = 0, steps = 0; i < 200000 && steps < 5; i++) {
    const clock = now();
    if (clock === last) continue;
    grain = Math.min(grain, clock - last);
    last = clock;
    steps++;
  }
  return grain;
}

// Runs the guest for about `ms` milliseconds, in slices of about 50 (longer
// on a slow device: see SLICE_STEPS), after a warm-up. Returns
//   mips      million guest instructions a second over the whole time: what
//             the device kept up
//   bestMips  the same in the fastest slice: what it can do when nothing
//             else holds it back
//   slices, ms  how many slices were timed, and how long it took.
// The whole-time number does not need a fine clock. A slice is timed only
// when it is long beside the clock's step (`grain`), so that a coarse clock
// cannot make a slice look faster than it was; with no such slice the best
// is the whole-time number.
export function measure(engine, ms, now = () => performance.now(), grain = clockGrain(now)) {
  seed(engine.buffer());
  let steps = 200000;
  const warmFrom = now();
  let warmed = 0;
  let clock = warmFrom;
  do {
    engine.run(steps);
    warmed += steps;
    clock = now();
  } while (clock - warmFrom < Math.min(300, ms / 4));
  const sliceSteps = (perMs) => Math.max(SLICE_STEPS, Math.round(perMs * SLICE_MS));
  steps = sliceSteps(warmed / (clock - warmFrom));

  const timeable = Math.max(SLICE_MS / 10, grain * 50);
  let total = 0;
  let best = 0;
  let slices = 0;
  const from = now();
  let before = from;
  let after = from;
  do {
    engine.run(steps);
    after = now();
    total += steps;
    if (after - before >= timeable) {
      slices++;
      best = Math.max(best, steps / (after - before));
    }
    before = after;
    // The warm-up ran slower than what follows it: keep the slices at their length.
    if (after - from >= 2 * SLICE_MS) steps = sliceSteps(total / (after - from));
  } while (after - from < ms);
  const rate = total / (after - from); // instructions a millisecond
  const round = (perMs) => Math.round(perMs * 10) / 10000;
  return { mips: round(rate), bestMips: round(Math.max(best, rate)), slices, ms: Math.round(after - from) };
}

if (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
  globalThis.onmessage = (event) => {
    if (!event.data || event.data.cmd !== 'run') return;
    try {
      const engine = pickEngine(event.data.engine);
      if (!engine) throw new Error('the test program did not compute what it should');
      globalThis.postMessage({ ok: true, engine: engine.name, ...measure(engine, event.data.ms > 0 ? event.data.ms : 2000) });
    } catch (error) {
      globalThis.postMessage({ ok: false, error: String(error && error.message ? error.message : error) });
    }
  };
}
