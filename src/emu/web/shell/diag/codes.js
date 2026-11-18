// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every finding the diagnostics can make, by its code. A code names one cause
// in a report, in the tests that provoke it, and in the help page that
// explains it to a visitor, so the list is fixed here: a section may only
// return codes it owns, and a new code is added here first.

export const CODES = {
  // browser.js
  'browser-unsupported': 'browser',
  // speed.js
  'cpu-bound': 'speed',
  'game-limited': 'speed',
  'timers-late': 'speed',
  // graphics.js
  'software-rendering': 'graphics',
  'graphics-bound': 'graphics',
  'no-animation-frames': 'graphics',
  'context-lost': 'graphics',
  // audio.js
  'audio-underruns': 'audio',
  'audio-suspended': 'audio',
  'audio-unavailable': 'audio',
  'mixer-starved': 'audio',
  // errors.js
  'game-crashed': 'errors',
  'game-exited': 'errors',
  'emulator-stopped': 'errors',
  'page-errors': 'errors',
  'unimplemented-calls': 'errors',
  // memory.js
  'memory-near-limit': 'memory',
  'low-device-memory': 'memory',
  'storage-nearly-full': 'memory',
  'saves-not-kept': 'memory',
  'save-slow': 'memory',
  // environment.js
  'device-slow': 'environment',
  'few-cores': 'environment',
  'tab-was-hidden': 'environment',
  'main-thread-stalls': 'environment',
  // network.js
  'relay-slow': 'network',
  'net-frames-dropped': 'network',
  'relay-unreachable': 'network',
  // startup.js
  'slow-download': 'startup',
  'slow-start': 'startup',
};

// How serious a finding is. 'bad' explains a game that does not run or runs
// badly; 'warn' is something that costs speed or will cause trouble; 'info'
// is worth knowing and not a fault (the game's own frame cap, for one).
export const LEVELS = ['bad', 'warn', 'info'];
