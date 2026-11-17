// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Multiplayer: a room of up to eight players whose emulators exchange frames.
// A game hosts and joins over Bluetooth; the emulator turns that into opaque
// frames addressed to room members, and this file carries them.
//
// Three layers, each knowing only the one below:
//   Session         binds a room to the wasm module and keeps what the page
//                   shows (code, players, state, the last error)
//   Transport       the interface below: a room and frames, nothing else
//   RelayTransport  that interface over a WebSocket to the site's room relay
//
// The emulator's side is three exported functions and one callback:
//   _eka2l1_web_net_link(selfId, name)      0 = the link is down
//   _eka2l1_web_net_peer(peerId, present)   a room member came (1) or went (0)
//   _eka2l1_web_net_receive(src, ptr, len)  one frame from a member
//   Module.eka2l1OnNetSend(dst, bytes)      one frame to a member (0 = all)
// A build without them is detected (supported()) and keeps working.

import { siteConfig } from './catalog.js';

// --- the transport interface -------------------------------------------------------
//
// A transport takes a player into one room and moves frames between its
// members. Ids are whole numbers from 1 to 255, unique within the room.
//
//   connect({ room, name, create, game, public })
//       Enter the room `room` under `name`. `create` makes the room (for
//       `game`, listed when `public`), otherwise the room must exist. Answers
//       arrive as events; connect() itself returns nothing.
//   close()
//       Leave. No event follows.
//   send(dst, bytes)
//       One frame of 1 to MAX_FRAME bytes to the member `dst`, or to every
//       other member when `dst` is 0. Frames of one sender arrive in order.
//       Returns false when the frame could not be handed over (not connected).
//   setPublic(value)
//       Ask for the room to be listed or not; only its creator is obeyed.
//   events
//       An object of callbacks the owner assigns; each is optional.
//         hello({ id, room, game, public, max, peers: [{ id, name }] })
//             In the room, as member `id`. Comes again, with a new id, after
//             every reconnection.
//         join({ id, name })   a member came
//         leave(id)            a member went
//         frame(src, bytes)    a frame from member `src`; `bytes` is a
//                              Uint8Array the receiver may keep
//         public(value)        the listing changed
//         lost({ attempt, delay })
//             The connection dropped and the transport is trying again in
//             `delay` ms, for the `attempt`th time. Every member is gone
//             until the next hello.
//         closed({ code, message })
//             Out of the room for good. `code` is one of ERROR_CODES.
//
// A second transport (WebRTC is the one planned) has to provide exactly this:
// room membership with stable small ids, ordered frames per sender, and the
// events above. Nothing outside RelayTransport may know about WebSocket.

export const MAX_FRAME = 32768;
export const MAX_PLAYERS = 8;
export const NAME_LENGTH = 24;

// Room codes: six characters of an alphabet without 0, O, 1 and I.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const GAME_PATTERN = /^[a-z0-9-]{1,64}$/;

// Why a room was left. The first five are the relay's own codes.
export const ERROR_CODES = ['bad-request', 'no-room', 'room-exists', 'room-full', 'too-fast', 'unreachable', 'lost', 'too-big'];
const RELAY_CLOSE_CODES = { 4400: 'bad-request', 4404: 'no-room', 4409: 'room-exists', 4413: 'room-full', 4429: 'too-fast', 1009: 'too-big' };

const PING_MS = 30000;
// A relay that has said nothing for this long is taken for dead.
const SILENCE_MS = 75000;
// Waits before each new attempt after a drop; after the last one it is over.
const RETRY_MS = [1000, 2000, 4000, 8000, 15000, 15000, 15000, 15000];
// A connection that lasted this long was a working one: the next drop starts
// the waits from the beginning.
const SETTLED_MS = 20000;
// How many attempts to get back in may find the room gone before a player who
// did not make it gives up. When a relay restarts, everybody is dropped at
// once, and the one who made the room needs a moment to make it again.
const GONE_TRIES = 3;
// The relay closes right after it refuses; an error older than this has
// nothing to do with a close that comes now.
const REFUSAL_MS = 10000;

