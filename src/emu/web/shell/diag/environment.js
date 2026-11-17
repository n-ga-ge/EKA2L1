// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: what the device and the browser do to the page: speed, hidden tabs, stalls.
// Not written yet: it has nothing to say, so the dialog leaves it out.
// core.js describes what a section is; browser.js and session.js are two.

export default {
  id: 'environment',
  title: 'This device',
  order: 70,

  collect() {
    return null;
  },

  findings() {
    return [];
  },

  render() {
    return [];
  },
};
