// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A diagnostics report (core.js: report()) on its way out of the page: with
// what identifies the visitor taken out (redact), and as text for pasting
// into a message (formatText). Nothing here touches the document, and neither
// function ever throws, so tests can call them and a report always leaves.
//
// Both are generic: they know the report's envelope and nothing about what a
// section keeps in its `data`.

// --- redaction -----------------------------------------------------------------
//
// What is taken out, and how it is found:
//
//   room codes      a text of 5 to 10 capital letters and digits under a key
//                   that ends in "room" ("room", "lastRoom"), in "code" or
//                   "id" after "room" ("roomCode"), under `code` directly
//                   below a key about a room ("room", "rooms", "lobby"), in a
//                   list under "rooms", and after "/room/" in an address; and
//                   the room named in the page's own address
//   names           of players and of the device: a key like playerName,
//                   deviceName, btName, hostName, nick, username; a `name`
//                   (or `player`, `peer`, `member`, `host`) directly below a
//                   key about people or the link (peer, player, member, self,
//                   link, room, lobby, bluetooth, bt, net, network,
//                   multiplayer); the texts of a list or map of peers,
//                   players or members, and the keys of such a map that are
//                   not numbers. A "host" that is an address is not a name
//   the same again  every room code and name found that way is also taken
//                   out of every other text of the report, in either case
//                   (an error message that quotes it, a finding that names a
//                   player)
//   Bluetooth       aa:bb:cc:dd:ee:ff, wherever it stands
//   addresses
//   queries         what follows "?name=" or "#name=" in any text, all that
//                   follows "?" or "#" in an address with a scheme, and the
//                   user and password before its host
//   home folders    the user's name in /home/<name>/, /Users/<name>/ and
//                   C:\Users\<name>\, except in the path of a web address
//
// Each is replaced by a placeholder that says what stood there, and the same
// value gets the same placeholder ("(name 1)"), so that a reader still sees
// which peer is which. The report's `redacted` field counts what was taken.
//
// What stays, because it is what the report is for: the user agent, the
// GPU's name, the game, the page's address without its query, the host and
// path of every other address, and the paths of the guest's own drives.

const PLACE = { room: 'room code', name: 'name', address: 'address' };

// Keys about people and the link to them: a `name` directly under one of
// these is a player's or the device's.
const PEOPLE = new Set(['peer', 'peers', 'player', 'players', 'member', 'members', 'self', 'link', 'room', 'rooms', 'lobby',
  'bluetooth', 'bt', 'net', 'network', 'multiplayer']);
// Keys that hold several people: their strings are names.
const CROWD = new Set(['peers', 'players', 'members']);
const ROOMS = new Set(['room', 'rooms', 'lobby']);
// What may stand before "name" in a key for it to be a person's or the device's.
const NAMED = new Set(['player', 'device', 'peer', 'user', 'nick', 'friendly', 'bt', 'bluetooth', 'own', 'self', 'my', 'local',
  'remote', 'member', 'phone', 'host']);
// Keys that are a name by themselves. Not "hostname": that is an address's.
const NAME_KEYS = new Set(['nick', 'nickname', 'username', 'playername', 'devicename', 'alias']);
// Keys that are a name when they stand below a key about people ("player"
// below "audio" is the program that plays).
const NAME_BELOW = new Set(['name', 'names', 'player', 'peer', 'member', 'host']);
// "host" is the player who hosts, or the machine an address names: this is
// the second, and stays.
const HOST_ADDRESS = /^(localhost|[\w-]+(\.[\w-]+)+|\[[0-9a-f:]+\])(:\d+)?$|:\/\//i;
// Containers that say nothing about what is in them.
const NEUTRAL = new Set(['data', 'value', 'values', 'list', 'items', 'info', 'state']);
// Texts that are never searched for a name found elsewhere: a player called
// "Chrome" must not cost the report its browser.
const KEPT = new Set(['useragent', 'renderer', 'vendor', 'gpu', 'unmaskedrenderer', 'unmaskedvendor']);

