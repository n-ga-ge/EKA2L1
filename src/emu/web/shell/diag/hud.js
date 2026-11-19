// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The performance overlay: the diagnostics' main numbers in a corner of the
// stage while the game is played, so that the numbers are seen to move while
// the visitor does the thing that is slow.
//
//   19.8 fps      avg 18.4 · low 12.1    frames per second now, and over the
//                                        last stretch of play (core.js: span)
//   [graph]                              frames per second, the last two
//                                        minutes, one column a sample; seconds
//                                        in which the game was paused or the
//                                        page in the background are shaded
//   frame 50 ms · longest 183 ms         the time from one frame to the next
//   [graph]                              the last frames, one column each;
//                                        long ones in another colour
//   drawing 3.4 ms a frame               LINES below: one line a number
//   ✗ The device is too slow …           the worst findings, by their titles
//
// It is switched on with ?diag=1 in the address (?diag=0 switches it off) or
// with the menu's entry, which also remembers the choice (settings.js): a
// visitor who was asked to watch it goes from game to game, and each game is
// a new page. The address decides for one visit and is not remembered.
//
// What it costs. Off: nothing, it listens to nothing and has built nothing.
// On: it redraws once a second with the diagnostics' own sample (and when the
// page comes back from the background), asks for the findings every few
// seconds, and, only while a game is running and the page is shown, reads the
// frame counter on every animation frame, which is what the frame times are
// made from (a sample a second is too coarse for them).
// That loop ends with the game, a pause or the overlay, and the browser stops
// it by itself while the page is hidden. Nothing reads the layout: the
// graphs are canvases of a fixed size drawn with 2D calls.
//
// The element is #hud in the stage (index.html), between the "Paused" layer
// and the loader, so the loader covers it. It takes no pointer events.
//
// Everything above setupHud() is plain arithmetic and touches neither the
// document nor the window, so a test can import this file (shell-tests/hud.test.mjs).

import { measure as measureSound } from './audio.js';
import { frameRates, span } from './core.js';
import { el, number, percent } from './dom.js';
import { measure as measureSpeed } from './speed.js';

export const WINDOW_MS = 120000; // what the rate graph spans: the samples core.js keeps
const GRAPH_WIDTH = 172; // CSS pixels, both graphs
const GRAPH_HEIGHT = 26;
export const FRAMES_KEPT = GRAPH_WIDTH; // one column a frame
const TICK_GAP_MS = 1000; // the frame counter was not read for this long: nothing is known about the time between
const REDRAW_MS = 250; // the frame graph is redrawn this often at most
const FINDINGS_EVERY = 5; // samples, so seconds, between two questions for the findings
const FINDINGS_SHOWN = 2;
// A frame is long when it took more than this many typical ones. Not a whole
// number: frame times are multiples of the screen's refresh interval, and a
// frame that slipped by one interval must not sit exactly on the line.
const LONG_FRAME = 2.5;
const STALE_MS = 3000; // no sample for this long: the numbers shown are not "now" any more

// The top of a graph is the first of these that the data fits under, so that
// the scale reads as a round number and does not move with every sample.
const RATE_STEPS = [10, 15, 20, 30, 60, 120, 240];
const FRAME_STEPS = [25, 50, 100, 150, 200, 300, 500, 1000, 2000, 5000];

// One hue for what is measured, one for what stands out, a wash for the
// seconds that do not count. Text is never drawn in them.
const COLOURS = { series: '#6cb4ff', long: '#f2c66d', shade: 'rgba(154, 161, 171, .3)', label: '#c9ced6', plate: 'rgba(8, 10, 12, .7)' };
const MARKS = { bad: '✗', warn: '!', info: '·' };

// Whether the overlay is shown when the page loads: the address decides when
// it says anything, else the remembered choice.
export function wanted(params, stored) {
  const asked = params.get('diag');
  if (asked === '1') return true;
  if (asked === '0') return false;
  return stored === true;
}