// A room code as the relay wants it, or '' when `text` is not one. Takes what
// people paste: lower case, spaces, a dash in the middle.
export function cleanCode(text) {
  const code = String(text || '').toUpperCase().replace(/[\s-]/g, '');
  return CODE_PATTERN.test(code) ? code : '';
}

export function makeCode() {
  const values = crypto.getRandomValues(new Uint8Array(6));
  // 256 is a multiple of the alphabet's 32 letters, so every letter is as likely.
  return Array.from(values, (value) => CODE_ALPHABET[value % CODE_ALPHABET.length]).join('');
}

// A player name as the relay accepts it: trimmed, without control characters,
// at most NAME_LENGTH characters. '' when nothing is left.
export function cleanName(text) {
  const clean = String(text || '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  // Count the way either relay might: no more than NAME_LENGTH code points and
  // no more than NAME_LENGTH UTF-16 units, without cutting a character in two.
  let out = '';
  let count = 0;
  for (const ch of clean) {
    if (count === NAME_LENGTH || out.length + ch.length > NAME_LENGTH) break;
    out += ch;
    count++;
  }
  return out.trim();
}

// The name of a game for the relay, or '' when `text` is not one.
export function cleanGame(text) {
  return GAME_PATTERN.test(String(text || '')) ? String(text) : '';
}

// The room a game without a catalogue entry is hosted under.
export function gameFromUid(uid) {
  const hex = String(uid || '').toLowerCase().replace(/^0x/, '');
  return /^[0-9a-f]{1,8}$/.test(hex) ? `uid-${hex}` : '';
}

// Text from another player, cut to what a line can show.
function shortText(value, limit) {
  if (typeof value !== 'string') return '';
  const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
  return [...clean].slice(0, limit).join('');
}

const memberId = (value) => (Number.isInteger(value) && value >= 1 && value <= 255 ? value : 0);

// --- the relay -----------------------------------------------------------------------

// Where the site's relay is: config.json's "net", by default /net/ on the
// page's own origin. Always ends in a slash.
export async function relayBase() {
  const config = await siteConfig();
  const named = typeof config.net === 'string' && config.net ? config.net : '/net/';
  try {
    const url = new URL(named, location.href);
    if (!/^https?:$/.test(url.protocol)) throw new Error('not http');
    url.search = '';
    url.hash = '';
    if (!url.pathname.endsWith('/')) url.pathname += '/';
    return url.href;
  } catch {
    return new URL('/net/', location.href).href;
  }
}

async function relayJson(base, path) {
  try {
    const response = await fetch(base + path, { cache: 'no-store' });
    if (!response.ok) return null;
    const value = await response.json();
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// Whether a relay of this protocol version answers at `base`.
export async function relayHealthy(base) {
  const health = await relayJson(base, 'health');
  return Boolean(health && health.ok === true && health.v === 1);
}

// The open public rooms for a game: [{ room, host, players, max }], newest
// first as the relay gives them, or null when the relay did not answer.
export async function publicRooms(base, game) {
  const answer = await relayJson(base, `rooms?game=${encodeURIComponent(game)}`);
  if (!answer || !Array.isArray(answer.rooms)) return null;
  const rooms = [];
  for (const item of answer.rooms.slice(0, 50)) {
    if (!item || typeof item !== 'object') continue;
    const room = cleanCode(item.room);
    if (!room || (item.game !== undefined && item.game !== game)) continue;
    const count = (value, fallback) => (Number.isInteger(value) && value >= 0 && value <= 255 ? value : fallback);
    rooms.push({ room, host: shortText(item.host, NAME_LENGTH) || 'Someone', players: count(item.players, 1), max: count(item.max, MAX_PLAYERS) });
  }
  return rooms;
}

// The Transport interface over one WebSocket to the room relay (protocol
// version 1): JSON text frames for the room, binary frames for the game, the
// first byte of a binary frame being the member it goes to or came from.
export class RelayTransport {
  constructor(base) {
    this.base = base; // http(s) address of the relay, ending in a slash
    this.events = {};
    this.wanted = null; // what connect() was given
    this.socket = null;
    this.greeted = false; // a hello arrived on this socket
    this.everGreeted = false; // a hello arrived on any socket of this room
    this.recreate = false; // the next attempt creates the room again
    this.publicNow = false; // the listing as last heard, for a room made again
    this.attempt = 0;
    this.gone = 0; // attempts since the last hello that found no room
    this.openedAt = 0;
    this.heardAt = 0;
    this.pingTimer = 0;
    this.retryTimer = 0;
    this.refusal = null; // the relay's { code, message, at } before it closed
  }

  connect(wanted) {
    this.close();
    this.wanted = { ...wanted };
    this.publicNow = Boolean(wanted.public);
    this.everGreeted = false;
    this.recreate = false;
    this.attempt = 0;
    this.gone = 0;
    this.open(Boolean(wanted.create));
  }

  close() {
    this.wanted = null;
    clearTimeout(this.retryTimer);
    this.drop();
  }

  send(dst, bytes) {
    const socket = this.socket;
    if (!socket || !this.greeted || socket.readyState !== WebSocket.OPEN) return false;
    if (!bytes || bytes.length < 1 || bytes.length > MAX_FRAME) return false;
    const frame = new Uint8Array(bytes.length + 1);
    frame[0] = dst;
    frame.set(bytes, 1);
    socket.send(frame);
    return true;
  }

  setPublic(value) {
    this.say({ t: 'public', value: Boolean(value) });
  }

  // --- inside ---

  say(message) {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  emit(name, ...args) {
    const handler = this.events[name];
    if (handler) handler(...args);
  }

  // Lets go of the socket without hearing from it again.
  drop() {
    clearInterval(this.pingTimer);
    const socket = this.socket;
    this.socket = null;
    this.greeted = false;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try { socket.close(1000); } catch { /* already closed */ }
  }

  open(create) {
    const wanted = this.wanted;
    const url = new URL(`room/${wanted.room}`, this.base);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('v', '1');
    url.searchParams.set('name', wanted.name);
    if (create) {
      url.searchParams.set('create', '1');
      url.searchParams.set('game', wanted.game);
      if (this.publicNow) url.searchParams.set('public', '1');
    }

    this.refusal = null;
    let socket;
    try {
      socket = new WebSocket(url);
    } catch {
      // An address the browser will not open at all.
      this.finish('unreachable', '');
      return;
    }
    socket.binaryType = 'arraybuffer';
    this.socket = socket;
    this.heardAt = performance.now();

    socket.onmessage = (event) => {
      if (socket !== this.socket) return;
      this.heardAt = performance.now();
      if (typeof event.data === 'string') this.onText(event.data);
      else this.onBinary(event.data);
    };
    socket.onclose = (event) => {
      if (socket !== this.socket) return;
      this.onClose(event.code, create);
    };

    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (socket !== this.socket) return;
      if (performance.now() - this.heardAt > SILENCE_MS) {
        this.onClose(0, create);
        return;
      }
      if (this.greeted) this.say({ t: 'ping' });
    }, PING_MS);
  }

  onText(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (!message || typeof message !== 'object') return;

    switch (message.t) {
      case 'hello': {
        const id = memberId(message.id);
        if (!id || this.greeted) return;
        this.greeted = true;
        this.everGreeted = true;
        this.recreate = false; // after the next drop, look for the room first
        this.gone = 0;
        this.openedAt = performance.now();
        this.publicNow = Boolean(message.public);
        const peers = [];
        for (const peer of Array.isArray(message.peers) ? message.peers : []) {
          const peerId = peer && memberId(peer.id);
          if (peerId && peerId !== id && !peers.some((known) => known.id === peerId)) peers.push({ id: peerId, name: shortText(peer.name, NAME_LENGTH) });
        }
        this.emit('hello', {
          id,
          room: cleanCode(message.room) || this.wanted.room,
          game: cleanGame(message.game),
          public: this.publicNow,
          max: Number.isInteger(message.max) && message.max > 0 ? message.max : MAX_PLAYERS,
          peers,
        });
        break;
      }
      case 'join': {
        const id = memberId(message.id);
        if (id && this.greeted) this.emit('join', { id, name: shortText(message.name, NAME_LENGTH) });
        break;
      }
      case 'leave': {
        const id = memberId(message.id);
        if (id && this.greeted) this.emit('leave', id);
        break;
      }
      case 'public':
        if (!this.greeted) return;
        this.publicNow = Boolean(message.value);
        this.emit('public', this.publicNow);
        break;
      case 'error':
        this.refusal = { code: typeof message.code === 'string' ? message.code : '', message: shortText(message.message, 200), at: performance.now() };
        break;
      default: // 'pong' and anything newer
    }
  }

  onBinary(data) {
    if (!this.greeted || !(data instanceof ArrayBuffer) || data.byteLength < 2 || data.byteLength > MAX_FRAME + 1) return;
    const bytes = new Uint8Array(data);
    if (memberId(bytes[0])) this.emit('frame', bytes[0], bytes.subarray(1));
  }

  // The socket closed, or went silent (`closeCode` 0). `create` says what the
  // attempt was.
  onClose(closeCode, create) {
    // What the relay said just before it closed. An error it sent long ago,
    // and carried on after, does not explain this close.
    const refusal = this.refusal && performance.now() - this.refusal.at < REFUSAL_MS ? this.refusal : null;
    const wasGreeted = this.greeted;
    const lasted = wasGreeted ? performance.now() - this.openedAt : 0;
    this.drop();

    const told = refusal && ERROR_CODES.includes(refusal.code) ? refusal.code : '';
    const code = told || RELAY_CLOSE_CODES[closeCode] || '';

    if (this.everGreeted && !wasGreeted) {
      // An attempt to get back in was refused.
      if (code === 'no-room' && this.wanted.create && !create) {
        // The room emptied while this player, who made it, was away: make it
        // again under the same code, where the others will look for it.
        this.recreate = true;
        this.open(true);
        return;
      }
      // Somebody else made it again in that moment: join theirs. And a room
      // that is gone may be on its way back, made again by its creator: look
      // for it a few more times.
      if (code === 'room-exists' && create) this.recreate = false;
      else if (code && !(code === 'no-room' && !create && ++this.gone < GONE_TRIES)) {
        this.finish(code, refusal ? refusal.message : '');
        return;
      }
    } else if (code || !this.everGreeted) {
      // Refused by the relay, or no relay answered the first attempt at all.
      this.finish(code || 'unreachable', refusal ? refusal.message : '');
      return;
    }

    // A connection that worked and dropped: try to get back in.
    if (lasted > SETTLED_MS) this.attempt = 0;
    if (this.attempt >= RETRY_MS.length) {
      this.finish('lost', '');
      return;
    }
    // A little apart, so that a room does not come back all at once.
    const delay = Math.round(RETRY_MS[this.attempt] * (0.75 + Math.random() * 0.5));
    this.attempt++;
    this.emit('lost', { attempt: this.attempt, delay });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { if (this.wanted && !this.socket) this.open(this.recreate); }, delay);
  }

  finish(code, message) {
    this.wanted = null;
    clearTimeout(this.retryTimer);
    this.emit('closed', { code, message });
  }
}

// --- the session ---------------------------------------------------------------------

// Whether this build of the emulator can be linked to a room.
export function supported(module) {
  return Boolean(module) && typeof module._eka2l1_web_net_link === 'function';
}

// The longest prefix of `text` that fits `limit` bytes of UTF-8.
function utf8Prefix(text, limit) {
  const encoder = new TextEncoder();
  let out = '';
  let size = 0;
  for (const ch of text) {
    size += encoder.encode(ch).length;
    if (size > limit) break;
    out += ch;
  }
  return out;
}

// One player's place in one room, and the emulator's link to it. `state` is
// 'idle' (not in a room), 'connecting', 'open' or 'retrying'; `onChange` is
// called whenever anything the page shows has changed.
export class Session {
  // `makeTransport()` returns a new Transport; it may be async.
  constructor(module, makeTransport) {
    this.module = module;
    this.makeTransport = makeTransport;
    this.transport = null;
    this.onChange = null;
    this.scratch = 0; // a buffer in wasm memory that frames pass through
    this.linked = false; // the emulator was told the link is up
    this.held = false; // the link is kept down although the room is open (see hold)
    this.attempt = 0; // counts host() and join() calls, to drop stale ones
    this.reset();
    this.error = null; // { code, message } of the last room that ended badly
  }

  reset() {
    this.state = 'idle';
    this.room = '';
    this.game = '';
    this.name = '';
    this.id = 0;
    this.public = false;
    this.max = MAX_PLAYERS;
    this.created = false;
    this.peers = new Map(); // id -> name
  }

  get supported() { return supported(this.module); }
  get active() { return this.state !== 'idle'; }
  // Players in the room, this one included.
  get players() { return this.state === 'open' ? this.peers.size + 1 : 0; }
  // Whether somebody else is in the room: their game waits for this one.
  get shared() { return this.state === 'open' && this.peers.size > 0; }
  // The relay obeys the room's first member only.
  get owner() { return this.state === 'open' && this.id === 1; }

  changed() {
    if (this.onChange) this.onChange();
  }

  // Makes a room for `game` and enters it. A code that is taken is replaced
  // by another, a few times.
  host({ game, name, isPublic = false }) {
    return this.enter({ game, name, create: true, public: isPublic, room: makeCode() }, 3);
  }

  join({ room, name }) {
    return this.enter({ room, name, create: false, game: '', public: false }, 0);
  }

  async enter(wanted, spareCodes) {
    this.error = null;
    this.leave();
    const attempt = ++this.attempt;
    if (!this.supported) {
      this.fail('unsupported', '');
      return;
    }
    this.state = 'connecting';
    this.room = wanted.room;
    this.name = wanted.name;
    this.game = wanted.game;
    this.created = wanted.create;
    this.changed();

    let transport;
    try {
      transport = await this.makeTransport();
    } catch {
      transport = null;
    }
    if (attempt !== this.attempt) {
      if (transport) transport.close();
      return;
    }
    if (!transport) {
      this.fail('unreachable', '');
      return;
    }

    this.transport = transport;
    transport.events = {
      hello: (info) => this.onHello(info),
      join: (peer) => this.onJoin(peer),
      leave: (id) => this.onLeave(id),
      frame: (src, bytes) => this.onFrame(src, bytes),
      public: (value) => { this.public = value; this.changed(); },
      lost: (info) => this.onLost(info),
      closed: ({ code, message }) => {
        if (code === 'room-exists' && wanted.create && spareCodes > 0 && this.state === 'connecting') {
          this.transport = null;
          this.enter({ ...wanted, room: makeCode() }, spareCodes - 1);
          return;
        }
        this.fail(code, message);
      },
    };
    this.module.eka2l1OnNetSend = (dst, bytes) => {
      if (this.transport !== transport || this.state !== 'open' || !this.linked) return;
      if (!bytes || bytes.length < 1 || bytes.length > MAX_FRAME) {
        console.warn(`multiplayer: a frame of ${bytes ? bytes.length : 0} bytes was not sent`);
        return;
      }
      transport.send(dst & 0xff, bytes);
    };
    transport.connect(wanted);
  }

  // Leaves the room. Safe to call at any time.
  leave() {
    this.attempt++;
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      transport.events = {};
      transport.close();
    }
    const was = this.state;
    this.linkDown();
    this.reset();
    if (was !== 'idle') this.changed();
  }

  setPublic(value) {
    if (this.owner && this.transport) this.transport.setPublic(value);
  }

  // For a restart of the game, which ends every connection the game had:
  // hold() takes the emulator's link down and keeps it down, whatever happens
  // in the room meanwhile, and release() brings it up again with the whole
  // state. The player stays in the room throughout. The other players' games
  // learn of it from the emulator, which announces itself anew to every member
  // when its link comes up; nothing is sent from here.
  hold() {
    this.held = true;
    this.linkDown();
  }

  release() {
    if (!this.held) return;
    this.held = false;
    if (this.state === 'open') this.linkUp();
  }

  // --- inside ---

  fail(code, message) {
    const transport = this.transport;
    this.transport = null;
    if (transport) {
      transport.events = {};
      transport.close();
    }
    this.linkDown();
    const room = this.room;
    this.reset();
    this.error = { code, message, room };
    this.changed();
  }

  onHello(info) {
    // A hello while linked would be a second link under another id.
    this.linkDown();
    this.state = 'open';
    this.id = info.id;
    this.room = info.room;
    this.game = info.game || this.game;
    this.public = info.public;
    this.max = info.max;
    this.peers = new Map(info.peers.map((peer) => [peer.id, peer.name]));
    this.linkUp();
    this.changed();
  }

  onJoin({ id, name }) {
    if (this.state !== 'open' || id === this.id) return;
    const known = this.peers.has(id);
    this.peers.set(id, name);
    if (!known && this.linked) this.module._eka2l1_web_net_peer(id, 1);
    this.changed();
  }

  onLeave(id) {
    if (this.state !== 'open' || !this.peers.delete(id)) return;
    if (this.linked) this.module._eka2l1_web_net_peer(id, 0);
    this.changed();
  }

  onLost() {
    this.linkDown();
    this.state = 'retrying';
    this.id = 0;
    this.peers = new Map();
    this.changed();
  }

  onFrame(src, bytes) {
    if (this.state !== 'open' || !this.linked || !this.peers.has(src) || bytes.length < 1 || bytes.length > MAX_FRAME) return;
    const module = this.module;
    if (!this.scratch) this.scratch = module._malloc(MAX_FRAME);
    if (!this.scratch) return;
    // The memory is shared and grows, so the view is made for this one copy;
    // the emulator copies the frame before it returns.
    new Uint8Array(module.wasmMemory.buffer, this.scratch, bytes.length).set(bytes);
    module._eka2l1_web_net_receive(src, this.scratch, bytes.length);
  }

  // Calls the emulator's link function; it copies the name before it returns.
  link(id, name) {
    const module = this.module;
    const size = module.lengthBytesUTF8(name) + 1;
    const pointer = module._malloc(size);
    module.stringToUTF8(name, pointer, size);
    module._eka2l1_web_net_link(id, pointer);
    module._free(pointer);
  }

  linkUp() {
    if (this.held) return;
    // The name other players' games show for this device: at most 64 bytes.
    this.link(this.id, utf8Prefix(this.name, 64) || 'Player');
    this.linked = true;
    for (const id of this.peers.keys()) this.module._eka2l1_web_net_peer(id, 1);
  }

  linkDown() {
    if (!this.linked) return;
    this.linked = false;
    for (const id of this.peers.keys()) this.module._eka2l1_web_net_peer(id, 0);
    this.link(0, '');
  }
}

// What to tell the player about the way a room ended. `room` is its code.
export function errorText(error) {
  const room = error.room ? ` ${error.room}` : '';
  switch (error.code) {
    case 'unsupported': return 'This build of the emulator has no multiplayer support.';
    case 'unreachable': return 'The multiplayer service does not answer. Check your connection and try again.';
    case 'no-room': return `There is no room${room}. Check the code; a room closes when its last player leaves.`;
    case 'room-full': return `Room${room} is full.`;
    case 'room-exists': return 'That room code is taken. Try again.';
    case 'bad-request': return `The multiplayer service refused the name or the room code${error.message ? ` (${error.message})` : ''}. Choose a name of 1 to ${NAME_LENGTH} characters.`;
    case 'too-fast': return 'The multiplayer service closed the connection because this game sent too much at once.';
    case 'too-big': return 'The multiplayer service closed the connection because this game sent a message that is too large.';
    case 'lost': return `The connection to room${room} was lost and could not be made again.`;
    default: return `The room was closed${error.message ? `: ${error.message}` : '.'}`;
  }
}
