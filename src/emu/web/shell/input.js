// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Input for the EKA2L1 web page: keyboard, on-screen touch controls and
// gamepads all feed one key state, so a key held by two sources at once is
// only released when both let go. Which host input presses which N-Gage key
// comes from a bindings table (see games.js) that can be replaced at any time.

import { KEYS } from './eka2l1-client.js';

const STICK_THRESHOLD = 0.5;
const PAD_POLL_MS = 8;

// Keeps a touch bound to the control it started on. Capture can be refused
// (the pointer may already be gone), which only costs the binding.
function capture(element, pointerId) {
  try { element.setPointerCapture(pointerId); } catch { /* not capturable */ }
}

// Is this gamepad input ("b3", "a0-", "a2+") active on the pad?
function padInputActive(pad, input) {
  if (input[0] === 'b') {
    const button = pad.buttons[Number(input.slice(1))];
    return Boolean(button && (button.pressed || button.value > 0.5));
  }
  const value = pad.axes[Number(input.slice(1, -1))] || 0;
  return input.endsWith('-') ? value < -STICK_THRESHOLD : value > STICK_THRESHOLD;
}

export class Input {
  // `send(scancode, down)` delivers a key transition to the emulator.
  constructor(send) {
    this.send = send;
    this.holders = new Map(); // scancode -> Set of source ids
    this.keyboard = new Map(); // KeyboardEvent.code -> [N-Gage key ids]
    this.gamepad = []; // [{ input, key }]
    this.padHeld = new Map(); // gamepad index -> Set of N-Gage key ids
    this.padCount = 0;
    this.onGamepadChange = null;
    this.capturing = null; // { kind, resolve } while a binding is being recorded
    this.sent = 0;
  }

  // bindings: { keyboard: { ngageKey: [codes] }, gamepad: { ngageKey: [inputs] } }
  setBindings(bindings) {
    this.releaseAll();
    this.keyboard = new Map();
    for (const [key, codes] of Object.entries(bindings.keyboard || {})) {
      for (const code of codes) {
        if (!this.keyboard.has(code)) this.keyboard.set(code, []);
        this.keyboard.get(code).push(key);
      }
    }
    this.gamepad = [];
    for (const [key, inputs] of Object.entries(bindings.gamepad || {})) {
      for (const input of inputs) this.gamepad.push({ input, key });
    }
    this.padHeld = new Map();
  }

  press(source, key) {
    const scancode = KEYS[key];
    if (scancode === undefined) return;
    let sources = this.holders.get(scancode);
    if (!sources) {
      sources = new Set();
      this.holders.set(scancode, sources);
    }
    const first = sources.size === 0;
    sources.add(source);
    if (first) {
      this.sent++;
      this.send(scancode, true);
    }
  }

  release(source, key) {
    const scancode = KEYS[key];
    const sources = this.holders.get(scancode);
    if (!sources || !sources.delete(source)) return;
    if (sources.size === 0) {
      this.sent++;
      this.send(scancode, false);
    }
  }

  releaseAll() {
    for (const [scancode, sources] of this.holders) {
      if (sources.size) this.send(scancode, false);
      sources.clear();
    }
    this.padHeld = new Map();
  }

  // Resolves with the next keyboard code ('keyboard') or gamepad input
  // ('gamepad') the user produces, or null if cancelled with Escape or by
  // calling cancelCapture(). Nothing reaches the emulator meanwhile.
  captureNext(kind) {
    this.cancelCapture();
    this.releaseAll();
    return new Promise((resolve) => { this.capturing = { kind, resolve, baseline: null }; });
  }

  cancelCapture() {
    if (this.capturing) {
      const { resolve } = this.capturing;
      this.capturing = null;
      resolve(null);
    }
  }

  // --- keyboard -----------------------------------------------------------

  attachKeyboard(target = window) {
    const onKey = (down) => (event) => {
      if (this.capturing) {
        if (!down) return;
        event.preventDefault();
        event.stopPropagation();
        const capturing = this.capturing;
        if (event.code === 'Escape' || capturing.kind === 'keyboard') {
          this.capturing = null;
          capturing.resolve(event.code === 'Escape' && capturing.kind !== 'keyboard' ? null : event.code);
        }
        return;
      }

      const keys = this.keyboard.get(event.code);
      if (!keys || event.ctrlKey || event.metaKey || event.altKey) return;
      const element = event.target;
      if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) return;
      if (document.querySelector('dialog[open]')) return; // typing in a dialog is not for the game
      event.preventDefault();
      for (const key of keys) {
        if (down) this.press('keyboard:' + event.code, key);
        else this.release('keyboard:' + event.code, key);
      }
    };