// An address's query (location.search) without its `diag` parameter, the
// rest left as it was written.
export function withoutDiag(search) {
  const kept = search.replace(/^\?/, '').split('&').filter((part) => part && part !== 'diag' && !part.startsWith('diag='));
  return kept.length ? `?${kept.join('&')}` : '';
}

export function ceiling(value, steps) {
  return steps.find((step) => step >= value) ?? steps[steps.length - 1];
}

// The rate graph's columns from the diagnostics' samples: one for each pair
// of neighbours, placed by time (`from` and `to` are shares of the window,
// which ends at the newest sample), because a page in the background is
// sampled less often than once a second. `state` says what the game did in
// that time: 'play', 'none' (no game was running: nothing to draw), 'hidden'
// (the page was in the background, whatever the game did) or 'idle' (paused,
// or one game ended and another began).
export function rateColumns(samples, windowMs = WINDOW_MS) {
  const columns = [];
  if (samples.length < 2) return columns;
  const start = samples[samples.length - 1].t - windowMs;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1];
    const b = samples[i];
    if (!(b.t > a.t) || b.t <= start) continue;
    const fps = ((b.frames - a.frames) * 1000) / (b.t - a.t);
    columns.push({
      from: Math.max(0, (a.t - start) / windowMs),
      to: (b.t - start) / windowMs,
      fps: Number.isFinite(fps) && fps > 0 ? fps : 0,
      state: a.app == null || b.app == null ? 'none' : a.hidden || b.hidden ? 'hidden' : a.running && b.running && a.app === b.app ? 'play' : 'idle',
    });
  }
  return columns;
}

// The head line's numbers, or null when the game is not being played right
// now (the newest sample is not of a running game, or it is the first of
// one): frames per second in the last second, and on average and in the worst
// second of the last stretch of play, as the dialog's Session part has them.
export function summary(samples) {
  const last = samples[samples.length - 1];
  const stretch = span(samples);
  if (!last || !stretch || stretch.b !== last) return null;
  const rates = frameRates(stretch.samples);
  if (!rates.length) return null;
  return {
    fps: rates[rates.length - 1],
    average: (stretch.b.frames - stretch.a.frames) / stretch.seconds,
    worst: Math.min(...rates),
    seconds: stretch.seconds,
    stretch,
  };
}

// Milliseconds the graphics thread worked for each frame of a stretch, or
// null when no frame was drawn in it or the build does not count the time.
export function drawCost(stretch) {
  const frames = stretch.b.frames - stretch.a.frames;
  const busy = stretch.b.graphicsBusyMs - stretch.a.graphicsBusyMs;
  return frames > 0 && Number.isFinite(busy) && busy >= 0 ? busy / frames : null;
}

// One line each, under the graphs, for a number worth watching while playing.
// `text(stretch)` gets the last stretch of play (core.js: span(); its samples
// carry the emulator's counters in `diag`) and returns the line, or null when
// the number is not known, which leaves the line out: `diag` is null on a
// build without the counters, and the sound is only judged while it plays.
export const LINES = [
  {
    // How much of the time the emulated phone's processor did not wait
    // (speed.js). Near 100% the device sets the game's pace.
    id: 'processor',
    text(stretch) {
      const data = stretch.samples && stretch.samples.every((sample) => sample.diag && sample.diag.speed) ? measureSpeed(stretch.samples) : null;
      return data && Number.isFinite(data.busy) ? `phone's processor ${percent(data.busy)} busy` : null;
    },
  },
  {
    // Gaps heard in the sound over the stretch (audio.js).
    id: 'sound',
    text(stretch) {
      const data = stretch.samples ? measureSound(stretch.samples) : null;
      if (!data || !Number.isFinite(data.gaps)) return null;
      return data.gaps > 0 ? `sound: ${data.gaps} ${data.gaps === 1 ? 'gap' : 'gaps'}` : 'sound: no gaps';
    },
  },
  {
    id: 'draw',
    text(stretch) {
      const ms = drawCost(stretch);
      return ms === null ? null : `drawing ${number(ms, 1)} ms a frame`;
    },
  },
];

