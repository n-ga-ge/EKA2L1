// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Getting the firmware and a game card to the emulator quickly.
//
// The emulator keeps only the phone's own memory (the saves) between visits.
// The firmware and the card are installed again every session, which takes a
// fraction of a second each once their files are at hand; copying an
// installed firmware and card back out of the emulator's stored data took
// several seconds, and longer with every game ever played. So the downloads
// themselves are what is kept, here, as files in the origin's private file
// system (OPFS):
//
//   - A download starts as soon as the page knows what it needs, while the
//     emulator is still being compiled and started, and goes straight to
//     storage. Nothing is held whole in memory.
//   - On a site with a catalogue, <catalog>assets.json
//     ({ fw: { bytes, sha256 }, games: { <slug>: { bytes, sha256 } } }) names
//     each file's content. Such a file is requested as <url>?v=<sha256>, a
//     URL whose content never changes, and kept under that URL for good; a
//     new version of the file has a new URL.
//   - Any other URL is kept under itself with the validators the server sent
//     (ETag, Last-Modified). It is used without asking for a day; after that
//     one HEAD request decides whether it is still current. When the server
//     cannot be reached the stored copy is used.
//   - The cache has a size bound. Past it the games used longest ago go; the
//     firmware and the game being started stay.
//   - A download that is cut off leaves nothing usable behind: a file only
//     gets its content when the whole of it has arrived, and only then is it
//     entered in the index. The next visit simply downloads again.
//
// Where OPFS cannot be written from a page (browsers without
// FileSystemFileHandle.createWritable) the files go to Cache storage instead,
// which is slower to write: in Chrome 6 MB/s against 100 MB/s. Without
// either (some private windows) or with ?persist=0, downloads are held in
// memory for the session and everything else works the same.

import { firmwareUrl, gameBySlug, gameUrl, siteConfig } from './catalog.js';

// Folder in OPFS, and name of the fallback cache, that hold the files.
const STORE_NAME = 'eka2l1-downloads-v1';
// The index: per URL kept, the file that holds it, what it is, its size, the
// server's validators, and when it was last used and last checked against the
// server. A file is only usable through its entry here, so an entry written
// after the file is complete is what commits a download.
const NOTES_KEY = 'eka2l1.downloads.v2';
// The entry of the firmware used last, for loads that name only a game.
const FIRMWARE_KEY = 'eka2l1.firmware.v1';
// The entry a firmware picked from this device is kept under.
const LOCAL_FIRMWARE = new URL('.eka2l1-local/firmware', location.href).href;
// A file without an entry is deleted once it is this old; a younger one may
// be a download in progress, here or in another tab.
const ORPHAN_MS = 60 * 60 * 1000;

const DEFAULT_LIMIT_MB = 512;
const RECHECK_MS = 24 * 60 * 60 * 1000;

const megabytes = (bytes) => (bytes / 1048576).toFixed(1);

// An error the page reacts to by its `code` rather than its text.
export class LoadError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function checkedUrl(url, label) {
  let parsed;
  try {
    parsed = new URL(url, location.href);
  } catch {
    throw new Error(`${label}: "${url}" is not a URL`);
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`${label}: only http(s) URLs are allowed`);
  return parsed;
}

// --- where the bytes are kept ------------------------------------------------------
//
// Three interchangeable places. Each keeps whole files by name:
//   read(name)           resolves to a Blob, or null when there is no such file
//   write(name, stream)  stores the stream; the file appears complete or not at all
//   remove(name), names()

class OpfsFiles {
  static async open() {
    if (typeof FileSystemFileHandle === 'undefined' || !('createWritable' in FileSystemFileHandle.prototype)) return null;
    const root = await navigator.storage.getDirectory();
    return new OpfsFiles(await root.getDirectoryHandle(STORE_NAME, { create: true }));
  }

  constructor(dir) {
    this.dir = dir;
  }

