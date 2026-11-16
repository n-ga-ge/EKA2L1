// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page-side client for the EKA2L1 web build. Wraps the wasm module's control
// bridge (see src/emu/web/src/main.cpp) in promises; the endpoints are the ones
// documented in src/emu/control/README.md.

/* global createEka2l1 */

// Symbian scan codes the emulator expects (same table as GET /v1/keys).
export const KEYS = {
  up: 0x10, down: 0x11, left: 0x0e, right: 0x0f, ok: 0xa7,
  lsk: 0xa4, rsk: 0xa5, clear: 0x01, call: 0xb4, end: 0xb5, edit: 0x12,
  star: 0x2a, hash: 0x7f, applications: 0x94,
  0: 0x30, 1: 0x31, 2: 0x32, 3: 0x33, 4: 0x34, 5: 0x35, 6: 0x36, 7: 0x37, 8: 0x38, 9: 0x39,
};

// How much of a file goes to the emulator in one request.
const PIECE_BYTES = 4 * 1024 * 1024;

export class Eka2l1 {
  constructor() {
    this.module = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Set();
    this.audio = null;
    // Whether this build takes a file in pieces (see uploadFrom).
    this.pieces = false;
  }

  // Loads the wasm module and resolves once the emulator core is up.
  // `persist: false` keeps everything in memory (nothing survives a reload).
  async start({ canvas, baseUrl = './', onLog = null, persist = true } = {}) {
    let ready;
    const whenReady = new Promise((resolve) => { ready = resolve; });

    this.module = await createEka2l1({
      canvas,
      arguments: persist ? [] : ['--no-persist'],
      locateFile: (name) => baseUrl + name,
      print: (line) => (onLog ? onLog(line) : console.log(line)),
      printErr: (line) => (onLog ? onLog(line) : console.warn(line)),
      eka2l1OnResponse: (id, status, type, body) => {
        const waiter = this.pending.get(id);
        if (waiter) {
          this.pending.delete(id);
          waiter({ status, type, body });
        }
      },
      eka2l1OnEvent: (name) => {
        if (name === 'ready') ready();
        // "boot:<step>" events mark the emulator's start-up for performance
        // tools. A build that sends them also accepts a file in pieces.
        if (name.startsWith('boot:')) this.pieces = true;
        if (name.startsWith('boot:') || name === 'ready') performance.mark(`eka2l1:${name}`);
        for (const listener of this.listeners) listener(name);
      },
    });

    await whenReady;
    return this;
  }

