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
// layout that suits it. Game profiles come from the hosting site's catalogue
// (profileFromEntry); the ones written out here serve a page without one.

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
  return Object.hasOwn(GAME_PROFILES, uid) ? GAME_PROFILES[uid] : STANDARD_PROFILE;
}

// --- profiles from the site's catalogue ------------------------------------------
//
// A catalogue entry (see catalog.js) is JSON fetched from the hosting site.
// Nothing in it is taken on trust: only known N-Gage keys, inputs of the right
// shape and plain strings of a sane length get through, and everything else is
// dropped as if it had not been written.

const KEY_IDS = NGAGE_KEYS.map((key) => key.id);
const INPUT_SHAPE = {
  keyboard: /^[A-Z][A-Za-z0-9]{0,31}$/, // KeyboardEvent.code
  gamepad: /^(b\d{1,2}|a\d[+-])$/,
};
const MAX_INPUTS = 8; // per N-Gage key
const MAX_NOTES = 24;
// Longest text taken from an entry, in characters; anything longer is cut.
// The site's catalogue is checked against the same numbers before it is
// published, so in practice nothing is.
const LIMITS = { title: 80, action: 120, source: 500, note: 600, menu: 120, multiplayerNote: 400 };

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function text(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function textList(value, limit) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, limit)).filter(Boolean).slice(0, MAX_NOTES);
}

// One binding table. A map that is not there means the standard layout. In a
// map that is there, a key it leaves out keeps its standard inputs except
// those the map gives to another key: a layout that moves "walk" to W must not
// leave W pressing the right soft key as well.
function layout(given, device) {
  const standard = STANDARD_PROFILE[device];
  const table = {};
  const taken = new Set();

  if (isRecord(given)) {
    for (const id of KEY_IDS) {
      if (!Object.hasOwn(given, id) || !Array.isArray(given[id])) continue;
      const inputs = [...new Set(given[id].filter((input) => typeof input === 'string' && INPUT_SHAPE[device].test(input)))].slice(0, MAX_INPUTS);
      // An empty list unbinds the key on purpose. A list with nothing usable
      // in it is a mistake, and the key keeps its standard inputs.
      if (!inputs.length && given[id].length) continue;
      table[id] = inputs;
      for (const input of inputs) taken.add(input);
    }
  }

  for (const id of KEY_IDS) {
    if (!table[id]) table[id] = (standard[id] || []).filter((input) => !taken.has(input));
  }
  return table;
}

// The control profile a catalogue entry describes, or null when it has none
// (or none that can be used). Its id is the entry's slug, which is also what
// rebindings the user saved are filed under.
export function profileFromEntry(entry) {
  if (!isRecord(entry) || !isRecord(entry.controls)) return null;
  const id = typeof entry.slug === 'string' && /^[a-z0-9-]{1,64}$/.test(entry.slug) ? entry.slug : '';
  // "auto" and the standard profile's id mean something else in the settings.
  if (!id || id === 'auto' || id === STANDARD_PROFILE.id) return null;

  const { controls } = entry;
  const actions = {};
  if (isRecord(controls.actions)) {
    for (const key of KEY_IDS) {
      const action = Object.hasOwn(controls.actions, key) ? text(controls.actions[key], LIMITS.action) : '';
      if (action) actions[key] = action;
    }
  }
  // Nothing about the keys and no layout of its own: not a profile.
  if (!Object.keys(actions).length && !isRecord(controls.keyboard) && !isRecord(controls.gamepad)) return null;

  return {
    id,
    name: text(entry.title, LIMITS.title) || id,
    actions,
    keyboard: layout(controls.keyboard, 'keyboard'),
    gamepad: layout(controls.gamepad, 'gamepad'),
    notes: [...textList(controls.notes, LIMITS.note), ...textList(entry.notes, LIMITS.note)],
    source: text(controls.source, LIMITS.source),
  };
}

// How far a game gets, in words a player reads before wondering why something
// fails. `fallback` stands in when the entry has no note of its own; `tone` is
// the colour class the label is shown in.
const STATUS_WORDS = {
  untested: { label: 'Not tested yet', tone: 'warn', fallback: 'Nobody has checked how far this game gets here. It may not start, or it may stop part-way.' },
  broken: { label: 'Does not work', tone: 'bad', fallback: 'It does not start, or it crashes.' },
  boots: { label: 'Starts only', tone: 'warn', fallback: 'It shows its own screens but does not reach a working main menu.' },
  menu: { label: 'Menus only', tone: 'warn', fallback: 'Its main menu works; the game itself does not yet.' },
  ingame: { label: 'Playable', tone: 'ok', fallback: '' },
};

// How far a game's Bluetooth multiplayer gets on this site.
const MULTIPLAYER_WORDS = {
  untested: 'Nobody has tried this game\'s multiplayer here yet.',
  broken: 'This game\'s multiplayer is known not to work here.',
  connects: 'Players reach each other in this game; whether a whole match works is not known.',
  plays: 'This game\'s multiplayer has been played here.',
};

// What an entry's "multiplayer" says: { bluetooth, menu, status, note }, where
// `bluetooth` is whether the game hosts and joins over Bluetooth, `menu` is
// where its own menu has that and `status` is a sentence on how far it gets.
// null when the entry says the game has none; undefined when it says nothing.
function multiplayerFacts(value) {
  if (value === null) return null;
  if (!isRecord(value)) return undefined;
  return {
    bluetooth: Array.isArray(value.modes) && value.modes.includes('bluetooth'),
    menu: text(value.menu, LIMITS.menu),
    status: typeof value.status === 'string' && Object.hasOwn(MULTIPLAYER_WORDS, value.status) ? MULTIPLAYER_WORDS[value.status] : '',
    note: text(value.statusNote, LIMITS.multiplayerNote),
  };
}

// What the catalogue says about a game, for the status line, the guide and
// the multiplayer dialog: { slug, title, about, status: { label, tone, note }
// | null, multiplayer }, any of them empty when the entry does not say; null
// when it is not an entry at all.
export function gameFacts(entry) {
  if (!isRecord(entry)) return null;
  const words = typeof entry.status === 'string' && Object.hasOwn(STATUS_WORDS, entry.status) ? STATUS_WORDS[entry.status] : null;
  const year = Number.isInteger(entry.year) && entry.year > 1990 && entry.year < 2100 ? String(entry.year) : '';

  return {
    slug: typeof entry.slug === 'string' && /^[a-z0-9-]{1,64}$/.test(entry.slug) ? entry.slug : '',
    multiplayer: multiplayerFacts(entry.multiplayer),
    title: text(entry.title, LIMITS.title),
    about: [text(entry.publisher, 60), year, text(entry.genre, 60)].filter(Boolean).join(' · '),
    status: words ? { label: words.label, tone: words.tone, note: text(entry.statusNote, LIMITS.note) || words.fallback } : null,
  };
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
