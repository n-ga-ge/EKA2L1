// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: the link to the other players. It has something to
// say only while multiplayer is in use: in a room, on the way into one, or
// after one ended badly. core.js describes what a section is.
//
// Three sources:
//   - net.js: the Session's health() (the state of the room, why the last one
//     ended) and its transport's (the round trips of the pings to the relay,
//     how often the connection dropped, what the relay refused);
//   - the emulator's GET /v1/net: what the game makes of the link (its
//     connections, what waits to be read, frames lost, malformed or out of
//     order). It is asked every other second while in a room (every second
//     with the dialog open), and never otherwise;
//   - the relay's /net/health, asked only while the link is down, to tell a
//     relay that is gone from a connection that broke.
//
// Nothing here may put the room's code, a player's name or a Bluetooth
// address into the data: it goes into a report the visitor sends to
// somebody. health() has none, and emulatorPart() copies numbers and known
// words only.

import { PING_MS, relayBase, relayHealthy } from '../net.js';
import { number, rows, seconds } from './dom.js';

// A round trip to the relay above this is called slow. See docs/diagnostics.md
// for why this number: a message from one game to the other takes about one
// round trip (half of each player's), and the games were written for a radio
// link that delivers within a few tens of milliseconds.
export const SLOW_MS = 150;
// The median of the last TRIPS_USED round trips is judged, once there are
// TRIPS_NEEDED, so that one late answer does not make a finding.
const TRIPS_USED = 5;
const TRIPS_NEEDED = 3;
// A round trip measured longer ago than this says nothing about now.
const TRIP_AGE_MS = 120000;
// While the dialog is open, a new round trip is measured this often (net.js
// measures one every 30 seconds by itself).
const PING_GAP_MS = 5000;
// A ping without an answer for this long: slow, then as good as down.
const STALLED_MS = 3000;
const DEAD_MS = 10000;
// Connecting for longer than this is the relay not answering.
const CONNECT_S = 10;
// The other side is called quiet when nothing came for this long while this
// game sent at least QUIET_FRAMES messages and is still sending.
const QUIET_S = 10;
const QUIET_FRAMES = 5;
const STILL_SENDING_S = 5;
// What waits to be read by the game is marked from here: at 512 KiB the
// emulator resets the connection.
const QUEUE_WARN_BYTES = 256 * 1024;
// The relay's /net/health is asked at most this often, and the first answer
// is waited for once, at most PROBE_WAIT_MS, so that the dialog does not
// hang. No answer within PROBE_LIMIT_MS is the answer "not there". It is
// asked once the room has been connecting for PROBE_AFTER_MS.
const PROBE_MS = 10000;
const PROBE_WAIT_MS = 1500;
const PROBE_LIMIT_MS = 5000;
const PROBE_AFTER_MS = 5000;
// The emulator's answer is asked again when it is older than this: with the
// dialog open, and with it closed (every other sample).
const ANSWER_MS = 900;
const SAMPLE_GAP_MS = 1900;

// Replaced by the test, which has no relay to ask.
export const hooks = { relayBase, relayHealthy };

// What the section remembers between calls.
const memory = {
  answer: null, // the emulator's last answer to GET /v1/net
  answerAt: 0,
  asking: null, // the request on its way
  none: false, // the build has no GET /v1/net
  watch: newWatch(),
  probe: newProbe(),
};

function newWatch() {
  return { key: null, since: 0, framesIn: 0, framesOut: 0, inAt: null, outAt: null, sentSinceHeard: 0, dropped: 0, seqErrors: 0, droppedBase: 0, seqErrorsBase: 0 };
}

function newProbe() {
  return { answers: null, at: 0, asking: null, waited: false };
}

const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);
const word = (value) => (typeof value === 'string' && /^[a-z0-9-]{1,24}$/.test(value) ? value : '');
const whole = (value) => (Number.isInteger(value) ? value : 0);
const toSeconds = (ms) => (Number.isFinite(ms) ? Math.round(ms / 1000) : null);