  async read(name) {
    try {
      const file = await (await this.dir.getFileHandle(name)).getFile();
      return file.size ? file : null; // empty: a download that never finished
    } catch {
      return null;
    }
  }

  async write(name, stream) {
    const handle = await this.dir.getFileHandle(name, { create: true });
    // The stream writes to a temporary file that replaces `name` when it is
    // closed, so a failure or a closed tab leaves `name` empty.
    const writable = await handle.createWritable();
    try {
      await stream.pipeTo(writable);
    } catch (error) {
      await this.remove(name);
      throw error;
    }
  }

  async remove(name) {
    await this.dir.removeEntry(name).catch(() => {});
  }

  async names() {
    const names = [];
    for await (const name of this.dir.keys()) names.push(name);
    return names;
  }

  async modified(name) {
    try {
      return (await (await this.dir.getFileHandle(name)).getFile()).lastModified;
    } catch {
      return Date.now();
    }
  }
}

class CacheFiles {
  static async open() {
    return new CacheFiles(await caches.open(STORE_NAME));
  }

  constructor(cache) {
    this.cache = cache;
    this.base = new URL('.eka2l1-downloads/', location.href).href;
  }

  async read(name) {
    const response = await this.cache.match(this.base + name);
    return response ? response.blob() : null;
  }

  async write(name, stream) {
    // Cache storage keeps an entry only once its whole body has arrived.
    await this.cache.put(this.base + name, new Response(stream));
  }

  async remove(name) {
    await this.cache.delete(this.base + name).catch(() => {});
  }

  async names() {
    return (await this.cache.keys()).map((request) => request.url.slice(this.base.length));
  }

  async modified() {
    return 0; // nothing half-written is ever listed
  }
}

class MemoryFiles {
  constructor() {
    this.blobs = new Map();
  }

  async read(name) {
    return this.blobs.get(name) || null;
  }

  async write(name, stream) {
    this.blobs.set(name, await new Response(stream).blob());
  }

  async remove(name) {
    this.blobs.delete(name);
  }

  async names() {
    return [...this.blobs.keys()];
  }

  async modified() {
    return Date.now();
  }
}

// --- the download cache ----------------------------------------------------------

export class Downloads {
  constructor(files, limitMB) {
    this.files = files || new MemoryFiles();
    this.kept = Boolean(files); // false: nothing outlives the page
    // Downloads that did not fit into storage, held for this session.
    this.overflow = new MemoryFiles();
    this.limitMB = limitMB;
    this.notes = {};
    this.loadNotes();
  }

  // `persist: false` keeps downloads in memory only. `limitMB` overrides the
  // size bound.
  static async open({ persist = true, limitMB = null } = {}) {
    let files = null;
    if (persist) {
      files = await OpfsFiles.open().catch(() => null);
      if (!files) files = await CacheFiles.open().catch(() => null);
    }
    return new Downloads(files, limitMB);
  }

  // Whether the stored index has an entry for `key`; needs no open cache.
  static noted(key) {
    return key in Downloads.storedNotes();
  }

  static storedNotes() {
    try {
      const notes = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
      return notes && typeof notes === 'object' ? notes : {};
    } catch {
      return {};
    }
  }

  // The index is read again before every change, so two tabs do not undo
  // each other's entries. Once it could not be written (localStorage is
  // blocked or full) the copy in memory is the only one, and is kept.
  loadNotes() {
    if (this.kept && !this.unsaved) this.notes = Downloads.storedNotes();
  }

  saveNotes() {
    if (!this.kept) return;
    try {
      localStorage.setItem(NOTES_KEY, JSON.stringify(this.notes));
    } catch {
      this.unsaved = true;
    }
  }

  // The entry that holds `url` under a content address (<url>?v=<sha256>),
  // if the stored index has one.
  static versioned(url) {
    return Object.keys(Downloads.storedNotes()).find((key) => {
      const bare = new URL(key);
      if (!bare.searchParams.has('v')) return false;
      bare.searchParams.delete('v');
      return bare.href === url;
    }) || null;
  }

