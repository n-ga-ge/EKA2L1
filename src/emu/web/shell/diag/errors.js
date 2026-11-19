// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: games that crashed or closed, and errors of the page
// and the emulator. core.js describes what a section is.
//
// What it knows comes from four places:
//   - the "exits" part of GET /v1/web/diag (web/src/diag_exits.cpp): how the
//     game and the guest's threads ended, system calls the emulator does not
//     have, the turns of the loop that runs the guest, and the exception that
//     ended that loop;
//   - the page itself: errors and promise rejections nobody handled, heard
//     from the moment the page loads (init);
//   - the client (eka2l1-client.js): the emulator's last log lines and
//     whether the wasm module aborted;
//   - a request of its own, when the samples have stopped coming: an emulator
//     that does not answer has stopped, whatever it did not manage to say.
//
// The data (collect) is a snapshot: every "agoS" is seconds before it was
// taken. findings() reads nothing else.

import { rows, seconds } from './dom.js';

const KEEP_ERRORS = 20; // page errors kept; all are counted
const TEXT_LENGTH = 300; // of a message in a report
const SHOWN_LOG = 100; // log lines in a report (the client keeps as many)

// The samples normally arrive every second. When the last one is older than
// this, the section asks the emulator itself.
const FRESH_MS = 3000;
// No answer for this long: the emulator has stopped. The request is answered
// by a thread that does nothing else, in well under a millisecond, so five
// seconds is not a matter of a busy machine.
export const SILENT_S = 5;
// The loop that runs the guest turns a few hundred times a second in play,
// and every reading wakes it when it sleeps, so a loop that is alive has
// turned by the next reading. Ten readings in a row without a turn, with a
// game that is not paused on a page that is shown, is a thread that is stuck
// or gone.
export const STUCK_S = 10;
// A thread that ends with its program is the same event as the program's
// end, which the kernel reports right after it.
const SAME_EVENT_MS = 5000;

// What the commonest error codes of the phone's system mean.
const ERROR_NAMES = {
  '-1': 'something it looked for was not found',
  '-2': 'a general error',
  '-3': 'cancelled',
  '-4': 'out of memory',
  '-5': 'not supported',
  '-6': 'a bad argument',
  '-12': 'a folder was not found',
  '-14': 'something it needed was in use',
  '-15': 'a system service ended',
  '-18': 'not ready',
  '-20': 'a damaged file',
  '-21': 'access denied',
  '-26': 'the disk is full',
};

// --- pure helpers (tested in shell-tests/errors.test.mjs) -----------------------

// "3 min 5 s ago"; "just now" for the first seconds.
export function ago(agoS) {
  if (!Number.isFinite(agoS)) return 'at an unknown time';
  return agoS < 5 ? 'just now' : `${seconds(agoS * 1000)} ago`;
}

function cut(text, length = TEXT_LENGTH) {
  const plain = String(text === undefined || text === null ? '' : text).replace(/\s+/g, ' ').trim();
  return plain.length > length ? `${plain.slice(0, length - 1)}…` : plain;
}

