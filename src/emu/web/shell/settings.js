// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page settings, kept in localStorage: display options, control bindings the
// user changed, and the last URLs loaded. Everything degrades to defaults when
// storage is unavailable (private windows).

const STORAGE_KEY = 'eka2l1.settings.v1';

const DEFAULTS = {
  display: {
    // 'nearest', 'linear', or the name of an upscale shader.
    filter: 'nearest',
    // 'auto' matches the size the picture is shown at; a number is that many
    // times the guest's own resolution.
    resolution: 'auto',
  },
  // 'auto' picks the running game's profile when there is one.
  profile: 'auto',
  // profile id -> { keyboard: {...}, gamepad: {...} }: full replacements of
  // the profile's tables, written the first time the user edits a binding.
  bindings: {},
  urls: { fw: '', game: '' },
};

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...DEFAULTS,
      ...stored,
      display: { ...DEFAULTS.display, ...(stored.display || {}) },
      urls: { ...DEFAULTS.urls, ...(stored.urls || {}) },
      bindings: stored.bindings || {},
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export const settings = load();

export function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage disabled */ }
}