// The time between the frames the game presents, from readings of the frame
// counter. Each reading that finds the counter moved gives the time since the
// reading that last did, shared out over the frames presented since: so a
// frame's time is known to within one reading (an animation frame, 17 ms on
// most screens), and a page that was held up for a while spreads the time
// evenly over the frames it missed. `list` holds the last `capacity` times in
// milliseconds, oldest first, with null where they do not join up: a pause,
// or readings that stopped for more than a second (the page was hidden).
export class Pacer {
  constructor(capacity = FRAMES_KEPT) {
    this.capacity = capacity;
    this.list = [];
    this.changed = false; // something was added since the reader last set this to false
    this.readAt = null; // the last reading; null: not reading
    this.frames = 0;
    this.frameAt = null; // the reading that last saw a frame; null: waiting for the first
  }

  // A reading: `now` in milliseconds, `frames` the counter.
  tick(now, frames) {
    if (this.readAt === null || now - this.readAt > TICK_GAP_MS || frames < this.frames) {
      // Starting, or starting again: the next frame seen is where the
      // measuring begins, because when the one before it came is not known.
      this.rest();
      this.readAt = now;
      this.frames = frames;
      return;
    }
    this.readAt = now;
    const count = frames - this.frames;
    if (count <= 0) return;
    if (this.frameAt !== null) {
      const each = (now - this.frameAt) / count;
      for (let i = Math.min(count, this.capacity); i > 0; i--) this.list.push(each);
      this.trim();
      this.changed = true;
    }
    this.frames = frames;
    this.frameAt = now;
  }

  // The readings stop (a pause, the game ended, the overlay was closed): what
  // comes after does not join up with what is there.
  rest() {
    this.readAt = null;
    this.frameAt = null;
    if (this.list.length && this.list[this.list.length - 1] !== null) {
      this.list.push(null);
      this.trim();
      this.changed = true;
    }
  }

  trim() {
    if (this.list.length > this.capacity) this.list.splice(0, this.list.length - this.capacity);
  }
}

// What a list of frame times says: the typical one (the median), the longest,
// the time above which a frame counts as long (LONG_FRAME typical ones) and
// the top of the graph they are drawn in; null when there is none.
export function pacing(list) {
  const times = list.filter((ms) => ms !== null).sort((a, b) => a - b);
  if (!times.length) return null;
  const typical = times[Math.floor(times.length / 2)];
  return {
    typical,
    longest: times[times.length - 1],
    longAbove: typical * LONG_FRAME,
    top: ceiling(typical * 3 - 1, FRAME_STEPS),
  };
}

// The lines that have something to say about a stretch. A line that fails is
// left out: it must not take the overlay with it.
export function lineTexts(stretch, lines = LINES) {
  const texts = [];
  for (const line of lines) {
    try {
      const text = line.text(stretch);
      if (text) texts.push(String(text));
    } catch (error) {
      console.warn(`diagnostics: the overlay's line ${line.id} failed`, error);
    }
  }
  return texts;
}

// The findings the overlay has room for: the worst ones (collect() gives them
// worst first) and how many more there are.
export function topFindings(findings, max = FINDINGS_SHOWN) {
  return {
    shown: findings.slice(0, max).map((finding) => ({ level: finding.level, title: finding.title })),
    more: Math.max(0, findings.length - max),
  };
}

// --- the page's part -------------------------------------------------------------

// Sets a canvas's bitmap to its size on the page times the screen's pixel
// ratio and returns the ratio. The size on the page is fixed by the style
// sheet, so this reads no layout.
function fit(canvas) {
  const ratio = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const width = Math.round(GRAPH_WIDTH * ratio);
  const height = Math.round(GRAPH_HEIGHT * ratio);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return ratio;
}

