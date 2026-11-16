// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Control profiles. A profile says which host inputs press which N-Gage keys:
//
//   keyboard: N-Gage key -> KeyboardEvent.code values
//   gamepad:  N-Gage key -> inputs on a standard-mapping pad, written
//             "b<index>" for a button and "a<index>-" / "a<index>+" for an
//             axis pushed towards negative / positive
//
// The standard profile mirrors the phone. A game profile adds what each N-Gage
// key does in that game (shown in the guide and on the touch keys) and a
// layout that suits it.

// Every key of the N-Gage, in the order the controls table lists them.
export const NGAGE_KEYS = [
  { id: 'up', label: 'Pad up' }, { id: 'down', label: 'Pad down' },
  { id: 'left', label: 'Pad left' }, { id: 'right', label: 'Pad right' },
  { id: 'ok', label: 'OK (pad press)' },
  { id: 'lsk', label: 'Left soft key' }, { id: 'rsk', label: 'Right soft key' },
  { id: '1', label: '1' }, { id: '2', label: '2' }, { id: '3', label: '3' },
  { id: '4', label: '4' }, { id: '5', label: '5' }, { id: '6', label: '6' },
  { id: '7', label: '7' }, { id: '8', label: '8' }, { id: '9', label: '9' },
  { id: 'star', label: '✱' }, { id: '0', label: '0' }, { id: 'hash', label: '#' },
  { id: 'clear', label: 'Clear (C)' },
];

const DIGIT_ROW = {
  1: ['Digit1', 'Numpad1'], 2: ['Digit2', 'Numpad2'], 3: ['Digit3', 'Numpad3'],
  4: ['Digit4', 'Numpad4'], 5: ['Digit5', 'Numpad5'], 6: ['Digit6', 'Numpad6'],
  7: ['Digit7', 'Numpad7'], 8: ['Digit8', 'Numpad8'], 9: ['Digit9', 'Numpad9'],
  0: ['Digit0', 'Numpad0'], star: ['Minus', 'NumpadMultiply'], hash: ['Equal', 'NumpadDivide'],
};

export const STANDARD_PROFILE = {
  id: 'ngage',
  name: 'N-Gage standard',
  actions: {},
  keyboard: {
    up: ['ArrowUp'], down: ['ArrowDown'], left: ['ArrowLeft'], right: ['ArrowRight'],
    ok: ['Enter', 'Space'], lsk: ['KeyQ'], rsk: ['KeyW'], clear: ['Backspace'],
    ...DIGIT_ROW,
  },
  gamepad: {
    up: ['b12', 'a1-'], down: ['b13', 'a1+'], left: ['b14', 'a0-'], right: ['b15', 'a0+'],
    ok: ['b0'], clear: ['b1'], 5: ['b2'], 7: ['b3'],
    lsk: ['b4', 'b9'], rsk: ['b5', 'b8'], star: ['b6'], hash: ['b7'],
  },
  notes: [
    'The N-Gage has a direction pad that also presses in (OK), two soft keys under the screen, and a phone keypad. Games use 5 and 7 as their main action keys.',
  ],
};

// Keyed by the game's UID as the emulator reports it.
export const GAME_PROFILES = {
  '0x101FD3F6': {
    id: 'shadowkey',
    name: 'The Elder Scrolls Travels: Shadowkey',
    // The game's own defaults, read from its Options > Customize Controls menu.
    actions: {
      up: 'Move forward', down: 'Move backward', left: 'Turn left', right: 'Turn right',
      ok: 'Select (menus)', rsk: 'Game menu (save, load, options)',
      1: 'Jump', 2: 'Look up', 3: 'Use', 4: 'Side step left', 5: 'Use right action', 6: 'Side step right',
      7: 'Use left action', 8: 'Look down', 9: 'Map', star: 'Cycle left queue', 0: 'Cycle right queue',
      hash: 'Character manager',
    },
    // First-person layout: move and strafe on WASD, turn on the arrows or Q/E.
    keyboard: {
      up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'],
      left: ['ArrowLeft', 'KeyQ'], right: ['ArrowRight', 'KeyE'],
      4: ['KeyA', 'Digit4', 'Numpad4'], 6: ['KeyD', 'Digit6', 'Numpad6'],
      2: ['KeyR', 'PageUp', 'Digit2', 'Numpad2'], 8: ['KeyV', 'PageDown', 'Digit8', 'Numpad8'],
      1: ['Space', 'Digit1', 'Numpad1'], 3: ['KeyF', 'Digit3', 'Numpad3'],
      7: ['KeyZ', 'Digit7', 'Numpad7'], 5: ['KeyX', 'Digit5', 'Numpad5'],
      9: ['KeyM', 'Digit9', 'Numpad9'], hash: ['Tab', 'Equal'],
      star: ['BracketLeft', 'Minus'], 0: ['BracketRight', 'Digit0', 'Numpad0'],
      ok: ['Enter'], rsk: ['Escape', 'Backspace'], lsk: ['Backquote'], clear: ['Delete'],
    },
    // Left stick moves and turns, right stick strafes and looks, triggers act.
    gamepad: {
      up: ['b12', 'a1-'], down: ['b13', 'a1+'], left: ['b14', 'a0-'], right: ['b15', 'a0+'],
      4: ['a2-'], 6: ['a2+'], 2: ['a3-'], 8: ['a3+'],
      ok: ['b0'], 1: ['b1'], 3: ['b2'], 9: ['b3'],
      star: ['b4'], 0: ['b5'], 7: ['b6'], 5: ['b7'],
      hash: ['b8'], rsk: ['b9'], lsk: ['b10'],
    },
    notes: [
      'Open the game menu with the right soft key. It has Save Game, Load Game and Options.',
      'The left and right actions use whatever is readied in each hand; the queue keys cycle what is readied.',
      'The game can also remap its own keys under Options > Customize Controls. That changes which N-Gage key an action uses, on top of the bindings here.',
    ],
  },
};

export function profileFor(uid) {
  return GAME_PROFILES[uid] || STANDARD_PROFILE;
}

// Human-readable names for bound inputs.
const CODE_NAMES = {
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Space: 'Space', Enter: 'Enter',
  Backspace: 'Backspace', Escape: 'Esc', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[',
  BracketRight: ']', PageUp: 'PgUp', PageDown: 'PgDn', Delete: 'Del', Tab: 'Tab',
  NumpadMultiply: 'Num *', NumpadDivide: 'Num /',
};

export function keyName(code) {
  if (CODE_NAMES[code]) return CODE_NAMES[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  return code;
}

const BUTTON_NAMES = ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Back', 'Start', 'L3', 'R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Home'];
const AXIS_NAMES = { 'a0-': 'L stick ←', 'a0+': 'L stick →', 'a1-': 'L stick ↑', 'a1+': 'L stick ↓',
  'a2-': 'R stick ←', 'a2+': 'R stick →', 'a3-': 'R stick ↑', 'a3+': 'R stick ↓' };

export function padName(input) {
  if (AXIS_NAMES[input]) return AXIS_NAMES[input];
  if (input[0] === 'b') return BUTTON_NAMES[Number(input.slice(1))] || 'Button ' + input.slice(1);
  return input;
}
