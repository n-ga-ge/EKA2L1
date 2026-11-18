// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The diagnostics core: the stretch of play a rate is measured over, the
// order of findings, and that every section is what core.js says a section is.

import assert from 'node:assert/strict';
import test from 'node:test';

import { CODES, LEVELS } from '../shell/diag/codes.js';
import { checkedFindings, frameRates, sortFindings, span } from '../shell/diag/core.js';
import { SECTIONS } from '../shell/diag/sections.js';

const sample = (second, frames, running = true, app = 1) => ({ t: second * 1000, frames, running, app });

test('span: the last stretch of play, no longer than asked', () => {
  const samples = Array.from({ length: 60 }, (_, i) => sample(i, i * 20));
  const stretch = span(samples, 30);
  assert.equal(stretch.b.t, 59000);
  assert.equal(stretch.a.t, 29000);
  assert.equal(stretch.seconds, 30);
  assert.equal(stretch.samples.length, 31);
});

test('span: a pause ends the stretch, and what follows a pause is not counted', () => {
  const samples = [sample(0, 0), sample(1, 20), sample(2, 40, false), sample(3, 40), sample(4, 60), sample(5, 80, false)];
  const stretch = span(samples, 30);
  assert.equal(stretch.a.t, 3000);
  assert.equal(stretch.b.t, 4000);
});

test('span: another game ends the stretch', () => {
  const samples = [sample(0, 0, true, 1), sample(1, 20, true, 1), sample(2, 40, true, 2), sample(3, 60, true, 2)];
  assert.equal(span(samples, 30).a.t, 2000);
});

test('span: nothing to measure', () => {
  assert.equal(span([], 30), null);
  assert.equal(span([sample(0, 0)], 30), null);
  assert.equal(span([sample(0, 0, false), sample(1, 0, false)], 30), null);
  assert.equal(span([sample(0, 0, false), sample(1, 0)], 30), null);
});

test('frameRates: per pair of samples, by their real distance', () => {
  assert.deepEqual(frameRates([sample(0, 0), sample(1, 20), sample(3, 50)]), [20, 15]);
});

test('sortFindings: worst first, otherwise as given', () => {
  const list = [{ code: 'a', level: 'info' }, { code: 'b', level: 'bad' }, { code: 'c', level: 'warn' }, { code: 'd', level: 'bad' }];
  assert.deepEqual(sortFindings(list).map((finding) => finding.code), ['b', 'd', 'c', 'a']);
});

test('checkedFindings: drops a code the section does not own and a level that does not exist', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const section = {
      id: 'speed',
      findings: () => [
        { code: 'cpu-bound', level: 'bad', title: 't' },
        { code: 'software-rendering', level: 'bad', title: 't' },
        { code: 'cpu-bound', level: 'terrible', title: 't' },
        { code: 'made-up', level: 'bad', title: 't' },
      ],
    };
    assert.deepEqual(checkedFindings(section, {}), [{ code: 'cpu-bound', level: 'bad', title: 't', section: 'speed' }]);
  } finally {
    console.warn = warn;
  }
});

test('every section is a section', () => {
  const ids = new Set();
  const orders = new Set();
  for (const section of SECTIONS) {
    assert.match(section.id, /^[a-z]+$/);
    assert.ok(!ids.has(section.id), `two sections named ${section.id}`);
    ids.add(section.id);
    assert.ok(!orders.has(section.order), `two sections at ${section.order}`);
    orders.add(section.order);
    assert.equal(typeof section.title, 'string');
    for (const hook of ['collect', 'findings', 'render']) assert.equal(typeof section[hook], 'function', `${section.id}.${hook}`);
  }
  for (const [code, owner] of Object.entries(CODES)) {
    assert.match(code, /^[a-z]+(-[a-z]+)*$/);
    assert.ok(ids.has(owner), `${code} belongs to ${owner}, which is no section`);
  }
  assert.deepEqual(LEVELS, ['bad', 'warn', 'info']);
});