  place(note) {
    return note.overflow ? this.overflow : this.files;
  }

  // The entry for `key` when its file is there and whole, else null.
  async lookup(key) {
    const note = this.notes[key];
    if (!note) return null;
    const blob = await this.place(note).read(note.file);
    if (!blob || blob.size !== note.bytes) {
      await this.remove(key);
      return null;
    }
    return { key, etag: note.etag, modified: note.modified };
  }

  // Something the emulator client can take a file from: its size, and
  // open(), which resolves to a stream of its bytes.
  source(key) {
    const known = this.notes[key];
    return {
      key,
      bytes: known ? known.bytes : 0,
      open: async () => {
        // Looked up now, not when the source was made: another tab may have
        // stored the same download since and replaced the file.
        this.loadNotes();
        const note = this.notes[key];
        const blob = note ? await this.place(note).read(note.file) : null;
        if (!blob) throw new Error('A stored download has gone missing. Reload the page to fetch it again.');
        return blob.stream();
      },
    };
  }

  // Stores `body` (a stream) under `key`. Resolves once all of it is stored;
  // if the stream fails nothing changes. `count()` gives the number of bytes
  // that went through, known only once the stream has ended. `overflow`
  // keeps it in memory instead, for this session.
  async write(key, kind, body, validators, count, overflow = false) {
    // A new file each time: an entry being replaced stays whole until the
    // index points at its successor.
    const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    await (overflow ? this.overflow : this.files).write(file, body);

    this.loadNotes();
    const old = this.notes[key];
    const now = Date.now();
    this.notes[key] = { file, kind, bytes: count(), used: now, checked: now, etag: validators.etag || null, modified: validators.modified || null };
    if (overflow) this.notes[key].overflow = true;
    this.saveNotes();
    if (old) await this.place(old).remove(old.file);
  }

  async remove(key) {
    this.loadNotes();
    const note = this.notes[key];
    if (!note) return;
    delete this.notes[key];
    this.saveNotes();
    await this.place(note).remove(note.file);
  }

  // Whether a stored copy may be used without asking the server. A firmware
  // that has never installed is not taken on trust: if it is the wrong file
  // and the server's copy gets corrected, the next visit should notice.
  fresh(key) {
    const note = this.notes[key];
    return Boolean(note && (note.kind !== 'fw' || note.proven) && Date.now() - note.checked < RECHECK_MS);
  }

  touch(key, field) {
    this.loadNotes();
    if (!this.notes[key]) return;
    this.notes[key][field] = Date.now();
    this.saveNotes();
  }

  firmwareKey() {
    let key = null;
    try { key = this.kept ? localStorage.getItem(FIRMWARE_KEY) : null; } catch { /* storage disabled */ }
    return key || this.lastFirmware || null;
  }

  // The firmware used last, as a source, or null when it is no longer stored.
  async firmware() {
    const key = this.firmwareKey();
    if (key && (await this.lookup(key))) return this.source(key);
    if (!this.adoption) this.adoption = this.adoptInstalledFirmware().catch(() => false);
    return (await this.adoption) ? this.source(LOCAL_FIRMWARE) : null;
  }

  // Builds from before this cache kept the installed firmware in the
  // emulator's stored data (data/roms/<device>/), which the emulator now
  // deletes. Someone who installed theirs from a file has no other copy, so
  // it is taken over from there while it still exists.
  async adoptInstalledFirmware() {
    if (!this.kept) return false;
    const root = await navigator.storage.getDirectory();
    const roms = await (await root.getDirectoryHandle('data')).getDirectoryHandle('roms');
    for await (const device of roms.values()) {
      if (device.kind !== 'directory') continue;
      for await (const handle of device.values()) {
        if (handle.kind !== 'file') continue;
        await this.keepFirmware(await handle.getFile());
        return true;
      }
    }
    return false;
  }

