// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section "browser": what it concludes from what the browser
// supports. The pattern for a section's test: build `data` as collect() would
// return it and check findings(data).

import assert from 'node:assert/strict';
import test from 'node:test';

import browser from '../shell/diag/browser.js';

const data = (required) => ({ ok: required.every((item) => item.ok), required, optional: [], cores: 8, memoryGB: 8, mobile: false, userAgent: 'test' });

test('a browser with everything: nothing found', () => {
  assert.deepEqual(browser.findings(data([{ name: 'WebGL2', ok: true, detail: '' }])), []);
});

test('a browser without something required: named in the finding', () => {
  const found = browser.findings(data([
    { name: 'WebGL2', ok: true, detail: '' },
    { name: 'Cross-origin isolation', ok: false, detail: 'the server must send COOP and COEP' },
  ]));
  assert.equal(found.length, 1);
  assert.equal(found[0].code, 'browser-unsupported');
  assert.equal(found[0].level, 'bad');
  assert.match(found[0].detail, /Cross-origin isolation \(the server must send COOP and COEP\)/);
  assert.doesNotMatch(found[0].detail, /WebGL2/);
});

test('collect: no support information, no section', () => {
  assert.equal(browser.collect({ page: { support: null } }), null);
});