// The file of a script address and nothing before it: a report must not carry
// more of an address than says where an error was.
function fileOf(address) {
  const text = String(address || '');
  const path = text.split(/[?#]/)[0];
  return path.slice(path.lastIndexOf('/') + 1);
}

// A log line of the emulator as a report keeps it: colour codes out, and the
// source file without the folders of the machine that built the emulator.
//   "E /home/user/src/emu/system/src/devices.cpp:188 [System]: Devices file not found"
//   -> "E devices.cpp:188 [System]: Devices file not found"
export function shortLogLine(line) {
  const plain = String(line).replace(/\u001b\[[0-9;]*m/g, '');
  return cut(plain.replace(/^([A-Z]) \S*[/\\]([^/\\\s]+:\d+) /, '$1 $2 '));
}

// 'E', 'W', ... for a line of the emulator's log, null for other output.
export function logLevel(line) {
  const match = /^([EWICT]) \S+:\d+ \[/.exec(line);
  return match ? match[1] : null;
}

// How an ending is said: "panic KERN-EXEC 3", "a processor fault", "error
// code -4 (out of memory)", "no error".
export function endingText(end) {
  if (end.fault) return 'a processor fault (it used memory it does not have, or an instruction that does not exist)';
  if (end.type === 'panic') return `panic ${end.category} ${end.reason}${end.description ? ` (${end.description})` : ''}`;
  if (end.reason === 0) return 'no error';
  const meaning = ERROR_NAMES[String(end.reason)];
  return `error code ${end.reason}${meaning ? ` (${meaning})` : ''}`;
}

export function crashed(end) {
  return Boolean(end) && (end.fault || end.type === 'panic');
}

// What the page's status line says when the game has ended by itself. `end`
// is the game's entry of the emulator's "lastApps", or null when the build
// does not say how it ended. Returns { text, error }.
export function endedStatus(name, end) {
  const again = 'Menu → Restart game starts it again.';
  if (!end) return { text: `${name} has closed. ${again}`, error: false };
  if (crashed(end)) return { text: `${name} crashed: ${endingText(end)}. ${again}`, error: true };
  if (end.reason !== 0) return { text: `${name} closed with ${endingText(end)}. ${again}`, error: true };
  return { text: `${name} has closed. ${again}`, error: false };
}

// For how long the loop that runs the guest has not turned, in seconds, going
// back from the newest sample over samples of a game that is not paused on a
// page that is shown, each of which woke the loop (a sleeping loop does not
// turn either, and one that was not woken says nothing) and found the
// emulator not paused by anyone. 0 when it turns, or when that cannot be told.
export function stuckSeconds(samples) {
  const turns = (sample) => (sample.diag && sample.diag.exits && sample.diag.exits.loopWoken === true && !sample.diag.exits.loopPaused
    && Number.isFinite(sample.diag.exits.loopTurns) ? sample.diag.exits.loopTurns : null);
  const last = samples[samples.length - 1];
  if (!last || !last.running || last.hidden || turns(last) === null) return 0;
  let first = last;
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i];
    if (!sample.running || sample.hidden || sample.app !== last.app || turns(sample) !== turns(last)) break;
    first = sample;
  }
  return (last.t - first.t) / 1000;
}

// The emulator's "exits" as the section's data: times as "seconds ago"; the
// endings marked that are of the game on the page (`current`) and of its
// present run, not one before a restart (`thisRun`); the threads
// marked that belong to that game as it runs now, since `launchedMs`
// (`inGame`), and that ended together with their program (`withProgram`).
export function readExits(exits, nowMs, gameUid, launchedMs = 0) {
  if (!exits || !Array.isArray(exits.lastApps)) return null;
  const agoS = (at) => (Number.isFinite(at) ? Math.max(0, Math.round((nowMs - at) / 100) / 10) : null);
  const uidOf = (text) => (text ? Number(text) : NaN);
  const same = (a, b) => Number.isFinite(uidOf(a)) && uidOf(a) === uidOf(b);
  const ending = (end) => ({
    agoS: agoS(end.at),
    uid: end.uid || null,
    type: end.type,
    category: cut(end.category, 80),
    reason: Number.isFinite(end.reason) ? end.reason : 0,
    fault: Boolean(end.fault),
    description: end.description ? cut(end.description, 120) : null,
  });
  // `launched` is the application the page started; the process that ended
  // can be another (a program that application started).
  const apps = exits.lastApps.map((end) => ({ ...ending(end), name: cut(end.name, 80), current: same(end.launched || end.uid, gameUid), thisRun: end.at >= launchedMs }));
  const threads = (exits.lastThreads || []).map((end) => ({
    ...ending(end),
    process: cut(end.process, 80),
    thread: cut(end.thread, 80),
    inGame: same(end.uid, gameUid) && end.at >= launchedMs,
    withProgram: exits.lastApps.some((app) => same(app.uid, end.uid) && app.at >= end.at && app.at - end.at <= SAME_EVENT_MS),
  }));
  return {
    count: exits.apps || 0,
    last: apps,
    threads: exits.threads || 0,
    threadPanics: exits.threadPanics || 0,
    threadFaults: exits.threadFaults || 0,
    lastThreads: threads,
  };
}

// --- what the page hears --------------------------------------------------------

// Made in init(): the section's memory. Null in a test or before the page
// has loaded, where collect() only reports what it is handed.
let heard = null;

function hearPageErrors(target) {
  const state = { errors: 0, loader: 0, last: [], probe: null };
  const keep = (kind, message, where) => {
    // An error in the emulator's own loader is the emulator's failure and not
    // a script error of the page; whether one of its threads broke off, the
    // client knows (emu.broken). Counted apart.
    if (where && /^eka2l1_web\.js:/.test(where)) {
      state.loader++;
      return;
    }
    state.errors++;
    state.last.push({ t: performance.now(), kind, message: cut(message), where: where || null });
    if (state.last.length > KEEP_ERRORS) state.last.shift();
  };
  // Neither listener stops the event: the console still shows the error, and
  // a test that watches for page errors still sees it.
  target.addEventListener('error', (event) => {
    // An image or a script that did not load also ends here, without a message.
    if (!event.message && !event.error) return;
    // Browsers report this when a layout takes a second pass; nothing failed.
    if (/^ResizeObserver loop/.test(event.message || '')) return;
    const where = event.filename ? `${fileOf(event.filename)}:${event.lineno || 0}` : null;
    keep('error', event.message || String(event.error), where);
  });
  target.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    const message = reason && reason.message ? `${reason.name || 'Error'}: ${reason.message}` : String(reason);
    // The first place of the stack that names a file.
    const place = reason && typeof reason.stack === 'string' ? /([^\s()/\\]+\.m?js)[^:\s]*:(\d+)/.exec(reason.stack) : null;
    keep('rejection', message, place ? `${place[1]}:${place[2]}` : null);
  });
  return state;
}

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// For how long the emulator has not answered a request, in seconds; 0 while
// samples arrive or it answers. The request that finds out stays open, so an
// emulator that has stopped is asked once and not every second.
async function silentSeconds(ctx, state) {
  // An emulator that has said it stopped is not asked: that is known, and
  // the visitor who opens the dialog to read why must not wait for it.
  if (!ctx.emu || ctx.emu.aborted || ctx.emu.broken || ctx.started === null || !state) return 0;
  const last = ctx.samples[ctx.samples.length - 1];
  if ((last ? ctx.now - last.t : ctx.now - ctx.started) < FRESH_MS) {
    state.probe = null;
    return 0;
  }
  if (!state.probe) {
    const probe = { sent: performance.now(), answered: false };
    state.probe = probe;
    try {
      const answer = ctx.emu.request('GET', '/v1/web/diag').then(() => { probe.answered = true; }, () => {});
      await Promise.race([answer, sleep(SILENT_S * 1000)]);
    } catch {
      // The module no longer takes a call at all.
    }
  }
  if (state.probe.answered) {
    // It answers: the samples were only late (a tab in the background).
    state.probe = null;
    return 0;
  }
  return Math.round((performance.now() - state.probe.sent) / 100) / 10;
}