  // Notes which entry is the firmware in use (it installed) and drops any
  // other firmware.
  async rememberFirmware(key) {
    this.loadNotes();
    if (this.notes[key] && !this.notes[key].proven) {
      this.notes[key].proven = true;
      this.saveNotes();
    }
    this.lastFirmware = key;
    try { if (this.kept) localStorage.setItem(FIRMWARE_KEY, key); } catch { /* storage disabled */ }
    for (const other of this.keys()) {
      if (other !== key && this.notes[other] && this.notes[other].kind === 'fw') await this.remove(other);
    }
  }

  // Keeps a firmware file picked from this device, so it is asked for once.
  async keepFirmware(file) {
    await this.write(LOCAL_FIRMWARE, 'fw', file.stream(), {}, () => file.size);
    await this.rememberFirmware(LOCAL_FIRMWARE);
  }

  keys() {
    return Object.keys(this.notes);
  }

  // The size bound in bytes: the one given to open(), else "cacheMB" from the
  // site's config.json, else the default, and without an explicit bound never
  // more than half of what the browser says this site may store.
  async limit() {
    if (this.limitMB !== null && Number.isFinite(this.limitMB)) return this.limitMB * 1048576;
    const configured = Number((await siteConfig()).cacheMB);
    if (configured > 0) return configured * 1048576;
    let bytes = DEFAULT_LIMIT_MB * 1048576;
    try {
      const { quota } = await navigator.storage.estimate();
      if (quota) bytes = Math.min(bytes, quota / 2);
    } catch { /* no estimate: use the default */ }
    return bytes;
  }

  // Makes room for `incoming` more bytes: deletes the games used longest ago
  // until the cache fits its bound. Entries in `keep` and firmware stay.
  // `everything` drops every game not in `keep`, for when storage is full.
  async trim(keep = [], incoming = 0, everything = false) {
    this.loadNotes();
    const entries = this.keys().map((key) => ({ key, ...this.notes[key] })).filter((entry) => !entry.overflow);
    const limit = everything ? 0 : await this.limit();
    let total = entries.reduce((sum, entry) => sum + entry.bytes, 0) + incoming;
    const removed = [];
    for (const entry of entries.filter((item) => item.kind !== 'fw' && !keep.includes(item.key)).sort((a, b) => a.used - b.used)) {
      if (total <= limit) break;
      await this.remove(entry.key);
      total -= entry.bytes;
      removed.push(entry.key);
    }
    return removed;
  }

  // Whether the file stored under `key` has the content `sha256` names. The
  // whole file passes through memory once, so this runs after the game has
  // started, not on the way to it.
  async verify(key, sha256) {
    const note = this.notes[key];
    const blob = note ? await this.place(note).read(note.file) : null;
    if (!blob) return true; // gone already
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('') === sha256.toLowerCase();
  }

  // Deletes files no entry points at: what a closed tab or a lost index left.
  async sweep() {
    this.loadNotes();
    const used = new Set(Object.values(this.notes).map((note) => note.file));
    for (const name of await this.files.names()) {
      if (!used.has(name) && Date.now() - (await this.files.modified(name)) > ORPHAN_MS) await this.files.remove(name);
    }
  }
}

// --- one download ----------------------------------------------------------------

const validHash = (hash) => (hash && Number(hash.bytes) > 0 && /^[0-9a-f]{64}$/i.test(String(hash.sha256)) ? hash : null);

