// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which control profiles the page has to choose from, and what it takes from
// the site it is part of (see catalog.js): the running game's profile and
// facts, and links back to the site.
//
// The catalogue is asked after a game has started, so every answer arrives
// late. Until then the page uses what games.js has (the standard layout, or a
// built-in profile), and a page with no catalogue stays that way.

import { catalogIndex, gameBySlug, gameByUid, siteConfig } from './catalog.js';
import { GAME_PROFILES, STANDARD_PROFILE, gameFacts, profileFor, profileFromEntry } from './games.js';

const fromCatalog = new Map(); // profile id -> profile built from a catalogue entry
const gameProfile = new Map(); // app UID -> id of that game's catalogue profile
const gameLookups = new Map();
const profileLookups = new Map();

const sameUid = (a, b) => String(a).toUpperCase() === String(b).toUpperCase();

// The profile to use when the layout is left on automatic: the catalogue's
// for this game once it has arrived, else a built-in one, else the standard.
export function autoProfile(uid) {
  return (uid && fromCatalog.get(gameProfile.get(uid))) || profileFor(uid);
}

// A profile the user chose by id, or null when nothing by that id is known
// (yet). The catalogue's version of a profile wins over the built-in one.
export function profileById(id) {
  if (id === STANDARD_PROFILE.id) return STANDARD_PROFILE;
  return fromCatalog.get(id) || Object.values(GAME_PROFILES).find((profile) => profile.id === id) || null;
}

// Every game profile known so far, for the layout selector.
export function gameProfiles() {
  return [...fromCatalog.values(), ...Object.values(GAME_PROFILES).filter((profile) => !fromCatalog.has(profile.id))];
}

async function findGame(uid, slug) {
  try {
    // A translation or mod shares its base game's UID. The slug in the page
    // address, when it names a game with this UID, says which one is running.
    // The UID has to match: the address can outlive the game it started
    // (another card loaded from a file), and a wrong guess would rename that
    // game and move its keys.
    const named = slug ? await gameBySlug(slug) : null;
    const entry = named && sameUid(named.uid, uid) ? named : await gameByUid(uid);
    if (!entry && named) console.warn(`catalogue lists ${slug} as app ${String(named.uid).slice(0, 16)}, but app ${uid} is running: entry not used`);

    const facts = gameFacts(entry);
    if (!facts) return null;
    const profile = profileFromEntry(entry);
    if (profile) {
      fromCatalog.set(profile.id, profile);
      gameProfile.set(uid, profile.id);
    }
    return { ...facts, uid, hasControls: Boolean(profile) };
  } catch (error) {
    // A catalogue that cannot be read costs the extras, never the game.
    console.warn('catalogue entry ignored:', error);
    return null;
  }
}

// Asks the catalogue about the game with this app UID. Resolves to its facts
// (games.js gameFacts, plus `uid` and `hasControls`) or null, after making its
// control profile available to autoProfile() and profileById().
export function lookUpGame(uid, slug = null) {
  const key = `${uid} ${slug || ''}`;
  if (!gameLookups.has(key)) gameLookups.set(key, findGame(uid, slug));
  return gameLookups.get(key);
}

async function findProfile(id) {
  try {
    // Ask only for a game the catalogue lists: a layout chosen long ago may
    // name one that is gone.
    const index = await catalogIndex();
    if (!index || !Array.isArray(index.games) || !index.games.some((game) => game && game.slug === id)) return null;
    const profile = profileFromEntry(await gameBySlug(id));
    if (!profile || profile.id !== id) return null;
    fromCatalog.set(id, profile);
    return profile;
  } catch (error) {
    console.warn('catalogue profile ignored:', error);
    return null;
  }
}

// Fetches the catalogue's profile with this id (a game's slug), for a layout
// the user chose by name while another game is running. Resolves to it or null.
export function lookUpProfile(id) {
  if (!profileLookups.has(id)) profileLookups.set(id, findProfile(id));
  return profileLookups.get(id);
}

// Replaces an Input's binding tables, as Input.setBindings does, but without
// letting go of what is held: a profile that arrives while the player is
// already walking must not stop them. A held keyboard key carries on pressing
// the N-Gage keys it is bound to in both tables, lets go of those only the old
// table had, and presses those only the new one has. Gamepads need no care:
// the poll compares what is held against the new table by itself.
export function switchBindings(input, bindings) {
  const keyboard = new Map();
  for (const [key, codes] of Object.entries(bindings.keyboard || {})) {
    for (const code of codes) {
      if (!keyboard.has(code)) keyboard.set(code, []);
      keyboard.get(code).push(key);
    }
  }
  const gamepad = [];
  for (const [key, inputs] of Object.entries(bindings.gamepad || {})) {
    for (const padInput of inputs) gamepad.push({ input: padInput, key });
  }

  const held = new Set();
  for (const sources of input.holders.values()) {
    for (const source of sources) {
      if (source.startsWith('keyboard:')) held.add(source.slice('keyboard:'.length));
    }
  }

  const before = input.keyboard;
  input.keyboard = keyboard;
  input.gamepad = gamepad;

  for (const code of held) {
    const was = before.get(code) || [];
    const now = keyboard.get(code) || [];
    for (const key of was) if (!now.includes(key)) input.release('keyboard:' + code, key);
    for (const key of now) if (!was.includes(key)) input.press('keyboard:' + code, key);
  }
}

// Where the menu's "All games" and "Documentation" lead: config.json's "home"
// and "docs", by default the site root and /docs/ when the site has a
// catalogue. Either is null when there is nowhere to go (a bare player).
export async function siteLinks() {
  const config = await siteConfig();
  const link = (value, fallback) => {
    const target = typeof value === 'string' && value ? value : (config.catalog ? fallback : '');
    if (!target) return null;
    try {
      const url = new URL(target, location.href);
      return /^https?:$/.test(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  };
  return { home: link(config.home, '/'), docs: link(config.docs, '/docs/') };
}
