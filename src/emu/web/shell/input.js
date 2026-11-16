// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Input for the EKA2L1 web page: keyboard, on-screen touch controls and
// gamepads all feed one key state, so a key held by two sources at once is
// only released when both let go.

import { KEYS } from './eka2l1-client.js';

// Keyboard to N-Gage keys.
export const KEYMAP = {
  ArrowUp: KEYS.up, ArrowDown: KEYS.down, ArrowLeft: KEYS.left, ArrowRight: KEYS.right,
  Enter: KEYS.ok, Space: KEYS.ok, KeyQ: KEYS.lsk, KeyW: KEYS.rsk, Backspace: KEYS.clear,
  Minus: KEYS.star, Equal: KEYS.hash, KeyC: KEYS.call, KeyE: KEYS.end,
  Digit0: KEYS[0], Digit1: KEYS[1], Digit2: KEYS[2], Digit3: KEYS[3], Digit4: KEYS[4],
  Digit5: KEYS[5], Digit6: KEYS[6], Digit7: KEYS[7], Digit8: KEYS[8], Digit9: KEYS[9],
  Numpad0: KEYS[0], Numpad1: KEYS[1], Numpad2: KEYS[2], Numpad3: KEYS[3], Numpad4: KEYS[4],
  Numpad5: KEYS[5], Numpad6: KEYS[6], Numpad7: KEYS[7], Numpad8: KEYS[8], Numpad9: KEYS[9],
};

// Standard-mapping gamepad buttons to N-Gage keys. The N-Gage's two game keys
// are 5 and 7; the face buttons cover those plus OK and clear.
export const PADMAP = {
  0: KEYS.ok, 1: KEYS.clear, 2: KEYS[5], 3: KEYS[7],
  4: KEYS.lsk, 5: KEYS.rsk, 6: KEYS.star, 7: KEYS.hash,
  8: KEYS.rsk, 9: KEYS.lsk,
  12: KEYS.up, 13: KEYS.down, 14: KEYS.left, 15: KEYS.right,
};

const STICK_THRESHOLD = 0.5;

// Keeps a touch bound to the control it started on. Capture can be refused
// (the pointer may already be gone), which only costs the binding.
function capture(element, pointerId) {
  try { element.setPointerCapture(pointerId); } catch { /* not capturable */ }
}

export class Input {
  // `send(scancode, down)` delivers a key transition to the emulator.
  constructor(send) {
    this.send = send;
    this.holders = new Map(); // scancode -> Set of source ids
    this.padHeld = new Map(); // gamepad index -> Set of scancodes
    this.padTimer = 0;
    this.onGamepadChange = null;
    this.sent = 0;
  }

  press(source, scancode) {
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

  release(source, scancode) {
    const sources = this.holders.get(scancode);
    if (!sources || !sources.delete(source)) return;
    if (sources.size === 0) {
      this.sent++;
      this.send(scancode, false);
    }
  }

  releaseSource(source) {
    for (const scancode of Array.from(this.holders.keys())) this.release(source, scancode);
  }

  releaseAll() {
    for (const [scancode, sources] of this.holders) {
      if (sources.size) this.send(scancode, false);
      sources.clear();
    }
  }

  // --- keyboard -----------------------------------------------------------

  attachKeyboard(target = window) {
    const onKey = (down) => (event) => {
      const scancode = KEYMAP[event.code];
      if (scancode === undefined || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      if (down) this.press('keyboard:' + event.code, scancode);
      else this.release('keyboard:' + event.code, scancode);
    };

    target.addEventListener('keydown', onKey(true));
    target.addEventListener('keyup', onKey(false));
    // Keys released while the page is not focused never produce a keyup.
    window.addEventListener('blur', () => {
      for (const code of Object.keys(KEYMAP)) this.release('keyboard:' + code, KEYMAP[code]);
    });
  }

  // --- touch --------------------------------------------------------------

  // Buttons: any element with data-key="<name in KEYS>".
  attachButtons(root) {
    for (const element of root.querySelectorAll('[data-key]')) {
      const scancode = KEYS[element.dataset.key];
      if (scancode === undefined) continue;
      const source = 'touch:' + element.dataset.key;

      const down = (event) => {
        event.preventDefault();
        capture(element, event.pointerId);
        element.classList.add('held');
        this.press(source, scancode);
      };
      const up = (event) => {
        event.preventDefault();
        element.classList.remove('held');
        this.release(source, scancode);
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
    const directions = { up: KEYS.up, down: KEYS.down, left: KEYS.left, right: KEYS.right };
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

      for (const name of Object.keys(directions)) {
        if (want.has(name)) this.press('dpad', directions[name]);
        else this.release('dpad', directions[name]);
        element.classList.toggle('held-' + name, want.has(name));
      }
    };

    const end = (event) => {
      if (active !== event.pointerId) return;
      active = null;
      for (const name of Object.keys(directions)) {
        this.release('dpad', directions[name]);
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

    const poll = () => {
      const pads = navigator.getGamepads();
      let connected = 0;

      for (let index = 0; index < pads.length; index++) {
        const pad = pads[index];
        const source = 'gamepad:' + index;
        const want = new Set();

        if (pad && pad.connected) {
          connected++;
          for (const [button, scancode] of Object.entries(PADMAP)) {
            const state = pad.buttons[button];
            if (state && (state.pressed || state.value > 0.5)) want.add(scancode);
          }
          const [x = 0, y = 0] = pad.axes;
          if (x < -STICK_THRESHOLD) want.add(KEYS.left);
          if (x > STICK_THRESHOLD) want.add(KEYS.right);
          if (y < -STICK_THRESHOLD) want.add(KEYS.up);
          if (y > STICK_THRESHOLD) want.add(KEYS.down);
        }

        const held = this.padHeld.get(index) || new Set();
        for (const scancode of want) if (!held.has(scancode)) this.press(source, scancode);
        for (const scancode of held) if (!want.has(scancode)) this.release(source, scancode);
        this.padHeld.set(index, want);
      }

      if (this.onGamepadChange && connected !== this.padCount) {
        this.padCount = connected;
        this.onGamepadChange(connected);
      }
    };

    // A timer rather than requestAnimationFrame: input must keep flowing at a
    // steady rate regardless of how often the page repaints.
    this.padCount = 0;
    this.padTimer = setInterval(poll, 8);
    window.addEventListener('gamepadconnected', poll);
    window.addEventListener('gamepaddisconnected', poll);
  }
}