// Makes sure `asset` ({ kind, label, url, expect }) is in the cache and
// resolves to a source for it. `task` is filled in as it goes, for the
// progress line: where the bytes come from ('cache' or 'network'), how many
// have arrived, and how many there will be.
async function fetchAsset(store, asset, task, report, signal, keep, overflow = false) {
  const target = checkedUrl(asset.url, asset.label);
  const expect = validHash(asset.expect);
  target.hash = '';

  // A file whose content is known is asked for by a URL that names the
  // content. The assets Worker may then cache it for good, and so do we.
  if (expect) target.searchParams.set('v', expect.sha256.toLowerCase());
  let key = target.href;
  // Without the manifest (it could not be fetched) a copy kept under a
  // content address is still that file: use it rather than download again.
  const pinned = expect ? key : Downloads.versioned(key);

  const reach = `${target.host}${target.pathname}`;
  const request = { mode: 'cors', credentials: 'omit', signal };
  // The emulator itself and the firmware are needed first; on a connection
  // they share, let the card wait for them. (A hint: browsers without fetch
  // priorities ignore it.)
  if (asset.kind === 'game') request.priority = 'low';

  // With nothing in the index under this URL the answer is known already:
  // ask the server now, rather than after storage has been opened.
  const early = Downloads.noted(pinned || key) ? null : fetch(target, request);
  if (early) early.catch(() => {});
  const downloads = await store;

  const fromCache = () => {
    // Another tab stored it meanwhile: the answer asked for early is not needed.
    if (early) early.then((unused) => unused.body && unused.body.cancel()).catch(() => {});
    task.from = 'cache';
    task.done = true;
    task.total = task.loaded = downloads.source(key).bytes;
    report(true);
    return downloads.source(key);
  };

  if (pinned && (await downloads.lookup(pinned))) {
    key = pinned;
    return fromCache();
  }

  const known = await downloads.lookup(key);
  if (known) {
    if (downloads.fresh(key)) return fromCache();
    // Stale: ask for the file's validators, not the file. A HEAD request
    // needs no CORS preflight, which a conditional GET to another origin
    // would, and Last-Modified is readable across origins.
    let current = true; // if the server cannot be asked, use what we have
    try {
      const head = await fetch(target, { ...request, method: 'HEAD' });
      if (head.ok) {
        if (known.etag) current = head.headers.get('ETag') === known.etag;
        else current = Boolean(known.modified) && head.headers.get('Last-Modified') === known.modified;
        if (current) downloads.touch(key, 'checked');
      }
    } catch (error) {
      if (signal.aborted) throw error;
    }
    if (current) return fromCache();
  }

  let response;
  try {
    response = await (early || fetch(target, request));
  } catch (error) {
    if (signal.aborted) throw error;
    if (known) return fromCache();
    throw new Error(`${asset.label}: could not download ${reach}. The server must be reachable and allow this site (CORS).`);
  }
  if (!response.ok) {
    if (known) return fromCache();
    throw new Error(`${asset.label}: download failed (${response.status})`);
  }

  // Content-Length counts the encoded bytes when the server compresses.
  const length = response.headers.get('Content-Encoding') ? 0 : Number(response.headers.get('Content-Length')) || 0;
  task.from = 'network';
  task.total = expect ? expect.bytes : length;
  task.loaded = 0;
  report(true);

  if (asset.kind === 'game') await downloads.trim(keep(), task.total).catch(() => {});

  const counted = () => response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      task.loaded += chunk.byteLength;
      report(false);
      controller.enqueue(chunk);
    },
  }));
  const validators = { etag: response.headers.get('ETag'), modified: response.headers.get('Last-Modified') };

  try {
    await downloads.write(key, asset.kind, counted(), validators, () => task.loaded, overflow);
  } catch (error) {
    if (signal.aborted) throw error;
    if (error && error.name === 'QuotaExceededError' && !overflow) {
      // Storage is full even after trimming. Drop the other games and fetch
      // again into memory, so the game still starts.
      await downloads.trim(keep(), 0, true).catch(() => {});
      return fetchAsset(store, asset, task, report, signal, keep, true);
    }
    throw new Error(`${asset.label}: the download of ${reach} was interrupted. Check the connection and try again.`);
  }

  if (expect && task.loaded !== expect.bytes) {
    await downloads.remove(key);
    throw new Error(`${asset.label}: the download is not the file the site lists (${task.loaded} bytes instead of ${expect.bytes}).`);
  }

  // An older version of the same file is of no use any more.
  if (expect) {
    for (const other of downloads.keys()) {
      if (other === key) continue;
      const bare = new URL(other);
      bare.searchParams.delete('v');
      const mine = new URL(key);
      mine.searchParams.delete('v');
      if (bare.href === mine.href) await downloads.remove(other);
    }
  }

  task.done = true;
  report(true);
  return downloads.source(key);
}