    target.addEventListener('keydown', onKey(true), true);
    target.addEventListener('keyup', onKey(false), true);
    // Keys released while the page is not focused never produce a keyup.
    window.addEventListener('blur', () => {
      for (const [code, keys] of this.keyboard) {
        for (const key of keys) this.release('keyboard:' + code, key);
      }
    });
  }

  // --- touch --------------------------------------------------------------

  // Buttons: any element with data-key="<N-Gage key id>".
  attachButtons(root) {
    for (const element of root.querySelectorAll('[data-key]')) {
      const key = element.dataset.key;
      if (KEYS[key] === undefined) continue;
      const source = 'touch:' + key;

      const down = (event) => {
        event.preventDefault();
        capture(element, event.pointerId);
        element.classList.add('held');
        this.press(source, key);
      };
      const up = (event) => {
        event.preventDefault();
        element.classList.remove('held');
        this.release(source, key);
      };

      element.addEventListener('pointerdown', down);
      element.addEventListener('pointerup', up);
      element.addEventListener('pointercancel', up);
      element.addEventListener('lostpointercapture', up);
      element.addEventListener('contextmenu', (event) => event.preventDefault());
    }
  }

  // Direction pad: one element; the touch position relative to its centre
  // picks up to two directions, so diagonals and sliding between them work.
  attachDpad(element) {
    const directions = ['up', 'down', 'left', 'right'];
    let active = null;

    const update = (event) => {
      const box = element.getBoundingClientRect();
      const x = (event.clientX - box.left) / box.width - 0.5;
      const y = (event.clientY - box.top) / box.height - 0.5;
      const dead = 0.12;
      const want = new Set();

      if (Math.hypot(x, y) > dead) {
        // Eight sectors: within 67.5 degrees of an axis counts for that axis.
        const angle = Math.atan2(y, x);
        const near = (target) => Math.abs(Math.atan2(Math.sin(angle - target), Math.cos(angle - target))) < (3 * Math.PI) / 8;
        if (near(0)) want.add('right');
        if (near(Math.PI)) want.add('left');
        if (near(-Math.PI / 2)) want.add('up');
        if (near(Math.PI / 2)) want.add('down');
      }

      for (const name of directions) {
        if (want.has(name)) this.press('dpad', name);
        else this.release('dpad', name);
        element.classList.toggle('held-' + name, want.has(name));
      }
    };

    const end = (event) => {
      if (active !== event.pointerId) return;
      active = null;
      for (const name of directions) {
        this.release('dpad', name);
        element.classList.remove('held-' + name);
      }
    };

    element.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      active = event.pointerId;
      capture(element, event.pointerId);
      update(event);
    });
    element.addEventListener('pointermove', (event) => {
      if (active === event.pointerId) update(event);
    });
    element.addEventListener('pointerup', end);
    element.addEventListener('pointercancel', end);
    element.addEventListener('lostpointercapture', end);
    element.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  // --- gamepads -----------------------------------------------------------

  attachGamepads() {
    if (typeof navigator.getGamepads !== 'function') return;

    const allInputs = [];
    for (let button = 0; button < 17; button++) allInputs.push('b' + button);
    for (let axis = 0; axis < 4; axis++) allInputs.push(`a${axis}-`, `a${axis}+`);

    const poll = () => {
      const pads = navigator.getGamepads();
      let connected = 0;

      for (let index = 0; index < pads.length; index++) {
        const pad = pads[index];
        const live = Boolean(pad && pad.connected);
        if (live) connected++;

        if (this.capturing) {
          // Record the first input that becomes active after capture began.
          if (live && this.capturing.kind === 'gamepad') {
            const active = allInputs.filter((input) => padInputActive(pad, input));
            const capturing = this.capturing;
            if (capturing.baseline === null) {
              capturing.baseline = new Set(active);
            } else {
              const fresh = active.find((input) => !capturing.baseline.has(input));
              capturing.baseline = new Set(active);
              if (fresh) {
                this.capturing = null;
                capturing.resolve(fresh);
              }
            }
          }
          continue;
        }

        const source = 'gamepad:' + index;
        const want = new Set();
        if (live) {
          for (const { input, key } of this.gamepad) {
            if (padInputActive(pad, input)) want.add(key);
          }
        }

        const held = this.padHeld.get(index) || new Set();
        for (const key of want) if (!held.has(key)) this.press(source, key);
        for (const key of held) if (!want.has(key)) this.release(source, key);
        this.padHeld.set(index, want);
      }

      if (connected !== this.padCount) {
        this.padCount = connected;
        if (this.onGamepadChange) this.onGamepadChange(connected);
      }
    };

    // A timer rather than requestAnimationFrame: input must keep flowing at a
    // steady rate regardless of how often the page repaints.
    setInterval(poll, PAD_POLL_MS);
    window.addEventListener('gamepadconnected', poll);
    window.addEventListener('gamepaddisconnected', poll);
  }
}