// A code, not a word of the page: "OPEN" and "full" are states.
const ROOM_SHAPE = /^[A-Z0-9]{5,10}$|^(?=.{6,11}$)[A-Z0-9]{2,5}[- ][A-Z0-9]{2,5}$/;
const ROOM_IN_PATH = /(\/room\/)([A-Z0-9]{5,10})(?![A-Za-z0-9-])/g;
const BLUETOOTH = /\b[0-9A-Fa-f]{2}([:-])(?:[0-9A-Fa-f]{2}\1){4}[0-9A-Fa-f]{2}\b/g;
const ADDRESS = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+/gi;
const QUERY = /([?#])[A-Za-z0-9_.~%-]+=[^\s"'<>]*/g;
// A web address as a whole (left alone), or a home folder: its name up to
// the next slash, or up to a space when none follows.
const HOME = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'<>`]+|(\/home\/|\/Users\/|[A-Za-z]:[\\/]+Users[\\/]+|[A-Za-z]:[\\/]+Documents and Settings[\\/]+)(?:[^\\/"'<>:\n]+(?=[\\/])|[^\\/\s"'<>:]+)/gi;
const PLACED = /(\((?:room code|name|address) \d+\))/;
const SHORTEST_SECRET = 3; // a shorter name is not searched for in other texts
const DEEPEST = 60;

// "playerName", "player_name", "player-name" and "PlayerName" are all
// [player, name], and "BTName" is [bt, name].
function words(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

const hasAny = (list, set) => list.some((word) => set.has(word));
const cleanRoom = (text) => String(text).toUpperCase().replace(/[\s-]/g, '');
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isNameKey(list) {
  if (list.length === 1) return NAME_KEYS.has(list[0]);
  const last = list[list.length - 1];
  return (last === 'name' || last === 'names') && NAMED.has(list[list.length - 2]);
}

// A key that holds a room: "room", "lastRoom", "roomCode", "room_id".
function isRoomKey(list) {
  const last = list[list.length - 1];
  return last === 'room' || last === 'rooms' || ((last === 'code' || last === 'id') && list.includes('room'));
}

// Where a value stands, as far as the rules care:
//   key, words   its key and the words of it (an item of a list has the list's)
//   upper        the words of the nearest key above that says something
//   crowd        it is one of the strings of a list or map of people
//   item         it is an item of a list
const TOP = { key: '', words: [], upper: [], crowd: false, item: false, depth: 0 };

function inside(context, key) {
  const neutral = !context.words.length || context.words.every((word) => NEUTRAL.has(word));
  return { key, words: words(key), upper: neutral ? context.upper : context.words, crowd: false, item: false, depth: context.depth + 1 };
}

// Calls visit(item, context, key, named) for everything in a list or an
// object; `named` says that the key itself is a person's name.
function each(value, context, visit) {
  // A key that says nothing ("list", "data") below "peers" is still about them.
  const crowd = hasAny(context.words, CROWD) || (context.words.length > 0 && context.words.every((word) => NEUTRAL.has(word)) && hasAny(context.upper, CROWD));
  if (Array.isArray(value)) {
    for (const item of value) visit(item, { ...context, crowd: crowd && typeof item === 'string', item: true, depth: context.depth + 1 });
  } else if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    // Under "peers" an object can be a map: of ids to names ({ "2": "Sam" },
    // when every value is a text or nothing), or of ids or names to peers
    // ({ "2": { name: "Sam" } }, { "Sam": { score: 3 } }). There a key is no
    // more a key than the place in a list is, and one that is not a number
    // is taken for a name.
    const map = crowd && !context.item;
    const names = map && entries.some(([, item]) => typeof item === 'string') && entries.every(([, item]) => item === null || typeof item === 'string');
    for (const [key, item] of entries) {
      if (map && item !== null && typeof item === 'object' && !Array.isArray(item)) visit(item, { ...context, crowd: false, item: true, depth: context.depth + 1 }, key, !/^\d+$/.test(key));
      else visit(item, { ...inside(context, key), crowd: names && typeof item === 'string' }, key, false);
    }
  }
}

// 'room' or 'name' when the place a text stands in says it is one, else null.
function whatIs(text, context) {
  const own = context.words;
  const only = own.length === 1 ? own[0] : null;
  if ((isRoomKey(own) || (only === 'code' && hasAny(context.upper, ROOMS))) && ROOM_SHAPE.test(text.trim())) return 'room';
  if (context.crowd) return 'name';
  const named = isNameKey(own) || (only !== null && NAME_BELOW.has(only) && hasAny(context.upper, PEOPLE));
  if (named && own.includes('host') && HOST_ADDRESS.test(text.trim())) return null;
  return named ? 'name' : null;
}

class Redactor {
  constructor() {
    this.found = { room: new Map(), name: new Map(), address: new Map() };
    this.queries = 0;
    this.homes = 0;
    this.search = [];
    this.open = new Set(); // the objects being walked through, outermost first
  }

  // The placeholder for a value, the same one every time.
  place(kind, value) {
    const id = kind === 'room' ? cleanRoom(value) : kind === 'address' ? value.toLowerCase().replace(/-/g, ':') : value;
    const known = this.found[kind];
    if (!known.has(id)) known.set(id, `(${PLACE[kind]} ${known.size + 1})`);
    return known.get(id);
  }

  // What the page's own address says: the room it was opened for.
  learnAddress(address) {
    if (typeof address !== 'string') return;
    for (const part of address.split(/[?#&]/).slice(1)) {
      const at = part.indexOf('=');
      if (at < 1) continue;
      let value = part.slice(at + 1);
      try {
        value = decodeURIComponent(value.replace(/\+/g, ' '));
      } catch (error) {
        // Not an encoded value: taken as it stands.
      }
      const name = words(part.slice(0, at));
      if (isRoomKey(name) && /^[A-Z0-9]{5,10}$/.test(cleanRoom(value))) this.place('room', value);
      else if (value.trim() && (isNameKey(name) || (name.length === 1 && name[0] === 'name'))) this.place('name', value.trim());
    }
  }

  // First pass: finds the room codes and names, so that the second can take
  // them out wherever else they stand. It is also where a report that holds
  // itself is noticed: that one cannot be copied.
  learn(value, context) {
    if (context.depth > DEEPEST) return;
    if (typeof value === 'string') {
      const kind = whatIs(value, context);
      if (kind && value.trim()) this.place(kind, value.trim());
      for (const match of value.matchAll(ROOM_IN_PATH)) this.place('room', match[2]);
      return;
    }
    if (value === null || typeof value !== 'object') return;
    if (this.open.has(value)) throw new Error('the report holds itself');
    this.open.add(value);
    each(value, context, (item, inner, key, named) => {
      if (named && key.trim()) this.place('name', key);
      this.learn(item, inner);
    });
    this.open.delete(value);
  }

  // What finds the room codes and the names in any text: one pattern for
  // each kind, the longest value first, and where its placeholder is. Both
  // are found in either case. A room code must stand as a word of its own; a
  // name may have digits beside it and a number in hexadecimal before it,
  // because a game puts its own mark before the player's name ("101FD3FASam").
  searchFor() {
    const longest = (kind) => [...this.found[kind].keys()].filter((value) => value.length >= SHORTEST_SECRET).sort((p, q) => q.length - p.length);
    const search = [];
    const rooms = longest('room').map((value) => value.split('').map(escapeRegExp).join('[\\s-]?'));
    if (rooms.length) search.push({ pattern: new RegExp(`(^|[^\\p{L}\\p{N}])(${rooms.join('|')})(?![\\p{L}\\p{N}])`, 'giu'), place: (text) => this.found.room.get(cleanRoom(text)) });
    const names = longest('name');
    const lower = new Map(names.map((value) => [value.toLowerCase(), this.found.name.get(value)]));
    if (names.length) search.push({ pattern: new RegExp(`(^|[^\\p{L}]|[0-9][0-9A-Fa-f]*)(${names.map(escapeRegExp).join('|')})(?![\\p{L}])`, 'giu'), place: (text) => lower.get(text.toLowerCase()) });
    return search;
  }

  // The shapes that are taken out wherever they stand. Addresses first: a
  // placeholder has spaces, and an address ends at one.
  shapes(text) {
    let out = text.replace(ADDRESS, (address) => {
      const tail = /[).,;:!]+$/.exec(address);
      let body = tail ? address.slice(0, tail.index) : address;
      body = body.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#@]*@/i, '$1');
      const cut = body.search(/[?#]/);
      if (cut >= 0) {
        this.queries++;
        body = `${body.slice(0, cut + 1)}(removed)`;
      }
      return body + (tail ? tail[0] : '');
    });
    out = out.replace(QUERY, (all, mark) => {
      this.queries++;
      return `${mark}(removed)`;
    });
    out = out.replace(ROOM_IN_PATH, (all, lead, code) => lead + this.place('room', code));
    out = out.replace(BLUETOOTH, (address) => this.place('address', address));
    out = out.replace(HOME, (all, lead) => {
      if (lead === undefined) return all;
      this.homes++;
      return `${lead}(user)`;
    });
    return out;
  }

  // A text without what must not leave. `kept` texts (the user agent, the
  // GPU's name) are not searched for the names found elsewhere.
  text(value, context, kept) {
    const kind = whatIs(value, context);
    if (kind && value.trim()) return this.place(kind, value.trim());
    const out = this.shapes(value);
    if (kept) return out;
    // Not inside a placeholder: a player may be called "name".
    return this.search.reduce((text, { pattern, place }) => text.split(PLACED).map((part, index) => (index % 2 ? part
      : part.replace(pattern, (all, lead, found) => lead + (place(found) || '(removed)')))).join(''), out);
  }

  // Second pass: the copy without what was found.
  copy(value, context, path) {
    if (context.depth > DEEPEST) return null;
    if (typeof value === 'string') return isEnvelope(path) ? value : this.text(value, context, KEPT.has(context.words.join('')));
    if (Array.isArray(value)) {
      const out = [];
      each(value, context, (item, inner) => out.push(this.copy(item, inner, [...path, out.length])));
      return out;
    }
    if (value !== null && typeof value === 'object') {
      const out = {};
      const inData = path.length >= 3 && path[0] === 'sections' && path[2] === 'data';
      each(value, context, (item, inner, key) => {
        // A key can be a room code or a name too: { "ABCDEF": {...} }.
        let name = (inData && (this.found.room.get(cleanRoom(key)) || this.found.name.get(key))) || key;
        while (Object.prototype.hasOwnProperty.call(out, name)) name += "'";
        // Defined, not assigned: a key "__proto__" must stay a key.
        Object.defineProperty(out, name, { value: this.copy(item, inner, [...path, key]), enumerable: true, writable: true, configurable: true });
      });
      return out;
    }
    return value;
  }
}

// The parts of the envelope that are the format's own words or the game's:
// they are copied as they are, whatever a player is called.
function isEnvelope(path) {
  if (path.length === 1) return path[0] === 'kind' || path[0] === 'generated';
  if (path[0] === 'game') return true;
  if (path[0] === 'findings') return path.length === 3 && ['code', 'level', 'section'].includes(path[2]);
  if (path[0] === 'sections') return path.length >= 3 && (path[2] === 'title' || path[2] === 'findings');
  return false;
}

// When redaction itself fails, nothing that was not looked at may leave: the
// report is then the envelope alone. Not even the error's message goes with
// it, unless it is one of this file's own: a message can quote what it
// choked on.
const FAILURES = ['not a report', 'the report holds itself'];

function bare(report, error) {
  const message = String(error && error.message ? error.message : error);
  const out = {
    kind: 'eka2l1-web-diagnostics',
    v: 1,
    generated: new Date().toISOString(),
    page: { address: '', hidden: false },
    game: null,
    session: { upS: null, running: false, paused: false, emulatorAnswers: false, samples: 0, measuredS: 0 },
    findings: [],
    sections: {},
    series: { t: [], fps: [], running: [], hidden: [] },
    redacted: { failed: FAILURES.includes(message) ? message : String((error && error.name) || 'error').slice(0, 40) },
  };
  // What is true of the session and cannot identify anyone is kept, so that
  // the envelope does not say "no game" of a game that ran: the numbers and
  // switches of the session, and the game, which is the envelope's own.
  try {
    const from = report !== null && typeof report === 'object' ? report : {};
    if (Number.isInteger(from.v)) out.v = from.v;
    if (typeof from.generated === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]{1,20}Z$/.test(from.generated)) out.generated = from.generated;
    const session = from.session !== null && typeof from.session === 'object' ? from.session : {};
    for (const name of ['running', 'paused', 'emulatorAnswers']) {
      if (typeof session[name] === 'boolean') out.session[name] = session[name];
    }
    if (Number.isInteger(session.upS) && session.upS >= 0) out.session.upS = session.upS;
    const game = from.game;
    if (game !== null && typeof game === 'object' && typeof game.name === 'string' && (typeof game.uid === 'string' || Number.isInteger(game.uid))) {
      out.game = { uid: typeof game.uid === 'string' ? game.uid.slice(0, 40) : game.uid, name: game.name.slice(0, 200), slug: typeof game.slug === 'string' ? game.slug.slice(0, 80) : null };
    }
  } catch (failure) {
    // Then it stays as bare as it was.
  }
  return out;
}

// Returns a copy of the report without anything that should not leave the
// browser (the list is at the top of this part). `options.address` is the
// page's address, where the room it was opened for is read from; left out, it
// is the address of the page this runs in.
export function redact(report, options = {}) {
  try {
    if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('not a report');
    const redactor = new Redactor();
    const address = options.address !== undefined ? options.address : (typeof location === 'object' && location ? location.href : null);
    redactor.learnAddress(address);
    redactor.learn(report, TOP);
    redactor.search = redactor.searchFor();
    const out = redactor.copy(report, TOP, []);
    out.redacted = {
      roomCodes: redactor.found.room.size,
      names: redactor.found.name.size,
      bluetoothAddresses: redactor.found.address.size,
      addressQueries: redactor.queries,
      homeFolders: redactor.homes,
    };
    return out;
  } catch (error) {
    return bare(report, error);
  }
}

// --- the text form ---------------------------------------------------------------
//
//   EKA2L1 web diagnostics v1 | <when> | <game> | <browser>
//   Session: <state, time up, samples, the stretch measured>. Page: <address>.
//
//   Findings (2), worst first:
//   [bad] cpu-bound (speed): <title>
//       <detail>
//       What to do: <advice>
//
//   == <Section title> [<id>] ==
//   <name>: <value>              one line per value of the section's data;
//   <name>.<inner>: <value>      what is nested gets a path, a small object
//   <list>[0]: a=1, b=2          one line, a long list its size and its end,
//   <log>[41]: <a line>          a list of long texts a line for each
//
//   == Series: <n> samples, one a second, oldest first ==
//   fps: 19.8 20 ...
//
//   == End of report ... ==
//
// The text is for reading. It is cut to TEXT_LIMIT characters, the least
// useful first (long values, then the series, then the numbers of sections
// without a finding, then of those with one), and says what was cut. Whoever gets it
// can still read it back loosely: the site's repository has a reader
// (tools/web/diagreport.mjs) that takes this text as well as the file. It
// carries a copy of the code between the two marks below, and its tests fail
// when the two differ: change both.

// >>> the text form, shared with the reader
export const TEXT_LIMIT = 20000;

const TEXT_HEAD = 'EKA2L1 web diagnostics';
const TEXT_END = '== End of report (text for reading; "Download report" saves the file with everything) ==';

const isLeaf = (value) => value === null || typeof value !== 'object';
const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

function oneLine(text) {
  return String(text).replace(/\s*[\r\n]+\s*/g, ' / ').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

export function showNumber(value) {
  if (!Number.isFinite(value)) return '-';
  if (Number.isInteger(value)) return String(value);
  const size = Math.abs(value);
  return String(Number(size >= 100 ? value.toFixed(1) : size >= 1 ? value.toFixed(2) : value.toPrecision(3)));
}

function showLeaf(value, longest) {
  if (value === null || value === undefined) return '-';
  if (value === true) return 'yes';
  if (value === false) return 'no';
  if (typeof value === 'number') return showNumber(value);
  const text = oneLine(value);
  if (text === '') return '""';
  return text.length > longest ? `${text.slice(0, longest)}… (+${text.length - longest} characters)` : text;
}

// A text that is a line's whole value: quoted when it could be read back as
// something else (a small object, a list of numbers, a list's size).
const READS_AS = /^[A-Za-z_$][\w$-]*=|^-?\d[^,]*(, -?\d[^,]*)+$|^"|^\d+ (values|items)\b|^\((none|empty)\)$/;

function showLine(value, longest) {
  const text = showLeaf(value, longest);
  return typeof value === 'string' && text !== '""' && READS_AS.test(text) ? JSON.stringify(text) : text;
}

// A value inside a line that holds several: quoted when it could be taken
// for the line's own punctuation.
function showInline(value, longest) {
  const text = showLeaf(value, longest);
  return typeof value === 'string' && text !== '""' && /[,="]|^\s|\s$/.test(text) ? JSON.stringify(text) : text;
}

function numberStats(list) {
  const numbers = list.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (!numbers.length) return null;
  return {
    count: numbers.length,
    min: numbers.reduce((a, b) => Math.min(a, b)),
    mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    max: numbers.reduce((a, b) => Math.max(a, b)),
  };
}

function showList(list, detail) {
  const shown = list.length > detail.values ? list.slice(-detail.values) : list;
  const text = shown.map((value) => showInline(value, Math.min(detail.strings, 80))).join(', ');
  if (shown.length === list.length) return text;
  const stats = list.every((value) => typeof value === 'number') ? numberStats(list) : null;
  return `${list.length} values${stats ? `, min ${showNumber(stats.min)}, mean ${showNumber(stats.mean)}, max ${showNumber(stats.max)}` : ''}`
    + `; the last ${shown.length}: ${text}`;
}

// A list of plain values is one line, unless it holds texts that are too
// long for that (the lines of a log): then each is a line of its own, and of
// a long list the last ones, which are the newest.
function listInLines(list, detail) {
  return list.some((value) => typeof value === 'string' && value.length > 60)
    || (list.some((value) => typeof value === 'string') && showList(list, detail).length > 200);
}

function listLines(name, list, detail, out) {
  if (!listInLines(list, detail)) {
    out.push(`${name}: ${showList(list, detail)}`);
    return;
  }
  const from = Math.max(0, list.length - detail.items);
  if (from > 0) out.push(`${name}: ${list.length} values; the last ${list.length - from}:`);
  for (let i = from; i < list.length; i++) out.push(`${name}[${i}]: ${showLine(list[i], detail.strings)}`);
}

// The lines of one value of a section's data. `detail` is how much is shown:
// { strings, values, items }, the longest text, the most values of a list of
// plain values, the most items of a list of objects.
function dataLines(path, value, detail, out, depth = 0) {
  const name = path || 'value';
  if (isLeaf(value) || depth > 40) {
    out.push(`${name}: ${isLeaf(value) ? showLine(value, detail.strings) : '(nested too deep)'}`);
  } else if (Array.isArray(value)) {
    if (!value.length) {
      out.push(`${name}: (none)`);
    } else if (value.every(isLeaf)) {
      listLines(name, value, detail, out);
    } else {
      const head = value.length > detail.items ? Math.min(2, detail.items - 1) : value.length;
      const tail = value.length > detail.items ? detail.items - head : 0;
      for (let i = 0; i < head; i++) dataLines(`${name}[${i}]`, value[i], detail, out, depth + 1);
      if (value.length > detail.items) out.push(`${name}: ${value.length} items, ${value.length - head - tail} left out here`);
      for (let i = value.length - tail; i < value.length; i++) dataLines(`${name}[${i}]`, value[i], detail, out, depth + 1);
    }
  } else {
    const entries = Object.entries(value);
    if (!entries.length) {
      out.push(`${name}: (empty)`);
      return;
    }
    if (path && entries.length <= 8 && entries.every(([key, item]) => isLeaf(item) && /^[A-Za-z_$][\w$-]*$/.test(key))) {
      const inline = entries.map(([key, item]) => `${key}=${showInline(item, detail.strings)}`).join(', ');
      if (inline.length <= 140) {
        out.push(`${path}: ${inline}`);
        return;
      }
    }
    for (const [key, item] of entries) dataLines(path ? `${path}.${key}` : key, item, detail, out, depth + 1);
  }
}

// "Chrome 131 on Linux" from a user agent; the whole of it is in the report.
export function browserName(userAgent) {
  if (typeof userAgent !== 'string' || !userAgent.trim()) return 'unknown browser';
  const version = (pattern) => {
    const match = pattern.exec(userAgent);
    return match ? match[1] : null;
  };
  const browsers = [['Edge', /Edg(?:e|A|iOS)?\/(\d+)/], ['Opera', /OPR\/(\d+)/], ['Firefox', /(?:Firefox|FxiOS)\/(\d+)/],
    ['Chrome', /(?:HeadlessChrome|Chrome|CriOS)\/(\d+)/], ['Safari', /Version\/(\d+)[\d.]* .*Safari/]];
  const systems = [['Android', /Android/], ['iOS', /iPhone|iPad|iPod/], ['Windows', /Windows/], ['ChromeOS', /CrOS/], ['macOS', /Mac OS X|Macintosh/], ['Linux', /Linux|X11/]];
  const browser = browsers.map(([name, pattern]) => [name, version(pattern)]).find(([, found]) => found);
  const system = systems.find(([, pattern]) => pattern.test(userAgent));
  if (!browser) return oneLine(userAgent).slice(0, 80);
  return `${browser[0]} ${browser[1]}${/HeadlessChrome\//.test(userAgent) ? ' (headless)' : ''}${system ? ` on ${system[0]}` : ''}`;
}

// The first text under a key of this name, wherever a section keeps it.
function findText(value, key, depth = 0) {
  if (value === null || typeof value !== 'object' || depth > 8) return null;
  if (!Array.isArray(value) && typeof value[key] === 'string') return value[key];
  for (const item of Object.values(value)) {
    const found = findText(item, key, depth + 1);
    if (found) return found;
  }
  return null;
}

function gameName(game) {
  if (game === null || typeof game !== 'object') return 'no game';
  const uid = typeof game.uid === 'number' ? `0x${game.uid.toString(16).toUpperCase().padStart(8, '0')}` : game.uid ? String(game.uid) : null;
  const tag = [game.slug, uid ? `uid ${uid}` : null].filter(Boolean).join(', ');
  return `${oneLine(game.name || game.slug || 'a game without a name')}${tag ? ` (${tag})` : ''}`;
}

function headLines(report) {
  const session = report.session !== null && typeof report.session === 'object' ? report.session : {};
  const page = report.page !== null && typeof report.page === 'object' ? report.page : {};
  const sections = report.sections !== null && typeof report.sections === 'object' ? report.sections : {};
  const lines = [[`${TEXT_HEAD} v${showLeaf(report.v, 10)}`, showLeaf(report.generated, 40), gameName(report.game),
    browserName(findText(sections.browser, 'userAgent') || findText(sections, 'userAgent'))].join(' | ')];
  const state = session.running ? 'running' : session.paused ? 'paused' : report.game ? 'not running' : 'no game running';
  lines.push(`Session: ${state}, up ${showLeaf(session.upS, 10)} s, ${showLeaf(session.samples, 10)} samples, rates measured over ${showLeaf(session.measuredS, 10)} s of play.`
    + ` Page: ${showLeaf(page.address, 200)}${page.hidden ? ' (in the background)' : ''}.`);
  if (session.emulatorAnswers === false) lines.push("The emulator's own counters are missing: this build does not have them.");
  const taken = report.redacted !== null && typeof report.redacted === 'object' ? report.redacted : null;
  if (taken && taken.failed) {
    lines.push(`Everything but this head was taken out, because what identifies the visitor could not be removed (${showLeaf(taken.failed, 80)}).`);
  } else if (taken) {
    const parts = [[taken.roomCodes, 'room code', 'room codes'], [taken.names, 'name', 'names'], [taken.bluetoothAddresses, 'Bluetooth address', 'Bluetooth addresses'],
      [taken.addressQueries, 'address query', 'address queries'], [taken.homeFolders, 'home folder', 'home folders']]
      .filter(([count]) => count > 0).map(([count, one, many]) => `${count} ${count === 1 ? one : many}`);
    if (parts.length) lines.push(`Taken out before this left the browser: ${parts.join(', ')}.`);
  }
  return lines;
}

// `depth`: 'full', 'brief' (no advice) or 'titles'.
function findingLines(findings, depth) {
  const list = Array.isArray(findings) ? findings.filter((finding) => finding !== null && typeof finding === 'object') : [];
  if (!list.length) return ['Findings: none.'];
  const lines = [`Findings (${list.length}), worst first:`];
  for (const finding of list) {
    lines.push(`[${showLeaf(finding.level, 10)}] ${showLeaf(finding.code, 60)} (${showLeaf(finding.section, 30)}): ${showLeaf(finding.title, 300)}`);
    if (depth !== 'titles' && finding.detail) lines.push(`    ${showLeaf(finding.detail, 1000)}`);
    if (depth === 'full' && finding.advice) lines.push(`    What to do: ${showLeaf(finding.advice, 1000)}`);
  }
  return lines;
}

function sectionLines(id, section, detail, dropped) {
  const part = section !== null && typeof section === 'object' ? section : {};
  const lines = [`== ${showLeaf(part.title || id, 80)} [${id}] ==`];
  if (part.error) lines.push(`(this part failed: ${showLeaf(part.error, 300)})`);
  if (dropped) lines.push('(numbers left out to fit)');
  else if (part.data !== null && part.data !== undefined) dataLines('', part.data, detail, lines);
  return lines;
}

// One list of the series. `keep` is how many of its last values are shown;
// 0 leaves only what sums it up.
function seriesLine(name, list, keep) {
  if (!Array.isArray(list)) return `${name}: ${showLeaf(list, 100)}`;
  if (!list.length) return `${name}: (none)`;
  const stats = numberStats(list);
  if (name === 't' && stats) {
    const gaps = [];
    for (let i = 1; i < list.length; i++) {
      if (typeof list[i] === 'number' && typeof list[i - 1] === 'number' && list[i] - list[i - 1] > 1.5) gaps.push(`${showNumber(list[i] - list[i - 1])} s after ${showNumber(list[i - 1])} s`);
    }
    return `t: ${showNumber(stats.min)} to ${showNumber(stats.max)} s${gaps.length ? `; gaps: ${gaps.slice(0, 12).join(', ')}${gaps.length > 12 ? `, and ${gaps.length - 12} more` : ''}` : ''}`;
  }
  if (list.every((value) => value === 0 || value === 1)) {
    // Runs: "1x90 0x6" is ninety ones, then six zeros.
    const runs = [];
    for (const value of list) {
      if (runs.length && runs[runs.length - 1][0] === value) runs[runs.length - 1][1]++;
      else runs.push([value, 1]);
    }
    const shown = keep > 0 ? runs.slice(-Math.max(keep, 8)) : runs.slice(-8);
    return `${name}: ${shown.length < runs.length ? `(the last ${shown.length} of ${runs.length} runs) ` : ''}${shown.map(([value, count]) => `${value}x${count}`).join(' ')}`;
  }
  const summary = stats ? `${list.length} values, min ${showNumber(stats.min)}, mean ${showNumber(stats.mean)}, max ${showNumber(stats.max)}` : `${list.length} values`;
  if (keep <= 0) return `${name}: ${summary}`;
  const shown = list.slice(-keep);
  const values = shown.map((value) => showInline(value, 20)).join(' ');
  return shown.length < list.length ? `${name}: ${summary}; the last ${shown.length}: ${values}` : `${name}: ${values}`;
}

function seriesLines(series, keep) {
  if (series === null || typeof series !== 'object' || Array.isArray(series)) return [];
  const names = Object.keys(series);
  if (!names.length) return [];
  const count = names.reduce((most, name) => Math.max(most, Array.isArray(series[name]) ? series[name].length : 0), 0);
  return [`== Series: ${plural(count, 'sample')}, one a second, oldest first ==`, ...names.map((name) => seriesLine(name, series[name], keep))];
}

function render(report, shape) {
  const sections = report.sections !== null && typeof report.sections === 'object' && !Array.isArray(report.sections) ? report.sections : {};
  const blocks = [headLines(report), findingLines(report.findings, shape.findings)];
  for (const [id, section] of Object.entries(sections)) blocks.push(sectionLines(id, section, shape, shape.dropped.has(id)));
  const series = seriesLines(report.series, shape.series);
  if (series.length) blocks.push(series);
  const tail = shape.cut.length ? [`Cut to fit ${shape.limit} characters: ${shape.cut.join('; ')}. The downloaded report has everything.`, TEXT_END] : [TEXT_END];
  blocks.push(tail);
  return `${blocks.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

// The report as text for a message, at most `limit` characters long.
export function formatText(report, most = TEXT_LIMIT) {
  const limit = typeof most === 'number' && !Number.isNaN(most) ? most : TEXT_LIMIT;
  try {
    if (report === null || typeof report !== 'object' || Array.isArray(report)) throw new Error('not a report');
    const shape = { strings: 400, values: 30, items: 12, series: Infinity, findings: 'full', dropped: new Set(), cut: [], limit };
    let text = render(report, shape);
    if (text.length <= limit) return text;

    Object.assign(shape, { strings: 160, values: 12, items: 6, series: 30, cut: ['long values and lists are shortened'] });
    text = render(report, shape);
    if (text.length <= limit) return text;

    Object.assign(shape, { strings: 100, values: 6, items: 4, series: 0, cut: ['long values and lists are shortened', 'the series is summed up'] });
    text = render(report, shape);
    if (text.length <= limit) return text;

    // The numbers of whole sections: first of those no finding came from.
    // Of them the smallest that is enough goes, or else the largest.
    const sections = report.sections !== null && typeof report.sections === 'object' && !Array.isArray(report.sections) ? report.sections : {};
    const whole = Object.entries(sections).map(([id, section]) => ({
      id,
      title: showLeaf((section && section.title) || id, 80),
      found: Boolean(section && Array.isArray(section.findings) && section.findings.length),
      size: sectionLines(id, section, shape, false).join('\n').length,
    })).sort((p, q) => p.size - q.size);
    const base = shape.cut;
    const left = [];
    const notes = () => [...base, ...(left.length ? [`the numbers of ${left.join(', ')} are left out`] : [])];
    for (const found of [false, true]) {
      const candidates = whole.filter((entry) => entry.found === found);
      while (candidates.length) {
        const enough = candidates.findIndex((entry) => entry.size >= text.length - limit + 100);
        const [entry] = candidates.splice(enough >= 0 ? enough : candidates.length - 1, 1);
        shape.dropped.add(entry.id);
        left.push(entry.title);
        shape.cut = notes();
        text = render(report, shape);
        if (text.length <= limit) return text;
      }
    }
    for (const [depth, note] of [['brief', 'the advice of the findings is left out'], ['titles', 'the findings are their titles only']]) {
      shape.findings = depth;
      shape.cut = [...notes(), note];
      text = render(report, shape);
      if (text.length <= limit) return text;
    }
    // Still too long (hundreds of findings, or a tiny limit): the end goes.
    const tail = `\n\nCut to fit ${limit} characters: ${[...shape.cut, 'the end is cut off'].join('; ')}. The downloaded report has everything.\n${TEXT_END}\n`;
    const kept = text.slice(0, Math.max(0, limit - tail.length));
    return limit > 0 ? (kept.slice(0, Math.max(kept.lastIndexOf('\n'), 0)) + tail).slice(-limit) : '';
  } catch (error) {
    return `${TEXT_HEAD}: the report could not be written as text (${String(error && error.message ? error.message : error).slice(0, 200)}). Use "Download report".\n`;
  }
}
// <<< the text form, shared with the reader