// --- what to load ----------------------------------------------------------------

let manifestPromise = null;

// <catalog>assets.json, or null when the site has none.
function assetsManifest() {
  if (!manifestPromise) {
    manifestPromise = siteConfig().then(async (config) => {
      if (!config.catalog) return null;
      try {
        const base = config.catalog.endsWith('/') ? config.catalog : `${config.catalog}/`;
        // Always the current list: it is what says a file has changed.
        const response = await fetch(`${base}assets.json`, { cache: 'no-cache' });
        const manifest = response.ok ? await response.json() : null;
        return manifest && typeof manifest === 'object' ? manifest : null;
      } catch {
        return null;
      }
    });
  }
  return manifestPromise;
}

// What the page address asks for: { slug } for ?g=, { fw, game } for ?game=
// (with or without ?fw=), or null.
export function wantedFromParams(params) {
  if (params.get('g')) return { slug: params.get('g'), fw: params.get('fw') || '' };
  if (params.get('game')) return { fw: params.get('fw') || '', game: params.get('game') };
  return null;
}

async function resolveSlug(slug) {
  const config = await siteConfig();
  if (!config.catalog) {
    throw new LoadError('no-catalogue', `This page has no game catalogue, so it cannot look up “${slug}”. Load a game below.`);
  }
  const game = await gameBySlug(slug);
  if (!game) {
    throw new LoadError('unknown-game', `The catalogue has no game called “${slug}”. Load one below, or pick a game from the front page.`);
  }
  const url = await gameUrl(game);
  if (!url) throw new LoadError('unknown-game', `The catalogue does not say where “${game.title || slug}” is downloaded from.`);

  // The manifest describes the site's own copy, not a file hosted elsewhere.
  const own = !(game.zip && /^(https?:)?\/\//.test(game.zip));
  const manifest = own ? await assetsManifest() : null;
  return {
    slug,
    title: game.title || slug,
    uid: game.uid || null,
    gameUrl: url,
    expect: manifest && manifest.games ? validHash(manifest.games[game.slug || slug]) : null,
    label: game.title || slug,
    name: `${slug}.zip`,
  };
}

function resolveUrls(wanted) {
  if (!wanted.game) throw new Error('Enter the URL of a game card dump.');
  const parsed = checkedUrl(wanted.game, 'Game');
  return { slug: null, title: null, uid: null, gameUrl: wanted.game, expect: null, label: 'Game', name: parsed.pathname.split('/').pop() || 'game.zip' };
}

function taskText(task) {
  if (!task || !task.from) return null;
  if (task.from === 'cache') return `${task.label}: already on this device`;
  if (task.done) return `${task.label}: downloaded`;
  if (task.total) return `${task.label}: ${Math.floor((100 * task.loaded) / task.total)}% of ${megabytes(task.total)} MB`;
  return `${task.label}: ${megabytes(task.loaded)} MB`;
}

// Starts fetching what `wanted` names and returns at once:
//   target    resolves to what is being loaded ({ title, uid, gameUrl, ... }),
//             or rejects when the catalogue has no such game
//   firmware  resolves to a source for the firmware, or null when none is
//             named and none is stored
//   card      resolves to a source for the game card
//   summary() entries for the status line, one per file not installed yet
//   installed(kind) says the firmware ('fw') or the game is in the emulator,
//             which takes it off the summary
//   finished() notes that the game was used, trims the cache to its bound
//             and clears out what interrupted downloads left
//   cancel()  stops the downloads
// `downloads` is the promise of the cache; `onProgress` is called (at most
// ten times a second) whenever summary() would say something new;
// `firmware: false` skips the firmware (one is installed already).
export function beginLoad(wanted, { downloads, onProgress = () => {}, firmware: wantFirmware = true }) {
  const controller = new AbortController();
  const tasks = { fw: null, game: null };
  const sources = { fw: null, game: null };
  const hidden = { fw: false, game: false };
  const verify = { fw: null, game: null }; // sha256 each file should have
  const keep = () => [sources.fw, sources.game].filter(Boolean).map((source) => source.key);

  let last = 0;
  let timer = 0;
  const report = (now) => {
    const wait = now ? 0 : 100 - (performance.now() - last);
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => { timer = 0; report(true); }, wait);
      return;
    }
    last = performance.now();
    onProgress();
  };

  const target = Promise.resolve().then(() => (wanted.slug ? resolveSlug(wanted.slug) : resolveUrls(wanted)));

  const firmware = (async () => {
    if (!wantFirmware) return null;
    const url = wanted.fw || (wanted.slug ? await firmwareUrl() : '');
    if (!url) return (await downloads).firmware();
    const manifest = wanted.fw ? null : await assetsManifest();
    if (manifest && validHash(manifest.fw)) verify.fw = manifest.fw.sha256;
    tasks.fw = { label: 'Firmware', from: null, loaded: 0, total: 0, done: false };
    sources.fw = await fetchAsset(downloads, { kind: 'fw', label: 'Firmware', url, expect: manifest && manifest.fw }, tasks.fw, report, controller.signal, keep);
    performance.mark('eka2l1:firmware-fetched');
    return sources.fw;
  })();

  let card = null;
  const fetchCard = () => {
    if (!card) {
      card = (async () => {
        const what = await target;
        if (what.expect) verify.game = what.expect.sha256;
        tasks.game = { label: what.label, from: null, loaded: 0, total: 0, done: false };
        sources.game = await fetchAsset(downloads, { kind: 'game', label: what.label, url: what.gameUrl, expect: what.expect }, tasks.game, report, controller.signal, keep);
        performance.mark('eka2l1:game-fetched');
        return sources.game;
      })();
      card.catch(() => {});
    }
    return card;
  };

  // The card is fetched at once, except when no firmware is in sight (a
  // game address without one, and none kept): then it waits until it is
  // asked for, instead of downloading a card that cannot be started.
  if (!wantFirmware || wanted.fw || wanted.slug) fetchCard();
  else firmware.then((found) => { if (found) fetchCard(); }, () => {});

  // They are awaited later; a failure before that is not an unhandled one.
  for (const promise of [target, firmware]) promise.catch(() => {});

  return {
    wanted,
    tasks,
    target,
    firmware,
    get card() { return fetchCard(); },
    summary: () => ['fw', 'game'].map((kind) => (hidden[kind] ? null : taskText(tasks[kind]))).filter(Boolean),
    installed: (kind) => { hidden[kind] = true; },
    cancel: () => controller.abort(),
    async finished() {
      const cache = await downloads;
      if (sources.game) cache.touch(sources.game.key, 'used');
      await cache.trim(keep()).catch(() => {});
      await cache.sweep().catch(() => {});
      // What was downloaded just now under a content address is checked
      // against it once; a file that is not what its name says is dropped,
      // so the next visit fetches it again.
      for (const kind of ['fw', 'game']) {
        const hash = verify[kind];
        if (!hash || !sources[kind] || tasks[kind].from !== 'network') continue;
        const good = await cache.verify(sources[kind].key, hash).catch(() => true);
        if (!good) {
          console.warn(`${tasks[kind].label}: the stored download does not match its checksum and was discarded`);
          await cache.remove(sources[kind].key);
        }
      }
      performance.mark('eka2l1:cache-trimmed');
    },
  };
}

// A file picked from this device, as a source.
export function fileSource(file) {
  return { key: null, bytes: file.size, open: async () => file.stream() };
}