// The top of a graph's scale, in its corner, on a plate so that it reads over
// the columns behind it.
function scaleLabel(ctx, text, ratio) {
  ctx.font = `${9 * ratio}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  const width = ctx.measureText(text).width;
  ctx.fillStyle = COLOURS.plate;
  ctx.fillRect(0, 0, width + 4 * ratio, 11 * ratio);
  ctx.fillStyle = COLOURS.label;
  ctx.fillText(text, 2 * ratio, ratio);
}

function drawRates(canvas, columns) {
  const ratio = fit(canvas);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  columns = columns.filter((column) => column.state !== 'none');
  if (!columns.length) return;
  const top = ceiling(Math.max(...columns.map((column) => column.fps)), RATE_STEPS);
  for (const column of columns) {
    const left = Math.floor(column.from * width);
    const wide = Math.max(1, Math.floor(column.to * width) - left);
    if (column.state !== 'play') {
      ctx.fillStyle = COLOURS.shade;
      ctx.fillRect(left, 0, wide, height);
    }
    const high = Math.round(Math.min(1, column.fps / top) * height);
    if (high > 0) {
      ctx.fillStyle = COLOURS.series;
      ctx.fillRect(left, height - high, wide, high);
    }
  }
  scaleLabel(ctx, `${top} fps`, ratio);
}

function drawFrames(canvas, list, pace) {
  const ratio = fit(canvas);
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  if (!pace) return;
  // The newest frame is at the right edge, one CSS pixel a frame: a column's
  // edges are rounded one by one, so that the whole list fits the width at
  // any pixel ratio.
  let left = Math.round(width - list.length * ratio);
  for (let i = 0; i < list.length; i++) {
    const ms = list[i];
    const right = Math.round(width - (list.length - 1 - i) * ratio);
    if (ms !== null) {
      const high = Math.max(1, Math.round(Math.min(1, ms / pace.top) * height));
      ctx.fillStyle = ms > pace.longAbove ? COLOURS.long : COLOURS.series;
      ctx.fillRect(left, height - high, Math.max(1, right - left), high);
    }
    left = right;
  }
  scaleLabel(ctx, `${pace.top} ms`, ratio);
}

class Hud {
  // `root` is the overlay's element, `button` the menu's entry (or null),
  // `remember(on)` stores the visitor's choice (and returns nothing).
  constructor(diag, root, button, remember) {
    this.diag = diag;
    this.page = diag.page;
    this.root = root;
    this.button = button;
    this.remember = remember;
    this.on = false;
    this.parts = null; // built when it is first shown
    this.pacer = new Pacer();
    this.stopListening = null;
    this.frame = 0; // the animation frame asked for, 0 when the loop is not running
    this.drawnAt = 0;
    this.sinceFindings = 0;
    this.asking = false;
    this.game = null; // the uid of the game the findings shown are about
    this.sampledAt = 0; // when the last sample came
    this.askedAt = 0;
    this.texts = new Map(); // what each text node shows, so that nothing is written twice
    this.tick = this.tick.bind(this);
    // A page that goes to the background stops the frame times there, however
    // short the time (no animation frame comes to notice it); one that comes
    // back shows what happened meanwhile at once.
    this.seen = () => {
      if (document.hidden) {
        this.pacer.rest();
      } else {
        this.sampledAt = performance.now(); // a page in the background is sampled rarely: that is not the emulator's silence
        this.update();
      }
    };

    if (button) {
      button.addEventListener('click', () => {
        const menu = button.closest('dialog');
        if (menu) menu.close();
        this.set(!this.on);
        this.remember(this.on);
      });
    }
    this.label();
  }

  label() {
    if (!this.button) return;
    this.button.textContent = this.on ? 'Hide performance overlay' : 'Show performance overlay';
    this.button.setAttribute('aria-pressed', String(this.on));
  }

  toggle() {
    this.set(!this.on);
  }

  set(on) {
    on = Boolean(on);
    if (on === this.on) return;
    this.on = on;
    this.label();
    if (on) {
      if (!this.parts) this.build();
      this.stopListening = this.diag.onSample((sample) => this.sample(sample));
      document.addEventListener('visibilitychange', this.seen);
      this.forget();
      this.sampledAt = performance.now();
      this.update();
    } else {
      this.stopListening();
      this.stopListening = null;
      document.removeEventListener('visibilitychange', this.seen);
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.pacer.rest();
      this.root.hidden = true;
    }
  }

  build() {
    const parts = {
      fps: el('b', null, '–'),
      unit: el('span', null, ' fps'),
      stretch: el('small'),
      rates: el('canvas', { class: 'hud-rates' }),
      shaded: el('small', { hidden: true }, 'shaded: paused or page hidden'),
      pace: el('div'),
      frames: el('canvas', { class: 'hud-frames' }),
      lines: el('div'),
      found: el('ul'),
    };
    this.root.replaceChildren(
      el('div', { class: 'hud-head' }, el('span', null, parts.fps, parts.unit), parts.stretch),
      parts.rates, parts.shaded, parts.pace, parts.frames, parts.lines, parts.found);
    this.parts = parts;
  }

  // Drops the findings shown, which were about another game or another time,
  // and asks again with the next sample.
  forget() {
    this.game = null;
    this.texts.delete(this.parts.found);
    this.parts.found.replaceChildren();
    this.sinceFindings = FINDINGS_EVERY;
  }

  // Writes a text only when it changed: an overlay that says the same as a
  // second ago costs no layout.
  write(node, text) {
    if (this.texts.get(node) === text) return;
    this.texts.set(node, text);
    node.textContent = text;
  }

  // Every second, with the diagnostics' sample.
  sample(sample) {
    if (!this.on) return;
    this.sampledAt = sample.t;
    this.update();
    if (this.root.hidden || sample.hidden) return;
    // A paused game's findings do not change, except that there are none yet.
    if (this.page.paused && this.game !== null) return;
    if (++this.sinceFindings >= FINDINGS_EVERY) this.ask();
  }

  // Shows what is known now. The overlay is over the picture only while a
  // game is running; nothing is drawn for a page nobody sees.
  update() {
    const page = this.page;
    const shown = Boolean(page.emu && page.app);
    if (this.root.hidden === shown) this.root.hidden = !shown;
    if (!shown) {
      // The game ended: what was found belongs to that run of it.
      this.pacer.rest();
      if (this.game !== null) this.forget();
      return;
    }
    if (this.game !== null && this.game !== page.app.uid) this.forget();
    if (document.hidden) return;
    const { parts } = this;
    const samples = this.diag.samples;

    const now = summary(samples);
    this.write(parts.fps, page.paused ? 'paused' : now ? number(now.fps, 1) : '–');
    this.write(parts.unit, page.paused ? '' : ' fps');
    this.write(parts.stretch, now && now.seconds >= 2 ? `avg ${number(now.average, 1)} · low ${number(now.worst, 1)}` : '');

    const columns = rateColumns(samples);
    drawRates(parts.rates, columns);
    const shaded = columns.some((column) => column.state === 'idle' || column.state === 'hidden');
    if (parts.shaded.hidden === shaded) parts.shaded.hidden = !shaded;

    this.drawPace();

    const lines = now ? lineTexts(now.stretch) : [];
    const text = lines.join('\n');
    if (this.texts.get(parts.lines) !== text) {
      this.texts.set(parts.lines, text);
      parts.lines.replaceChildren(...lines.map((line) => el('div', null, line)));
    }

    if (!page.paused && !this.frame) this.frame = requestAnimationFrame(this.tick);
  }

  // The frame times, as a line and as a graph.
  drawPace() {
    const pace = pacing(this.pacer.list);
    this.pacer.changed = false;
    this.write(this.parts.pace, pace ? `frame ${number(pace.typical)} ms · longest ${number(pace.longest)} ms` : 'frame times: waiting for frames');
    drawFrames(this.parts.frames, this.pacer.list, pace);
  }

  // Every animation frame while a game is being played and the overlay is
  // on: one reading of the frame counter, and the frame graph when it is due.
  tick(now) {
    this.frame = 0;
    const page = this.page;
    if (!this.on || !page.emu || !page.app || page.paused) {
      this.pacer.rest();
      if (this.on) this.update(); // says "paused" now and not with the next sample
      return;
    }
    // The samples stopped (the emulator does not answer): the head line must
    // not go on showing the last rate as if it were measured now, and the
    // findings, which may say why, are asked for from here.
    if (now - this.sampledAt > STALE_MS && now - this.askedAt > FINDINGS_EVERY * 1000) {
      this.write(this.parts.fps, '–');
      this.write(this.parts.stretch, 'no measurement');
      this.ask();
    }
    this.pacer.tick(now, page.emu.frames());
    if (this.pacer.changed && now - this.drawnAt >= REDRAW_MS) {
      this.drawnAt = now;
      this.drawPace();
    }
    this.frame = requestAnimationFrame(this.tick);
  }

  // The findings, every few seconds: the titles of the worst ones. Not while
  // the dialog is open, which covers the overlay and asks every second itself.
  async ask() {
    const dialog = this.diag.ui && this.diag.ui.dialog;
    if (this.asking || (dialog && dialog.open)) return;
    this.asking = true;
    this.sinceFindings = 0;
    this.askedAt = performance.now();
    const game = this.page.app ? this.page.app.uid : null;
    try {
      const { ctx, findings } = await this.diag.collect();
      // An answer about a game that is gone by now, or for an overlay that is, is dropped.
      if (!this.on || !this.page.app || this.page.app.uid !== game) return;
      this.game = game;
      const { shown, more } = topFindings(findings);
      const stretch = ctx.span();
      const items = shown.map((finding) => ({ mark: finding.level, text: finding.title }));
      if (more) items.push({ mark: null, text: `${more} more: Menu → Diagnostics` });
      if (!items.length) items.push({ mark: null, text: stretch && stretch.seconds >= 10 ? 'Nothing wrong found.' : 'Measuring…' });
      const text = items.map((item) => `${item.mark} ${item.text}`).join('\n');
      if (this.texts.get(this.parts.found) === text) return;
      this.texts.set(this.parts.found, text);
      this.parts.found.replaceChildren(...items.map((item) => (item.mark
        ? el('li', null, el('span', { class: item.mark }, MARKS[item.mark]), el('span', null, item.text))
        : el('li', { class: 'note' }, item.text))));
    } catch (error) {
      console.warn('diagnostics: the overlay got no findings', error);
    } finally {
      this.asking = false;
    }
  }
}

// Called once when the page loads, with the page's Diagnostics object
// (core.js) and the page's address parameters. The overlay is then at
// eka2l1Page.hud ({ on, set(on), toggle() }) for the console and for tests.
export function setupHud(diag, params) {
  const root = document.getElementById('hud');
  if (!root) return;
  // Loaded here and not at the top, because settings.js reads the browser's
  // storage when it is loaded, which a test outside a browser has none of.
  import('../settings.js').then(({ settings, saveSettings }) => {
    const hud = new Hud(diag, root, document.getElementById('m-hud'), (on) => {
      settings.overlay = on;
      saveSettings();
      // The choice replaces what the address said: with ?diag still there, a
      // reload would undo it. `params` is the page's own copy of the address
      // (app.js puts its parameters into the links it makes).
      if (!params.has('diag')) return;
      params.delete('diag');
      history.replaceState(history.state, '', location.pathname + withoutDiag(location.search) + location.hash);
    });
    diag.page.hud = hud;
    hud.set(wanted(params, settings.overlay));
  }).catch((error) => console.warn('diagnostics: the overlay could not be set up', error));
}
