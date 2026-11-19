// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where the site's documentation explains a finding.
//
// A site that hosts the player has a help page with one section per finding:
// what it means in everyday words, why it happens, what to try. The dialog
// links each finding to its section ("More about this"). The section's
// address is the page plus the anchor the site makes from the section's
// heading, so the table below follows the headings of that page, and a
// heading that changes there changes here. The site's build holds the two
// together: it fails when a finding has no section, when a section belongs
// to no finding, and when an anchor here is not the one the section has.
//
// Nothing here touches the document, so tests can call it.

// The help page, relative to the address of the site's documentation.
export const HELP_PAGE = 'troubleshooting/';

// Finding code -> anchor of its section on the help page. One line per code,
// in the order of codes.js; the site's build reads this table as text.
export const HELP_ANCHORS = {
  'browser-unsupported': 'the-browser-cannot-run-the-emulator',
  'cpu-bound': 'this-device-is-too-slow-for-the-game',
  'game-limited': 'the-game-runs-at-its-own-speed',
  'timers-late': 'something-else-is-using-the-processor',
  'software-rendering': 'the-browser-draws-without-the-graphics-card',
  'graphics-bound': 'drawing-the-picture-takes-too-long',
  'no-animation-frames': 'the-browser-is-not-showing-the-page',
  'context-lost': 'the-browser-took-the-picture-away',
  'audio-underruns': 'the-sound-has-gaps',
  'audio-suspended': 'the-sound-has-not-started-yet',
  'audio-unavailable': 'this-browser-cannot-play-the-sound',
  'mixer-starved': 'the-sound-falls-behind',
  'game-crashed': 'the-game-crashed',
  'game-exited': 'the-game-closed-by-itself',
  'emulator-stopped': 'the-emulator-stopped',
  'page-errors': 'the-page-ran-into-errors',
  'unimplemented-calls': 'the-game-asks-for-something-the-emulator-cannot-do',
  'memory-near-limit': 'the-emulator-is-running-out-of-memory',
  'low-device-memory': 'the-device-has-little-memory',
  'storage-nearly-full': 'the-storage-for-this-site-is-almost-full',
  'saves-not-kept': 'saves-will-not-be-kept',
  'save-slow': 'storing-the-saves-takes-long',
  'device-slow': 'the-processor-is-slower-than-the-emulator-needs',
  'few-cores': 'the-processor-has-too-few-cores',
  'tab-was-hidden': 'the-page-was-in-the-background',
  'main-thread-stalls': 'the-page-keeps-getting-held-up',
  'relay-slow': 'the-connection-to-the-other-players-is-slow',
  'net-frames-dropped': 'the-game-fell-behind-the-connection',
  'relay-unreachable': 'the-multiplayer-service-cannot-be-reached',
  'slow-download': 'the-download-was-slow',
  'slow-start': 'starting-the-game-took-long',
};

// The address of the help for the finding `code`, given the address of the
// site's documentation (ending in a slash, for example
// "https://n-ga.ge/docs/"), or null when the code has no section or there is
// no documentation to point into.
export function helpLink(code, docs) {
  if (typeof docs !== 'string' || !docs) return null;
  if (typeof code !== 'string' || !Object.hasOwn(HELP_ANCHORS, code)) return null;
  return `${docs}${docs.endsWith('/') ? '' : '/'}${HELP_PAGE}#${HELP_ANCHORS[code]}`;
}
