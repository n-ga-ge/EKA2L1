// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Plays the emulator's mixed audio. The mixer thread inside the wasm module
// writes interleaved stereo float frames into a ring that lives in the shared
// wasm memory (struct web_audio_ring in drivers/audio/backend/web/audio_web.h);
// this processor is its only reader.

// Field offsets of web_audio_ring on wasm32, in 32-bit words.
const READ_POS = 0;
const WRITE_POS = 1;
const CAPACITY = 2;
const ATTACHED = 4;
const DATA = 5;
// For the diagnostics (GET /v1/web/diag, "audio"). The mixer sets SOUNDING
// while what it mixes is not silence; the rest is counted here. Only a build
// with diagnostics has these words, and says so in LAYOUT: its upper half is
// a mark, its lower the number of times fields were appended. An older build
// has a pointer there, which never has that value.
const LAYOUT = 6;
const SOUNDING = 7;
const BLOCKS = 8;
const UNDERRUNS = 9;
const UNDERRUN_FRAMES = 10;
const GAPS = 11;
const LAYOUT_MARK = 0xe2a1;

class Eka2l1RingProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.memory = options.processorOptions.memory;
    this.ring = options.processorOptions.ring >>> 2;
    this.buffer = null;
    this.primed = false; // the ring has had a full block for us once
    this.inGap = false; // the block before this one was an underrun
    this.refresh();
    const layout = this.words[this.ring + LAYOUT];
    this.counts = (layout >>> 16) === LAYOUT_MARK && (layout & 0xffff) >= 1;

    // Start from "now": drop whatever was queued before we attached.
    Atomics.store(this.words, this.ring + READ_POS, Atomics.load(this.words, this.ring + WRITE_POS));
    Atomics.store(this.words, this.ring + ATTACHED, 1);
  }

  // The memory can grow, which replaces its buffer object.
  refresh() {
    if (this.buffer !== this.memory.buffer) {
      this.buffer = this.memory.buffer;
      this.words = new Uint32Array(this.buffer);
      this.floats = new Float32Array(this.buffer);
    }
  }

  process(inputs, outputs) {
    this.refresh();

    const left = outputs[0][0];
    const right = outputs[0][1] || left;
    const words = this.words;

    const capacity = words[this.ring + CAPACITY];
    const mask = capacity - 1;
    const data = words[this.ring + DATA] >>> 2;

    const read = Atomics.load(words, this.ring + READ_POS);
    const write = Atomics.load(words, this.ring + WRITE_POS);
    const available = (write - read) >>> 0;
    const count = Math.min(available, left.length);

    for (let i = 0; i < count; i++) {
      const at = data + (((read + i) & mask) << 1);
      left[i] = this.floats[at];
      right[i] = this.floats[at + 1];
    }

    // Underrun: the rest of the block stays silent.
    for (let i = count; i < left.length; i++) {
      left[i] = 0;
      right[i] = 0;
    }

    // Count it when someone hears it: the mixer fills the ring with silence
    // too, so an empty ring is a gap in the sound only while the game makes
    // any. The ring is also empty until the mixer has noticed us, which is
    // no gap. Blocks in a row that come up short are one gap.
    if (this.counts) {
      const short = count < left.length && this.primed && Atomics.load(words, this.ring + SOUNDING) !== 0;
      if (short) {
        Atomics.add(words, this.ring + UNDERRUNS, 1);
        Atomics.add(words, this.ring + UNDERRUN_FRAMES, left.length - count);
        if (!this.inGap) Atomics.add(words, this.ring + GAPS, 1);
      }
      this.inGap = short;
      if (count === left.length) this.primed = true;
      Atomics.add(words, this.ring + BLOCKS, 1);
    }

    Atomics.store(words, this.ring + READ_POS, (read + count) >>> 0);
    return true;
  }
}

registerProcessor('eka2l1-ring', Eka2l1RingProcessor);