  onEvent(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Sends one control API request. `body` may be an object (sent as JSON), a
  // string, an ArrayBuffer or a typed array. Resolves to { status, type, body }
  // with helpers json() and text().
  request(method, target, body = null) {
    const m = this.module;
    let bytes = null;
    if (body instanceof Uint8Array) bytes = body;
    else if (body instanceof ArrayBuffer) bytes = new Uint8Array(body);
    else if (typeof body === 'string') bytes = new TextEncoder().encode(body);
    else if (body !== null && body !== undefined) bytes = new TextEncoder().encode(JSON.stringify(body));

    const cstr = (text) => {
      const size = m.lengthBytesUTF8(text) + 1;
      const ptr = m._malloc(size);
      m.stringToUTF8(text, ptr, size);
      return ptr;
    };

    const id = this.nextId++;
    const methodPtr = cstr(method);
    const targetPtr = cstr(target);
    let bodyPtr = 0;
    if (bytes && bytes.length) {
      bodyPtr = m._malloc(bytes.length);
      new Uint8Array(m.wasmMemory.buffer, bodyPtr, bytes.length).set(bytes);
    }

    const result = new Promise((resolve) => {
      this.pending.set(id, (res) => {
        res.text = () => new TextDecoder().decode(res.body);
        res.json = () => JSON.parse(res.text());
        res.ok = res.status >= 200 && res.status < 300;
        resolve(res);
      });
    });

    // The bridge copies everything before returning.
    m._eka2l1_web_request(id, methodPtr, targetPtr, bodyPtr, bytes ? bytes.length : 0);
    m._free(methodPtr);
    m._free(targetPtr);
    if (bodyPtr) m._free(bodyPtr);

    return result;
  }

  // Like request(), but throws on a non-2xx status and returns parsed JSON.
  async call(method, target, body = null) {
    const res = await this.request(method, target, body);
    if (!res.ok) {
      throw new Error(`${method} ${target} failed (${res.status}): ${res.text()}`);
    }
    return res.type.startsWith('application/json') ? res.json() : res;
  }

  // Stores bytes in the emulator's filesystem and returns the path to hand to
  // install requests.
  async upload(name, bytes) {
    const stored = await this.call('PUT', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`, bytes);
    return stored.hostPath;
  }

  // Like upload(), for a file that is not in memory: `source` is
  // { bytes, open() } where open() resolves to a stream of the file and
  // `bytes` is its size when known (0 otherwise). The stream goes to the
  // emulator a few megabytes at a time, so neither the page nor the emulator
  // ever holds a second copy of the whole file. `onProgress(sent)` is called
  // after each piece.
  async uploadFrom(name, source, onProgress = null) {
    const stream = await source.open();

    if (!this.pieces) {
      // A build from before piecewise uploads: hand the file over whole.
      return this.upload(name, new Uint8Array(await new Response(stream).arrayBuffer()));
    }

    const target = `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`;
    const piece = new Uint8Array(PIECE_BYTES);
    let filled = 0;
    let offset = 0;
    let hostPath = null;

    const flush = async () => {
      // The size, sent with the first piece, lets the emulator allocate the
      // file once instead of growing it.
      const size = offset === 0 && source.bytes ? `&size=${source.bytes}` : '';
      const stored = await this.call('PUT', `${target}&offset=${offset}${size}`, piece.subarray(0, filled));
      hostPath = stored.hostPath;
      offset += filled;
      filled = 0;
      if (onProgress) onProgress(offset);
    };

    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (let at = 0; at < value.length;) {
        const take = Math.min(PIECE_BYTES - filled, value.length - at);
        piece.set(value.subarray(at, at + take), filled);
        filled += take;
        at += take;
        if (filled === PIECE_BYTES) await flush();
      }
    }
    if (filled || offset === 0) await flush();
    performance.mark(`eka2l1:uploaded:${name}`);
    return hostPath;
  }

  key(scancode, down) {
    this.module._eka2l1_web_key(scancode, down ? 1 : 0);
  }

  // Writes the phone's memory (the saves) to persistent storage now. Resolves once a
  // storage pass that began after this call has finished, so everything
  // written before it is safe; resolves at once when persistence is off.
  save() {
    return new Promise((resolve) => {
      const ticket = this.module._eka2l1_web_save();
      if (!ticket) { resolve(false); return; }
      const done = (stored) => { off(); clearTimeout(timer); resolve(stored); };
      const off = this.onEvent((name) => {
        if (name.startsWith('saved:') && Number(name.slice(6)) >= ticket) done(true);
      });
      const timer = setTimeout(() => done(false), 60000);
    });
  }

  frames() {
    return this.module._eka2l1_web_frames();
  }

  // Counters for performance readouts: frames presented, time the graphics
  // thread spent drawing, and the size of the wasm heap.
  stats() {
    return {
      frames: this.module._eka2l1_web_frames(),
      graphicsBusyMs: this.module._eka2l1_web_graphics_busy_us() / 1000,
      heapMB: this.module.wasmMemory.buffer.byteLength / 1048576,
      heapUsedMB: this.module._eka2l1_web_heap_used() / 1048576,
    };
  }

  pause() { return this.call('POST', '/v1/emulator/pause'); }
  resume() { return this.call('POST', '/v1/emulator/resume'); }

  setMuted(muted) {
    if (!this.audio) return;
    if (muted) this.audio.suspend(); else this.audio.resume();
  }

  // Starts audio output. Must run inside a user gesture (click or key press),
  // otherwise the browser keeps the AudioContext suspended.
  async enableAudio(baseUrl = './') {
    if (this.audio) {
      await this.audio.resume();
      return;
    }

    const ring = this.module._eka2l1_web_audio_ring();
    if (!ring) return;

    const context = new AudioContext({ latencyHint: 'interactive' });
    this.module._eka2l1_web_audio_set_rate(context.sampleRate);
    await context.audioWorklet.addModule(baseUrl + 'audio-worklet.js');

    const node = new AudioWorkletNode(context, 'eka2l1-ring', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { memory: this.module.wasmMemory, ring },
    });
    node.connect(context.destination);

    this.audio = context;
    await context.resume();
  }
}
