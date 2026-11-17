// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: games that crashed or closed, and errors of the page and the emulator.
// Not written yet: it has nothing to say, so the dialog leaves it out.
// core.js describes what a section is; browser.js and session.js are two.

export default {
  id: 'errors',
  title: 'Errors',
  order: 50,

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
