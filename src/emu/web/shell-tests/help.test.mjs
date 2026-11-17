// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics: where a finding's help is (shell/diag/help.js). Every finding
// has an address of its own, and nothing else has one. That each address
// leads to a section that exists is checked where the help page is: in the
// build of the site that hosts the player.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODES } from '../shell/diag/codes.js';
import { HELP_ANCHORS, HELP_PAGE, helpLink } from '../shell/diag/help.js';

const DOCS = 'https://n-ga.ge/docs/';

test('a finding links to its section of the help page', () => {
  assert.equal(helpLink('cpu-bound', DOCS), 'https://n-ga.ge/docs/troubleshooting/#this-device-is-too-slow-for-the-game');
  assert.equal(helpLink('saves-not-kept', 'http://127.0.0.1:8530/docs/'), 'http://127.0.0.1:8530/docs/troubleshooting/#saves-will-not-be-kept');
});

test('every finding code has help, and only finding codes do', () => {
  assert.deepEqual(Object.keys(HELP_ANCHORS).sort(), Object.keys(CODES).sort());
  for (const code of Object.keys(CODES)) {
    const link = helpLink(code, DOCS);
    assert.equal(link, `${DOCS}${HELP_PAGE}#${HELP_ANCHORS[code]}`, code);
    assert.equal(new URL(link).hash, `#${HELP_ANCHORS[code]}`, code);
  }
});

test('an anchor is what a site makes of a heading, and no two findings share one', () => {
  const anchors = Object.values(HELP_ANCHORS);
  // Lower-case words joined by single hyphens: the id a heading's text gets.
  for (const anchor of anchors) assert.match(anchor, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.equal(new Set(anchors).size, anchors.length);
});

test('the help page is a folder under the documentation', () => {
  assert.match(HELP_PAGE, /^[a-z0-9-]+\/$/);
});

test('a code without a section: no link', () => {
  assert.equal(helpLink('no-such-finding', DOCS), null);
  assert.equal(helpLink('', DOCS), null);
  assert.equal(helpLink(undefined, DOCS), null);
  assert.equal(helpLink(null, DOCS), null);
  // Names every object has are not codes.
  assert.equal(helpLink('constructor', DOCS), null);
  assert.equal(helpLink('toString', DOCS), null);
  assert.equal(helpLink('__proto__', DOCS), null);
});

test('no documentation address: no link', () => {
  assert.equal(helpLink('cpu-bound', null), null);
  assert.equal(helpLink('cpu-bound', undefined), null);
  assert.equal(helpLink('cpu-bound', ''), null);
  assert.equal(helpLink('cpu-bound', 42), null);
});

test('a documentation address without its closing slash still gives the page', () => {
  assert.equal(helpLink('cpu-bound', 'https://n-ga.ge/docs'), helpLink('cpu-bound', DOCS));
});

test('the table is in the order of the codes, one line each', () => {
  // The site's build reads the table as text and a reader compares the two
  // lists by eye: keep them in step.
  assert.deepEqual(Object.keys(HELP_ANCHORS), Object.keys(CODES));
});
