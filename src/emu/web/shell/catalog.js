// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The hosting site's game catalogue, if it has one. config.json next to the
// page may name:
//   "catalog"  base URL of the catalogue. <catalog>index.json lists the games,
//              { games: [{ slug, title, uid, status, variantOf, ... }] }, and
//              <catalog>games/<slug>.json describes one: its title, app UID,
//              control profile ("controls", shaped like a profile in games.js)
//              and notes.
//   "assets"   base URL the game files are served from; a game's card is
//              <assets>games/<slug>.zip unless its entry has an absolute "zip".
//   "fw"       URL of the firmware.
// Other keys of config.json are read elsewhere: "home" and "docs" (the menu's
// links back to the site, profiles.js), "cacheMB" (the size bound of the
// download cache, loader.js, which also reads <catalog>assets.json) and
// "title" and "game" (a one-click "Play <title>" for a site without a
// catalogue, app.js).
// Everything here resolves to null when the site has no catalogue or a file is
// missing, so the page works the same on a bare build.

let configPromise = null;
let indexPromise = null;
const games = new Map();

async function fetchJson(url, options) {
  try {
    const response = await fetch(url, options);
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

const withSlash = (base) => (base.endsWith('/') ? base : `${base}/`);

// The site's config.json, or {} when there is none.
export function siteConfig() {
  if (!configPromise) configPromise = fetchJson('config.json', { cache: 'no-store' }).then((config) => config || {});
  return configPromise;
}

// { games: [...] } or null.
export function catalogIndex() {
  if (!indexPromise) {
    indexPromise = siteConfig().then((config) => (config.catalog ? fetchJson(`${withSlash(config.catalog)}index.json`) : null));
  }
  return indexPromise;
}

// The full entry of one game, or null.
export function gameBySlug(slug) {
  if (!/^[a-z0-9-]+$/.test(String(slug))) return Promise.resolve(null);
  if (!games.has(slug)) {
    games.set(slug, siteConfig().then((config) => (config.catalog ? fetchJson(`${withSlash(config.catalog)}games/${slug}.json`) : null)));
  }
  return games.get(slug);
}

// The entry for an app UID as the emulator reports it ("0x101FD3F6"). Variants
// share their base game's UID; the base game's entry is the one returned.
export async function gameByUid(uid) {
  const index = await catalogIndex();
  if (!index || !Array.isArray(index.games)) return null;
  const wanted = String(uid).toUpperCase();
  const matches = index.games.filter((game) => String(game.uid).toUpperCase() === wanted);
  const entry = matches.find((game) => !game.variantOf) || matches[0];
  return entry ? gameBySlug(entry.slug) : null;
}

// Where a game's card archive is downloaded from, or null.
export async function gameUrl(game) {
  if (!game) return null;
  if (game.zip && /^(https?:)?\/\//.test(game.zip)) return game.zip;
  const config = await siteConfig();
  return config.assets ? `${withSlash(config.assets)}games/${game.slug}.zip` : null;
}

// The site's firmware URL, or null.
export async function firmwareUrl() {
  return (await siteConfig()).fw || null;
}