// Follows the emulator's counters from one answer to the next, to know when
// the other side was last heard, whether this game has gone on sending
// since, and what was lost on this link (the emulator's own counters are
// totals, and a loss in an earlier room says nothing about this one). `key`
// names the link the counters belong to: another key, or a frame counter
// that went back, starts over.
export function follow(watch, answer, key, now) {
  const totals = (answer && answer.totals) || {};
  const framesIn = count(totals.framesIn);
  const framesOut = count(totals.framesOut);
  const dropped = count(answer && answer.link && answer.link.dropped);
  const seqErrors = count(totals.seqErrors);
  if (watch.key !== key || framesIn < watch.framesIn || framesOut < watch.framesOut) {
    Object.assign(watch, newWatch(), { key, since: now, framesIn, framesOut, droppedBase: dropped, seqErrorsBase: seqErrors });
    return watch;
  }
  // The sequence errors are counted per game: a game started again counts from 0.
  if (seqErrors < watch.seqErrorsBase) watch.seqErrorsBase = 0;
  if (dropped < watch.droppedBase) watch.droppedBase = 0;
  watch.dropped = dropped - watch.droppedBase;
  watch.seqErrors = seqErrors - watch.seqErrorsBase;
  if (framesOut > watch.framesOut) {
    watch.outAt = now;
    watch.sentSinceHeard += framesOut - watch.framesOut;
  }
  // When both grew since the last look their order is not known: take it
  // that the other side answered.
  if (framesIn > watch.framesIn) {
    watch.inAt = now;
    watch.sentSinceHeard = 0;
  }
  watch.framesIn = framesIn;
  watch.framesOut = framesOut;
  return watch;
}

