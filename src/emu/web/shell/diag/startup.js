// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: how long loading and starting took, step by step.
// Not written yet: it has nothing to say, so the dialog leaves it out.
// core.js describes what a section is; browser.js and session.js are two.

export default {
  id: 'startup',
  title: 'Start-up',
  order: 80,

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
