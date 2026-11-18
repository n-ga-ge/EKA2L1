// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page settings, kept in localStorage: display options, control bindings the
// user changed, the last URLs loaded and the multiplayer name. Everything degrades to defaults when
// storage is unavailable (private windows).

const STORAGE_KEY = 'eka2l1.settings.v1';

const DEFAULTS = {
  display: {
    // 'nearest', 'linear', or the name of an upscale shader.
    filter: 'nearest',
    // 'auto' matches the size the picture is shown at; a number is that many
    // times the guest's own resolution.
    resolution: 'auto',
    // What fills the space beside the picture on a wide screen: 'none',
    // 'stretch' or 'ambient' (beta).
    fill: 'none',
    // For a game with an enhancement profile: the size its 3D is drawn at.
    // 'off' leaves it to the game, a number is that many times the guest's
    // own resolution, 'auto' the size the picture is shown at (beta).
    enhance: 'off',
    // How textures are sampled there: 'nearest' or 'linear'.
    enhanceFilter: 'nearest',
  },
  // 'auto' picks the running game's profile when there is one.
  profile: 'auto',
  // profile id -> { keyboard: {...}, gamepad: {...} }: full replacements of
  // the profile's tables, written the first time the user edits a binding.
  bindings: {},
  urls: { fw: '', game: '' },
  // The name the other players of a multiplayer room see.
  multiplayer: { name: 'Player' },
};

function load() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return {
      ...DEFAULTS,
      ...stored,
      display: { ...DEFAULTS.display, ...(stored.display || {}) },
      urls: { ...DEFAULTS.urls, ...(stored.urls || {}) },
      multiplayer: { ...DEFAULTS.multiplayer, ...(stored.multiplayer || {}) },
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