// The emulator's answer without anything that names a player: counts, sizes,
// states, and the words the emulator itself uses for protocols and operations.
export function emulatorPart(answer) {
  if (!answer || typeof answer !== 'object') return null;
  const link = answer.link || {};
  const totals = answer.totals || {};
  const list = (value) => (Array.isArray(value) ? value.filter((item) => item && typeof item === 'object') : []);
  const peers = list(answer.peers);
  const connections = list(answer.connections).map((item) => ({
    peer: whole(item.peer),
    protocol: word(item.protocol),
    port: whole(item.port),
    state: word(item.state),
    initiator: Boolean(item.initiator),
    txBytes: count(item.txBytes),
    rxBytes: count(item.rxBytes),
    rxQueued: count(item.rxQueued),
  }));
  return {
    linkUp: Boolean(link.up),
    attached: Boolean(answer.attached), // a game is running and has its Bluetooth connected to the link
    peers: peers.length,
    announced: peers.filter((peer) => peer.address !== null && peer.address !== undefined).length,
    listeners: list(answer.listeners).map((item) => ({ protocol: word(item.protocol), port: whole(item.port), queued: count(item.queued), accepting: Boolean(item.accepting) })),
    connections,
    open: connections.filter((item) => item.state === 'open').length,
    rxQueued: connections.reduce((sum, item) => sum + item.rxQueued, 0),
    framesIn: count(totals.framesIn),
    framesOut: count(totals.framesOut),
    dropped: count(link.dropped),
    badFrames: count(totals.badFrames),
    seqErrors: count(totals.seqErrors),
    connectsIn: count(totals.connectsIn),
    connectsOut: count(totals.connectsOut),
    refused: count(totals.refused),
    events: list(answer.events).slice(-32).map((item) => ({ ms: count(item.ms), op: word(item.op), protocol: word(item.protocol), port: whole(item.port), peer: whole(item.peer), result: whole(item.result) })),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The section's data from what the three sources said. `health` is the
// Session's health(), `answer` the emulator's GET /v1/net or null, `watch`
// what follow() keeps, `probe` { answers, at } of the relay's health check
// (answers null: not asked), `online` the browser's navigator.onLine or null,
// `now` the time on the clock of `watch` and `probe`.
export function summarize({ health, answer, watch, probe, online, now }) {
  const state = health.state === 'idle' ? 'ended' : health.state;
  const transport = health.transport;
  let relay = null;
  if (transport) {
    const trips = (transport.trips || []).filter((trip) => Number.isFinite(trip.ms) && trip.agoMs <= TRIP_AGE_MS).slice(-TRIPS_USED);
    relay = {
      connected: Boolean(transport.connected),
      attempt: count(transport.attempt),
      drops: count(transport.drops),
      openS: toSeconds(transport.openMs),
      heardAgoS: toSeconds(transport.heardMs),
      waitingMs: Math.round(count(transport.waitingMs)),
      refusal: word(transport.refusal) || null,
      // To the relay and back, in milliseconds, oldest first.
      roundTripMs: trips.map((trip) => Math.round(trip.ms * 10) / 10),
      medianMs: trips.length ? Math.round(median(trips.map((trip) => trip.ms)) * 10) / 10 : null,
      measuredAgoS: trips.length ? toSeconds(trips[trips.length - 1].agoMs) : null,
    };
  }
  const emulator = state === 'ended' ? null : emulatorPart(answer);
  const watching = emulator && watch && watch.key !== null;
  return {
    state, // 'connecting', 'open', 'retrying', or 'ended': out of a room that ended badly
    stateS: toSeconds(health.sinceMs),
    ended: state === 'ended' ? (word(health.error) || 'closed') : null,
    players: count(health.players), // in the room, this one included
    host: Boolean(health.created),
    listed: Boolean(health.public),
    linked: Boolean(health.linked), // the emulator was told the link is up
    held: Boolean(health.held), // kept down while the game restarts
    relay,
    // The relay's health check, made only while the link is down.
    service: probe && probe.answers !== null ? { answers: Boolean(probe.answers), online: typeof online === 'boolean' ? online : null, checkedAgoS: toSeconds(now - probe.at) } : null,
    emulator,
    // The emulator's counters as they were followed on this link, since
    // `watchedS` ago: when the other side's game was last heard and this one
    // last sent, and what was lost here (`emulator` has the totals).
    traffic: watching ? {
      watchedS: toSeconds(now - watch.since),
      heardAgoS: watch.inAt === null ? null : toSeconds(now - watch.inAt),
      sentAgoS: watch.outAt === null ? null : toSeconds(now - watch.outAt),
      sentSinceHeard: watch.sentSinceHeard,
      dropped: watch.dropped,
      seqErrors: watch.seqErrors,
    } : null,
  };
}

// How long nothing has come from the other side while this game kept
// sending, in seconds, or 0 when that cannot be said. A game may be silent
// for good reasons (a lobby, a menu), so silence alone is not enough: this
// game must have sent several messages since and still be sending.
export function quietFor(data) {
  const { emulator, traffic } = data;
  if (data.state !== 'open' || !emulator || !emulator.open || !traffic) return 0;
  const silent = traffic.heardAgoS === null ? traffic.watchedS : traffic.heardAgoS;
  const sending = traffic.sentAgoS !== null && traffic.sentAgoS <= STILL_SENDING_S && traffic.sentSinceHeard >= QUIET_FRAMES;
  return sending && silent >= QUIET_S ? silent : 0;
}

// Why a room ended, by its code, and what to do. Every code of net.js's
// ERROR_CODES has its words here (the test holds that).
export const ENDED = {
  unsupported: ['This copy of the player has no multiplayer.', 'Reload the page to get the current version.'],
  unreachable: ['The multiplayer service did not answer when the room was opened.', null],
  lost: ['The connection to the room dropped and could not be made again, in more than a minute of trying.', null],
  'no-room': ['The room does not exist. A room closes when its last player leaves.', 'Check the room code, or ask the other player for a new invitation.'],
  'room-full': ['The room is full.', 'Wait until a player leaves, or host a room of your own.'],
  'room-exists': ['The room code was already in use.', 'Host the room again.'],
  'bad-request': ['The multiplayer service refused the name or the room code.', 'Choose a name of 1 to 24 characters and check the room code.'],
  'too-fast': ['The multiplayer service closed the connection because the game sent too much at once.', 'Join the room again. If it happens again with this game, send us this report.'],
  'too-big': ['The multiplayer service closed the connection because the game sent a message that is too large.', 'Join the room again. If it happens again with this game, send us this report.'],
  closed: ['The room was closed.', 'Join the room again.'],
};
const NETWORK_ADVICE = 'Check the internet connection of this device. Some networks (offices, schools, a VPN) block this kind of connection: try another one.';

// What the check of the multiplayer service adds to "the link is down".
function serviceText(service) {
  if (!service) return '';
  if (service.answers) return ' A check just now reached the multiplayer service, so the network works: only the connection to the room failed.';
  return service.online === false ? ' The browser says this device has no network connection.' : ' A check just now got no answer from the multiplayer service either.';
}

function unreachable(data) {
  const make = (title, detail, advice) => ({ code: 'relay-unreachable', level: 'bad', title, detail, advice });
  const relay = data.relay;
  if (data.state === 'ended') {
    const [reason, advice] = ENDED[data.ended] || ENDED.closed;
    const network = data.ended === 'unreachable' || data.ended === 'lost';
    return make('Multiplayer is not connected', reason + (network ? serviceText(data.service) : ''), advice || NETWORK_ADVICE);
  }
  if (data.state === 'retrying') {
    return make('The connection to the other players is down',
      `It dropped ${number(data.stateS)} s ago and is being made again${relay && relay.attempt ? ` (attempt ${relay.attempt})` : ''}.${serviceText(data.service)}`,
      `${NETWORK_ADVICE} The game lost its connection to the other player's game: once the room is back, host and join again in the game's own menu.`);
  }
  if (data.state === 'connecting' && data.stateS >= CONNECT_S) {
    return make('The multiplayer service is not answering', `Entering the room has taken ${number(data.stateS)} s so far.${serviceText(data.service)}`, NETWORK_ADVICE);
  }
  if (data.state === 'open' && relay && relay.waitingMs >= DEAD_MS) {
    return make('The multiplayer service has stopped answering',
      `It has not answered for ${number(relay.waitingMs / 1000)} s; an answer usually comes within a fraction of a second.${serviceText(data.service)}`, NETWORK_ADVICE);
  }
  return null;
}

function slow(data) {
  const relay = data.relay;
  if (data.state !== 'open' || !relay) return null;
  const make = (detail) => ({
    code: 'relay-slow',
    level: 'warn',
    title: 'Messages to the other players take long',
    detail,
    advice: 'The game may stutter, wait, or say that the connection was lost. Move closer to the Wi-Fi router or use a cable, stop downloads and video on the same network, and switch off a VPN. The other player\'s connection counts as much as yours.',
  });
  if (relay.waitingMs >= STALLED_MS) return make(`The multiplayer service has not answered for ${number(relay.waitingMs / 1000)} s; an answer usually comes within a fraction of a second.`);
  if (relay.roundTripMs.length < TRIPS_NEEDED || !(relay.medianMs > SLOW_MS)) return null;
  return make(`A message to the multiplayer service and back takes ${number(relay.medianMs)} ms (the last ${relay.roundTripMs.length} measurements: ${relay.roundTripMs.map((ms) => number(ms)).join(', ')} ms).`
    + ` The games were made for a radio link between two phones side by side, which answers within a few tens of milliseconds; above ${SLOW_MS} ms they fall behind each other.`);
}

// What was lost since this link came up. A loss in an earlier room is over.
function dropped(data) {
  const traffic = data.traffic;
  if (!traffic || !(traffic.dropped || traffic.seqErrors)) return null;
  const parts = [];
  if (traffic.dropped) parts.push(`${traffic.dropped} message${traffic.dropped === 1 ? '' : 's'} from the other player had to be thrown away because the game here had fallen too far behind in reading them`);
  if (traffic.seqErrors) parts.push(`${traffic.seqErrors} message${traffic.seqErrors === 1 ? '' : 's'} arrived out of order`);
  return {
    code: 'net-frames-dropped',
    level: 'bad',
    title: 'The game lost data from the other player',
    detail: `Since this room was entered, ${parts.join(' and ')}. The game's connection to the other player was closed each time.`,
    advice: traffic.dropped ? 'The game runs too slowly on this device to keep up with the other player; the other findings say why. Host and join again in the game\'s own menu.'
      : 'Host and join again in the game\'s own menu. If it happens again, send us this report.',
  };
}

const RESULTS = { '-1': 'not found', '-3': 'cancelled', '-18': 'not ready', '-25': 'the other side closed', '-33': 'no answer in time', '-34': 'nobody to connect to', '-36': 'connection lost' };
const PROTOCOLS = { rfcomm: 'RFCOMM', l2cap: 'L2CAP' };

function size(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${bytes} bytes`;
  return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

// L2CAP port 1 is the phone's own service discovery, which a game asks before
// it connects: not a connection of the game itself. The emulator's log of
// operations calls it 'sdp'.
const discovery = (item) => item.protocol === 'sdp' || (item.protocol === 'l2cap' && item.port === 1);
const channel = (item) => (discovery(item) ? 'service discovery' : `${PROTOCOLS[item.protocol] || item.protocol} ${item.port}`);

function roomRow(data) {
  const relay = data.relay;
  if (data.state === 'ended') return { label: 'Room', value: 'not connected', note: (ENDED[data.ended] || ENDED.closed)[0], mark: 'bad' };
  if (data.state === 'retrying') {
    return { label: 'Room', value: 'connection lost, trying again', note: `For ${number(data.stateS)} s${relay && relay.attempt ? `, attempt ${relay.attempt}` : ''}.`, mark: 'bad' };
  }
  if (data.state === 'connecting') return { label: 'Room', value: 'connecting…', note: `For ${number(data.stateS)} s.`, mark: data.stateS >= CONNECT_S ? 'bad' : 'warn' };
  const notes = [data.host ? 'You opened this room.' : null, data.listed ? 'It is listed publicly.' : null,
    data.players < 2 ? 'Nobody else is in it yet.' : null,
    relay && relay.openS !== null ? `Connected for ${seconds(relay.openS * 1000)}.` : null,
    relay && relay.drops ? `The connection dropped ${relay.drops} time${relay.drops === 1 ? '' : 's'} and was made again; each time the game lost its connection to the other player's game.` : null];
  return { label: 'Room', value: `connected, ${data.players} player${data.players === 1 ? '' : 's'}`, note: notes.filter(Boolean).join(' '), mark: relay && relay.drops ? 'warn' : 'ok' };
}

function tripRow(data) {
  const relay = data.relay;
  if (data.state !== 'open' || !relay) return null;
  const how = 'To the multiplayer service and back. A message to another player goes to the service and on from there.';
  if (relay.waitingMs >= STALLED_MS) return { label: 'Round trip', value: `no answer for ${number(relay.waitingMs / 1000)} s`, note: how, mark: relay.waitingMs >= DEAD_MS ? 'bad' : 'warn' };
  if (!relay.roundTripMs.length) return { label: 'Round trip', value: 'not measured yet', note: `${how} Measured every ${Math.round(PING_MS / 1000)} seconds, and every few seconds while this window is open.` };
  return {
    label: 'Round trip',
    value: `${number(relay.medianMs)} ms`,
    note: `Last measurements: ${relay.roundTripMs.map((ms) => number(ms)).join(', ')} ms, the latest ${number(relay.measuredAgoS)} s ago. ${how}`,
    mark: relay.roundTripMs.length < TRIPS_NEEDED ? null : relay.medianMs > SLOW_MS ? 'warn' : 'ok',
  };
}

function gameRows(data) {
  const emulator = data.emulator;
  if (!emulator || data.state !== 'open') return [];
  if (data.held || !emulator.linkUp) return [{ label: 'Game', value: 'not linked to the room', note: data.held ? 'The game is starting again; the link comes back when it is up.' : 'The link is being set up.', mark: 'warn' }];
  if (!emulator.attached) return [{ label: 'Game', value: 'no game is using the link' }];
  const own = emulator.connections.filter((item) => !discovery(item) && item.state !== 'closed');
  const waiting = emulator.listeners.filter((item) => !discovery(item));
  const list = [];
  if (own.length) {
    list.push({
      label: 'Game',
      value: `${own.length} connection${own.length === 1 ? '' : 's'} to the other player's game`,
      note: own.map((item) => `${channel(item)}${item.state === 'open' ? '' : ` (${item.state})`}: ${size(item.txBytes)} sent, ${size(item.rxBytes)} received`).join('; ') + '.',
      mark: 'ok',
    });
  } else {
    list.push({
      label: 'Game',
      value: 'not connected to another player\'s game',
      note: waiting.length ? 'It is waiting for a player to join. The other player chooses to join in the game\'s own menu.'
        : 'Being in a room is not enough: one player hosts and the other joins in the game\'s own multiplayer menu.',
    });
  }
  const quiet = quietFor(data);
  const traffic = data.traffic;
  if (quiet) {
    list.push({
      label: 'Other player',
      value: `nothing received for ${number(quiet)} s`,
      note: `This game keeps sending (${traffic.sentSinceHeard} messages since) and gets no answer. The other player's game is probably paused, or their tab or window is in the background or closed: ask them to bring it to the front.`,
      mark: 'warn',
    });
  } else if (own.length && traffic) {
    list.push({
      label: 'Other player',
      value: traffic.heardAgoS === null ? `nothing received in the last ${number(traffic.watchedS)} s` : traffic.heardAgoS < 2 ? 'heard just now' : `last heard ${number(traffic.heardAgoS)} s ago`,
      note: 'A game that waits in a menu may send nothing for a while.',
    });
  }
  if (emulator.rxQueued) {
    list.push({
      label: 'Waiting to be read',
      value: size(emulator.rxQueued),
      note: 'Received and not yet taken by the game. A game that keeps up reads it at once.',
      mark: emulator.rxQueued >= QUEUE_WARN_BYTES ? 'warn' : null,
    });
  }
  const lost = traffic || { dropped: 0, seqErrors: 0 };
  const losses = [lost.dropped ? `${lost.dropped} thrown away` : null, lost.seqErrors ? `${lost.seqErrors} out of order` : null,
    emulator.badFrames ? `${emulator.badFrames} not understood` : null].filter(Boolean);
  list.push({
    label: 'Messages lost',
    value: losses.length ? losses.join(', ') : 'none',
    note: `In this room. ${emulator.framesIn} were received and ${emulator.framesOut} sent since this page was opened.`
      + (emulator.badFrames ? ' Messages that are not understood come from a player whose page is a different version: both reload the page.' : ''),
    mark: lost.dropped || lost.seqErrors ? 'bad' : emulator.badFrames ? 'warn' : 'ok',
  });
  // What failed since the link last came up; what the game cancelled itself
  // (-3) is no failure.
  const linkUp = emulator.events.map((event) => event.op).lastIndexOf('link-up');
  const failed = emulator.events.slice(linkUp + 1).filter((event) => event.result < 0 && event.result !== -3).slice(-3);
  if (failed.length) {
    list.push({
      label: 'Last failures',
      value: failed.map((event) => `${event.op}${event.protocol && event.port ? ` (${channel(event)})` : ''}: ${RESULTS[event.result] || `error ${event.result}`}`).join('; '),
      note: 'What the game last tried on its link without success.',
    });
  }
  return list;
}

// Asks the emulator, once at a time; the answer is kept and followed.
function ask(ctx, health) {
  if (memory.none || !ctx.emu) return Promise.resolve();
  if (!memory.asking) {
    memory.asking = (async () => {
      try {
        const res = await ctx.emu.request('GET', '/v1/net');
        if (res.ok) {
          const answer = res.json();
          const now = performance.now();
          memory.answer = answer;
          memory.answerAt = now;
          const up = health.state === 'open' && answer && answer.link && answer.link.up;
          if (up) follow(memory.watch, answer, `link ${whole(answer.link.self)}`, now);
          else memory.watch = newWatch();
        } else if (res.status === 404) {
          memory.none = true;
        }
      } catch (error) {
        console.warn('diagnostics: no answer about the link from the emulator', error);
      } finally {
        memory.asking = null;
      }
    })();
  }
  return memory.asking;
}

// Asks the relay whether it is there, at most every PROBE_MS. Returns the
// request on its way, or null when the last answer is fresh enough.
function probeService(now) {
  const probe = memory.probe;
  // An answer from an earlier time the link was down says nothing about now.
  if (probe.answers !== null && now - probe.at > 2 * PROBE_MS) {
    probe.answers = null;
    probe.waited = false;
  }
  if (!probe.asking && (probe.answers === null || now - probe.at > PROBE_MS)) {
    probe.asking = (async () => {
      let answers = false;
      try {
        // A request into a network that swallows it can hang for minutes.
        answers = Boolean(await within((async () => hooks.relayHealthy(await hooks.relayBase()))(), PROBE_LIMIT_MS, false));
      } catch {
        answers = false;
      }
      probe.answers = answers;
      probe.at = performance.now();
      probe.asking = null;
    })();
  }
  return probe.asking;
}

// A request still on its way keeps the probe it was made for, so its answer
// never counts for a later time the link is down.
function forgetProbe() {
  memory.probe = newProbe();
}

// `promise`, or `fallback` when it has not settled within `ms`.
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

function forget() {
  memory.answer = null;
  memory.answerAt = 0;
  memory.watch = newWatch();
}

function healthOf(ctx) {
  const net = ctx.page && ctx.page.net;
  if (!net || typeof net.health !== 'function' || !(net.active || net.error)) return null;
  return net.health();
}

export default {
  id: 'network',
  title: 'Multiplayer',
  order: 75,

  // Every other second while in a room, the emulator is asked what it makes
  // of the link, so that the section knows when the other side was last
  // heard, and what was lost in this room, even when the dialog is opened
  // later. Nothing is waited for.
  sample(ctx) {
    const health = healthOf(ctx);
    if (!health || health.state === 'idle') forget();
    // A link that comes back is another link, even under the same id.
    else if (health.state !== 'open') memory.watch = newWatch();
    else if (performance.now() - memory.answerAt >= SAMPLE_GAP_MS) ask(ctx, health);
  },

  async collect(ctx) {
    const health = healthOf(ctx);
    if (!health) {
      forget();
      forgetProbe();
      return null;
    }
    const net = ctx.page.net;
    const transport = health.transport;
    let now = performance.now();

    if (health.state === 'idle') forget();
    else if (!memory.answer || now - memory.answerAt > ANSWER_MS) await ask(ctx, health);

    // One more round trip while somebody looks: quickly until there are
    // enough to judge, then every few seconds.
    if (health.state === 'open' && transport && typeof net.ping === 'function') {
      const fresh = (transport.trips || []).filter((trip) => trip.agoMs <= TRIP_AGE_MS);
      if (fresh.length < TRIPS_NEEDED || fresh[fresh.length - 1].agoMs >= PING_GAP_MS) net.ping();
    }

    // Is the relay there at all? Only asked while the link is not.
    const down = health.state === 'retrying' || (health.state === 'connecting' && health.sinceMs >= PROBE_AFTER_MS)
      || (health.state === 'idle' && (health.error === 'unreachable' || health.error === 'lost'))
      || (health.state === 'open' && transport && transport.waitingMs >= STALLED_MS);
    if (down) {
      const asking = probeService(now);
      const probe = memory.probe;
      if (asking && probe.answers === null && !probe.waited) {
        probe.waited = true;
        await within(asking, PROBE_WAIT_MS);
      }
    } else {
      forgetProbe();
    }

    now = performance.now();
    return summarize({
      health,
      answer: health.state === 'idle' ? null : memory.answer,
      watch: memory.watch,
      probe: down ? memory.probe : null,
      online: typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : null,
      now,
    });
  },

  findings(data) {
    const down = unreachable(data);
    // A link that is down is not also called slow.
    return [down, down ? null : slow(data), dropped(data)].filter(Boolean);
  },

  render(data) {
    return [rows([roomRow(data), tripRow(data), ...gameRows(data)])];
  },
};