// --- the section ------------------------------------------------------------------

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export default {
  id: 'errors',
  title: 'Errors',
  order: 50,

  init() {
    if (!heard) heard = hearPageErrors(window);
  },

  async collect(ctx) {
    const emu = ctx.emu;
    if (!emu && !(heard && heard.errors)) return null;

    const last = ctx.samples[ctx.samples.length - 1] || null;
    const part = last && last.diag && last.diag.exits ? last.diag.exits : null;
    const sinceS = (t) => Math.max(0, Math.round((ctx.now - t) / 100) / 10);

    const tail = emu && Array.isArray(emu.logTail) ? emu.logTail.slice(-SHOWN_LOG).map((entry) => shortLogLine(entry.line) + (entry.times > 1 ? ` (×${entry.times})` : '')) : [];
    const stuckS = stuckSeconds(ctx.samples);
    return {
      game: ctx.game ? ctx.game.name : null,
      // The game on the page has ended and was not started again.
      ended: Boolean(ctx.page.ended && !ctx.page.ended.stopped),
      exits: readExits(part, Date.now(), ctx.game ? ctx.game.uid : null, ctx.page.launched || 0),
      calls: part && Number.isFinite(part.unimplementedCalls) ? {
        total: part.unimplementedCalls,
        list: (part.unimplemented || []).map((entry) => ({ call: String(entry.call), count: entry.count })),
      } : null,
      emulator: emu ? {
        stopped: part && part.stopped ? { agoS: Math.max(0, Math.round((Date.now() - part.stopped.at) / 100) / 10), message: cut(part.stopped.message) } : null,
        aborted: emu.aborted ? { agoS: sinceS(emu.aborted.t), message: cut(emu.aborted.message) } : null,
        broken: emu.broken ? { agoS: sinceS(emu.broken.t), message: cut(emu.broken.message) } : null,
        silentS: await silentSeconds(ctx, heard),
        stuckS: Math.round(stuckS * 10) / 10,
      } : null,
      page: {
        errors: heard ? heard.errors : 0,
        // Errors in the emulator's own loader, which are not the page's.
        loader: heard ? heard.loader : 0,
        last: heard ? heard.last.map((error) => ({ agoS: sinceS(error.t), kind: error.kind, message: error.message, where: error.where })) : [],
      },
      log: emu && Array.isArray(emu.logTail) ? {
        lines: emu.logLines || 0,
        errors: tail.filter((line) => logLevel(line) === 'E').length,
        warnings: tail.filter((line) => logLevel(line) === 'W').length,
        last: tail,
      } : null,
    };
  },

  findings(data) {
    const found = [];
    const name = data.game || 'The game';
    const emulator = data.emulator;

    // The emulator itself: what it said last decides the wording.
    if (emulator && (emulator.stopped || emulator.aborted || emulator.broken || emulator.silentS >= SILENT_S || emulator.stuckS >= STUCK_S)) {
      // An abort often has no text of its own; the thread that broke off has.
      const said = [emulator.stopped, emulator.aborted, emulator.broken].find((entry) => entry && entry.message) || emulator.stopped || emulator.aborted || emulator.broken;
      const memory = Boolean(said) && /out of memory|\bOOM\b|allocat/i.test(said.message);
      found.push({
        code: 'emulator-stopped',
        level: 'bad',
        title: 'The emulator has stopped',
        detail: said ? `It gave up ${ago(said.agoS)}${said.message ? ` with: ${said.message}` : ''}.`
          : emulator.silentS >= SILENT_S ? `It has not answered for ${Math.round(emulator.silentS)} seconds.`
            : `It has not run the game for ${Math.round(emulator.stuckS)} seconds, although the game is not paused.`,
        advice: memory ? 'The browser had no more memory for it. Close other tabs and programs, then reload the page.'
          : 'Reload the page to start again. If it stops again at the same place in the game, send us this report and say what you did just before.',
      });
    }

    const exits = data.exits;
    if (exits) {
      const crashes = exits.last.filter(crashed);
      const others = exits.last.filter((end) => !crashed(end));
      // A thread of the running game that crashed while the game went on.
      const lone = exits.lastThreads.filter((end) => end.inGame && !end.withProgram && crashed(end));
      // An ending can be of a game played before this one on the same page:
      // then it is not called by this game's name.
      const who = (end) => (end.current ? name : 'A game played before');
      const which = (end) => (end.current ? '' : ` (${end.name})`);
      const since = (end) => (end.current && !end.thisRun ? ' It has been started again since.' : '');

      if (crashes.length) {
        const end = crashes[crashes.length - 1];
        const times = crashes.filter((other) => other.current === end.current && other.uid === end.uid).length;
        found.push({
          code: 'game-crashed',
          level: 'bad',
          title: `${who(end)} crashed`,
          detail: `It${which(end)} ended ${ago(end.agoS)} with ${endingText(end)}.`
            + (times > 1 ? ` It crashed ${exits.count > exits.last.length ? 'at least ' : ''}${times} times since the page was loaded.` : '') + since(end),
          advice: 'Menu → Restart game starts it again. A crash that comes back at the same place is most likely a fault of the emulator with this game and not of your device: send us this report and say what you did just before.',
        });
      } else if (lone.length) {
        const end = lone[lone.length - 1];
        found.push({
          code: 'game-crashed',
          level: 'bad',
          title: `A part of ${name === 'The game' ? 'the game' : name} crashed`,
          detail: `One of its threads (${end.thread}) ended ${ago(end.agoS)} with ${endingText(end)}. The game itself went on, and may stand still or miss something since.`,
          advice: 'Menu → Restart game starts it again. If it comes back at the same place, send us this report and say what you did just before.',
        });
      }

      if (others.length) {
        const end = others[others.length - 1];
        const clean = end.reason === 0;
        found.push({
          code: 'game-exited',
          level: clean ? 'info' : 'warn',
          title: `${who(end)} closed by itself`,
          detail: (clean ? `It${which(end)} ended ${ago(end.agoS)} without an error, as it does when "Exit" is chosen in its menu.`
            : `It${which(end)} ended ${ago(end.agoS)} with ${endingText(end)}.`) + since(end),
          advice: clean ? 'Menu → Restart game starts it again.'
            : 'Menu → Restart game starts it again. If you did not close it yourself, send us this report and say what you did just before.',
        });
      }
    }

    if (data.page.errors > 0) {
      const error = data.page.last[data.page.last.length - 1];
      found.push({
        code: 'page-errors',
        level: 'warn',
        title: 'The page ran into script errors',
        detail: `${plural(data.page.errors, 'error')} since it was loaded. The last, ${ago(error.agoS)}: ${error.message}${error.where ? ` (${error.where})` : ''}.`,
        advice: 'Reload the page. If something changes the pages you visit (a browser extension, a translator), try with it switched off for this site. If the errors stay, send us this report.',
      });
    }

    if (data.calls && data.calls.total > 0) {
      const list = data.calls.list.map((entry) => `${entry.call} ×${entry.count}`).join(', ');
      found.push({
        code: 'unimplemented-calls',
        level: 'info',
        title: 'The game uses system functions the emulator does not have',
        detail: `${plural(data.calls.total, 'call')} so far${list ? ` (${list})` : ''}.`,
        advice: 'Many games make a few of these and run well. It matters only when the game also crashes, stands still or lacks something: then send us this report.',
      });
    }

    return found;
  },

  render(data) {
    const list = [];
    const exits = data.exits;
    const emulator = data.emulator;

    if (emulator) {
      const said = [emulator.stopped, emulator.aborted, emulator.broken].find((entry) => entry && entry.message) || emulator.stopped || emulator.aborted || emulator.broken;
      list.push(said ? { label: 'Emulator', value: `stopped ${ago(said.agoS)}`, note: said.message, mark: 'bad' }
        : emulator.silentS >= SILENT_S ? { label: 'Emulator', value: `no answer for ${Math.round(emulator.silentS)} s`, mark: 'bad' }
          : emulator.stuckS >= STUCK_S ? { label: 'Emulator', value: `has not run the game for ${Math.round(emulator.stuckS)} s`, mark: 'bad' }
            : { label: 'Emulator', value: 'running', mark: 'ok' });
    }

    if (exits) {
      const shown = exits.last.slice(-3);
      list.push(shown.length ? null : { label: 'Game', value: 'has not closed or crashed', mark: 'ok' });
      for (const end of shown) {
        list.push({
          label: end.current ? (data.game || 'Game') : end.name,
          value: `${crashed(end) ? 'crashed' : 'closed'} ${ago(end.agoS)}`,
          note: endingText(end),
          mark: crashed(end) ? 'bad' : end.reason === 0 ? null : 'warn',
        });
      }
      const odd = exits.lastThreads.filter((end) => !end.withProgram).slice(-3);
      list.push({
        label: 'Threads of the phone that ended',
        value: `${exits.threads}, of them ${plural(exits.threadPanics, 'panic')} and ${plural(exits.threadFaults, 'processor fault')}`,
        note: odd.map((end) => `${end.process} / ${end.thread}: ${endingText(end)}, ${ago(end.agoS)}`).join(' · '),
        mark: odd.some((end) => end.inGame && crashed(end)) ? 'bad' : null,
      });
    }

    if (data.calls) {
      list.push({
        label: 'Calls to system functions the emulator does not have',
        value: String(data.calls.total),
        note: data.calls.list.map((entry) => `${entry.call} ×${entry.count}`).join(', '),
      });
    }

    const error = data.page.last[data.page.last.length - 1];
    list.push(error ? { label: 'Page errors', value: String(data.page.errors), note: `${error.message}${error.where ? ` (${error.where})` : ''}, ${ago(error.agoS)}`, mark: 'warn' }
      : { label: 'Page errors', value: 'none', mark: 'ok' });

    if (data.log) {
      const lastError = [...data.log.last].reverse().find((line) => logLevel(line) === 'E');
      list.push({
        label: 'Emulator log',
        value: `${plural(data.log.lines, 'line')}; the last ${data.log.last.length} are in the report (${plural(data.log.errors, 'error')}, ${plural(data.log.warnings, 'warning')})`,
        note: lastError ? `Last error: ${lastError}` : '',
      });
    }

    return [rows(list)];
  },
};
