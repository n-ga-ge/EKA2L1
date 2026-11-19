// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: how the picture is drawn and what that costs.
//
// The game's picture goes to the page in three steps, and each can hold the
// game back:
//   - the game hands a frame to the graphics thread, and first waits until
//     the frame before was presented (the emulator times that wait);
//   - the graphics thread draws it when the browser calls it for an animation
//     frame, or by a timer when the browser gives none (a page it does not
//     show); the emulator counts both, and the time spent drawing;
//   - the browser draws with the graphics card, or on the processor when it
//     has none to use (support.js reads the renderer's name).
// core.js describes what a section is.

import { number, percent, rows } from './dom.js';

// "Now" for whether the browser gives animation frames: long enough for a
// few readings, short enough that the dialog shows what the visitor just did.
const RECENT_S = 5;

// Slow drawing shows in one of two ways, and each has its own sign.
//
// On the processor (software rendering) drawing holds the graphics thread:
// its calls into WebGL return when the work is done. The thread is then busy
// this share of the time or more (a fifth: on a graphics card it is a
// twentieth), and half of the time is bad. How long the game waits meanwhile
// varies from run to run, probably because the processor that draws is also
// taken from the game, which then has less to wait for.
const BUSY_SLOW = 0.2;
const BUSY_BAD = 0.5;
// On a graphics card that cannot keep up the thread stays free, and the
// browser calls for fewer animation frames instead: fewer than this a second
// (a display is drawn 60 times a second or more; 30 on some in a saving
// mode). What the game asks of the graphics thread is answered at the next
// call, so the game then stands still for it: this share of the time or
// more. A quarter means it would draw a third more frames with a picture
// that cost nothing, a half twice as many. Waiting alone is no fault: a game
// waits some milliseconds on every frame of a healthy page too.
const FEW_FRAMES = 40;
const WAIT_WARN = 0.25;
const WAIT_BAD = 0.5;
// None of it matters above this frame rate: N-Gage games draw 10 to 20
// frames a second, and a game that loops as fast as it can waits for the
// display on every frame of a perfectly good 60.
const SLOW_BELOW_FPS = 25;
// The timer does a frame's work about 30 times a second when no animation
// frame comes. Fewer than this in a second and it was a hiccup, not a page
// the browser has stopped drawing.
const TIMER_RATE = 10;
// Share of a stretch the timer drew in, from which it is worth saying.
const TIMER_SHARE = 0.2;

const finite = (value) => (Number.isFinite(value) ? value : null);
const part = (sample) => (sample && sample.diag && sample.diag.graphics) || null;

// What happened between two samples, as rates. Counters the build does not
// have come out as null.
export function between(a, b) {
  const seconds = (b.t - a.t) / 1000;
  if (!(seconds > 0)) return null;
  const ga = part(a) || {};
  const gb = part(b) || {};
  const grown = (key) => (Number.isFinite(ga[key]) && Number.isFinite(gb[key]) ? Math.max(0, gb[key] - ga[key]) : null);
  const per = (value, by) => (value === null || by === null || !(by > 0) ? null : value / by);

  const frames = finite(b.frames - a.frames);
  const busyMs = finite(b.graphicsBusyMs - a.graphicsBusyMs);
  // The three places where the game stands still for the graphics thread.
  // A build that times only some of them gives what it has.
  const presentWaitMs = grown('presentWaitMs');
  const syncWaitMs = grown('syncWaitMs');
  const submitWaitMs = grown('submitWaitMs');
  const waitMs = presentWaitMs === null ? null : presentWaitMs + (syncWaitMs || 0) + (submitWaitMs || 0);
  const animationFrames = grown('animationFrames');
  const timerFrames = grown('timerFrames');
  const drawn = animationFrames === null || timerFrames === null ? null : animationFrames + timerFrames;
  return {
    seconds,
    fps: per(frames, seconds),
    // The graphics thread: share of the time it drew, and per frame.
    busyShare: per(busyMs, seconds * 1000),
    busyMsPerFrame: per(busyMs, frames),
    // The game: share of the time it waited for the graphics thread, and
    // per frame; then that share by where it waited: for the frame before
    // to be presented, for a command that returns something, for room in
    // the queue.
    waitShare: per(waitMs, seconds * 1000),
    waitMsPerFrame: per(waitMs, frames),
    presentWaitShare: per(presentWaitMs, seconds * 1000),
    syncWaitShare: per(syncWaitMs, seconds * 1000),
    submitWaitShare: per(submitWaitMs, seconds * 1000),
    longWaits: grown('presentWaitsLong'),
    // The browser: animation frames it gave a second (the display's rate for
    // a page it shows), and what the timer did in their place. For a whole
    // stretch collect() replaces the rate by animationFrames()'s.
    animationRate: per(grown('animationCalls'), seconds),
    timerRate: per(grown('timerCalls'), seconds),
    timerFrames,
    timerShare: per(timerFrames, drawn),
  };
}

// The last RECENT_S seconds of samples, whatever the game did in them.
export function recent(samples) {
  const last = samples.length - 1;
  if (last < 1) return null;
  let first = last;
  while (first > 0 && samples[last].t - samples[first - 1].t <= RECENT_S * 1000 + 500) first--;
  if (first === last) return null;
  const measured = between(samples[first], samples[last]);
  if (!measured) return null;
  return {
    seconds: measured.seconds,
    animationRate: measured.animationRate,
    timerRate: measured.timerRate,
    // Whether the page was in front the whole time, as far as it knows.
    visible: samples.slice(first, last + 1).every((sample) => !sample.hidden),
  };
}

// The browser gave no animation frames: the timer did the work at its pace,
// and animation frames, if any came, were few beside it. The pace matters: a
// picture that takes longer than a tenth of a second to draw makes the timer
// step in too, a few times a second, and that is slow drawing, not a page
// the browser has stopped drawing.
function timerDrew(rates) {
  return Boolean(rates) && rates.timerRate !== null && rates.animationRate !== null
    && rates.timerRate >= TIMER_RATE && rates.animationRate < rates.timerRate / 4;
}

const noAnimationFrames = (now) => Boolean(now) && now.seconds >= 2 && timerDrew(now);

// A stretch second by second: the seconds in which the timer drew in place
// of animation frames, and the animation frames a second in the others, which
// is the pace the browser drew the page at while it did. Both null on a build
// without the counters; the rate also when the timer drew throughout.
export function animationFrames(samples) {
  let known = false;
  let timerSeconds = 0;
  let seconds = 0;
  let calls = 0;
  for (let i = 1; i < samples.length; i++) {
    const rates = between(samples[i - 1], samples[i]);
    if (!rates || rates.animationRate === null || rates.timerRate === null) continue;
    known = true;
    if (timerDrew(rates)) {
      timerSeconds += rates.seconds;
    } else {
      seconds += rates.seconds;
      calls += rates.animationRate * rates.seconds;
    }
  }
  return { timerSeconds: known ? timerSeconds : null, animationRate: seconds > 0 ? calls / seconds : null };
}

// Whether the picture holds the game back: null when it does not, else
// { level, drawing, waiting, fewFrames }: how badly, whether drawing held the
// graphics thread, whether the game waited for slow drawing, and whether the
// browser called for few animation frames.
function bound(data) {
  if (data.fps === null || data.fps >= SLOW_BELOW_FPS) return null;
  const busy = data.busyShare === null ? 0 : data.busyShare;
  const wait = data.waitShare === null ? 0 : data.waitShare;
  // No animation frames because the browser had stopped drawing the page is
  // another matter (no-animation-frames): the rate is of the seconds in which
  // the timer did not draw, and says nothing when those were the lesser part.
  const timed = data.timerSeconds !== null && data.timerSeconds >= data.measuredS / 2;
  const fewFrames = data.animationRate !== null && data.animationRate < FEW_FRAMES && !timed;
  const drawing = busy >= BUSY_SLOW;
  const waiting = (drawing || fewFrames) && wait >= WAIT_WARN;
  if (!drawing && !waiting) return null;
  return { level: busy >= BUSY_BAD || (waiting && wait >= WAIT_BAD) ? 'bad' : 'warn', drawing, waiting, fewFrames };
}

// The scaling choices that cost next to nothing; every other one is a shader
// with real work per pixel of the canvas.
const cheapFilter = (canvas) => !canvas || ['nearest', 'linear', 'sharp_bilinear'].includes(canvas.filter);

// A scale as the Display dialog names it: "4×", or "3.3×" when it follows the canvas.
const times = (scale) => `${number(scale, Number.isInteger(scale) ? 0 : 1)}×`;

// The running game's 3D drawn again above its own size (app.js keeps what it
// knows in page.enhance; null for a game without a profile): the scale the
// emulator said it draws at, 0 when it is off, and how the flat picture and
// the textures are enlarged, which is work for the graphics card too.
function layerOf(enhance) {
  if (!enhance) return null;
  const answer = enhance.answer || {};
  const scale = Number.isFinite(answer.scale) && answer.scale > 0 ? answer.scale : 0;
  return {
    engine: String(enhance.engine || ''),
    // false: the profile does not fit this copy of the game, so its 3D stays
    // the game's own, while the picture is still enlarged to the scale.
    matches: typeof answer.active === 'boolean' ? answer.active : null,
    scale,
    auto: Boolean(scale && answer.auto),
    flat: scale && answer.flat ? String(answer.flat) : null,
    textures: scale && answer.filter ? String(answer.filter) : null,
    failed: Boolean(answer.layerFailed),
  };
}

export default {
  id: 'graphics',
  title: 'Picture',
  order: 30,

  collect(ctx) {
    if (!ctx.emu) return null;
    const gl = (ctx.page.support && ctx.page.support.webgl) || null;
    const surface = ctx.page.surface || null;
    const last = ctx.samples[ctx.samples.length - 1] || null;
    const emulator = part(last);
    const stretch = ctx.span();
    const measured = stretch ? between(stretch.a, stretch.b) : null;
    const none = {
      fps: null, busyShare: null, busyMsPerFrame: null, waitShare: null, waitMsPerFrame: null, presentWaitShare: null, syncWaitShare: null, submitWaitShare: null,
      longWaits: null, animationRate: null, timerFrames: null, timerShare: null,
    };
    const { seconds, timerRate, ...rates } = measured || none;
    const paced = measured ? animationFrames(stretch.samples) : { timerSeconds: null, animationRate: null };
    return {
      renderer: gl && gl.renderer ? String(gl.renderer) : null,
      software: Boolean(gl && gl.software),
      canvas: surface ? { width: surface.width, height: surface.height, filter: surface.filter, fill: surface.fill } : null,
      screen: ctx.page.screen ? { width: ctx.page.screen.width, height: ctx.page.screen.height } : null,
      layer: layerOf(ctx.page.enhance),
      // null on a build whose emulator does not say.
      contextLost: emulator && typeof emulator.contextLost === 'boolean' ? emulator.contextLost : null,
      contextLosses: emulator ? finite(emulator.contextLosses) : null,
      testSwitch: emulator ? finite(emulator.debugAnimationFrames) : null,
      hidden: Boolean(last && last.hidden),
      now: recent(ctx.samples),
      // Over the last stretch of play (core.js: span()).
      measuredS: measured ? seconds : 0,
      ...rates,
      // Seconds of it in which the timer drew in place of animation frames,
      // and the animation frames a second in the rest of it.
      timerSeconds: paced.timerSeconds,
      animationRate: paced.animationRate,
    };
  },

  findings(data) {
    const found = [];
    const heavy = bound(data);
    const over = `the last ${Math.round(data.measuredS)} seconds`;

    if (data.contextLost || data.contextLosses > 0) {
      found.push({
        code: 'context-lost',
        level: 'bad',
        title: 'The browser took the graphics away from this page',
        detail: 'The game may still run and sound, but its picture can no longer be drawn: the screen stays as it was, or empty.'
          + ' Browsers do this when the graphics driver stopped or restarted, or when too many pages draw at once.',
        advice: 'Reload the page to get the picture back. If it happens again, close other tabs and programs that use the graphics card (video, 3D, other games) and update the graphics driver.',
      });
    }

    if (data.software) {
      found.push({
        code: 'software-rendering',
        level: heavy ? 'bad' : 'warn',
        title: 'The browser draws the picture without the graphics card',
        detail: `It reports "${data.renderer}", which draws on the processor. The emulator needs that processor for the game.`
          + (heavy ? ' Here the picture costs enough to slow the game down.' : ''),
        advice: 'Switch on graphics acceleration in the browser\'s settings (Chrome and Edge: Settings, System; Firefox: Settings, General, Performance) and restart the browser.'
          + ' A remote desktop or a virtual machine often has no graphics card to use.'
          + ' Until then choose "Sharp pixels" or "Smooth" as "Scaling" and a small "Resolution" in Menu, Display, and leave "3D resolution" off.',
      });
    }

    if (heavy) {
      const { waiting } = heavy;
      const parts = [];
      if (waiting) {
        parts.push(`Over ${over} the game stood still ${percent(data.waitShare)} of the time, waiting for its picture to be drawn, and showed ${number(data.fps, 1)} frames a second.`);
        if (heavy.fewFrames) parts.push(`The browser drew this page only ${number(data.animationRate)} times a second.`);
      }
      if (heavy.drawing) {
        parts.push(`${waiting ? 'Drawing' : `Over ${over} drawing the picture`} took ${percent(data.busyShare)} of the time${data.busyMsPerFrame === null ? '' : ` (${number(data.busyMsPerFrame, 1)} ms a frame)`}`
          + `${waiting ? '' : `, and the game showed ${number(data.fps, 1)} frames a second`}.`);
      }
      const big = data.canvas ? `${data.canvas.width}×${data.canvas.height}` : null;
      const layered = Boolean(data.layer && data.layer.scale > 1 && !data.layer.failed);
      found.push({
        code: 'graphics-bound',
        level: heavy.level,
        title: waiting ? 'The game waits for the picture' : 'Drawing the picture takes much of the time',
        detail: parts.join(' '),
        // The costliest setting first.
        advice: `In Menu, Display: ${[
          layered ? `set "3D resolution" lower or to "Off" (it is ${times(data.layer.scale)} now)` : null,
          cheapFilter(data.canvas) ? null : 'choose "Sharp pixels" or "Smooth" as "Scaling"',
          `choose a smaller "Resolution"${big ? ` (the picture is drawn at ${big} now)` : ''}`,
        ].filter(Boolean).join('; ')}.`
          + (data.software ? ' The lasting fix is to switch on graphics acceleration in the browser.'
            : ' Close other tabs and programs that draw a lot (video, 3D).'
              + (heavy.fewFrames ? ' If none of this changes anything, the browser itself draws seldom: switch off battery saving, and look at the refresh rate the display is set to.' : '')),
      });
    }

    if (noAnimationFrames(data.now)) {
      const shown = data.now.visible && !data.hidden;
      found.push(shown ? {
        code: 'no-animation-frames',
        level: 'warn',
        title: 'The browser is not drawing this page',
        detail: `For the last ${Math.round(data.now.seconds)} seconds the browser has not asked the page for new frames, as it does with a page nobody can see.`
          + ' The game then runs at 30 frames a second at most, and its picture may not reach the screen.',
        advice: 'Make sure the browser window is not minimised or covered by another window. A battery saver can do this too. If the picture stays still, reload the page.',
      } : {
        code: 'no-animation-frames',
        level: 'info',
        title: data.hidden ? 'The page is in the background' : 'The page was in the background a moment ago',
        detail: 'The browser does not draw a page that is not in front. A game played alone is paused meanwhile; in a multiplayer room it goes on, at 30 frames a second at most.',
        advice: 'Nothing to do: bring the page to the front to play.',
      });
    } else if (data.timerSeconds !== null && data.timerSeconds >= 3 && data.timerSeconds >= TIMER_SHARE * data.measuredS) {
      found.push({
        code: 'no-animation-frames',
        level: 'info',
        title: 'For part of the time the browser did not draw this page',
        detail: `For ${Math.round(data.timerSeconds)} of ${over} the browser asked the page for no frames, as with a page in the background or a covered window.`
          + ' The game runs at 30 frames a second at most then.',
        advice: 'Nothing to do if the page was in the background. Otherwise keep the browser window in front and uncovered while you play.',
      });
    }

    return found;
  },

  render(data) {
    const measured = data.measuredS > 0;
    const heavy = bound(data);
    const stopped = noAnimationFrames(data.now);
    const browserDraws = stopped ? 'not at all now'
      : data.now && data.now.animationRate !== null ? `${number(data.now.animationRate)} times a second`
        : data.animationRate !== null ? `${number(data.animationRate)} times a second` : null;
    return [rows([
      {
        label: 'Drawn by',
        value: data.renderer || 'the browser does not say',
        note: data.software ? 'Software rendering: the processor draws the picture.' : '',
        mark: data.software ? 'warn' : data.renderer ? 'ok' : undefined,
      },
      data.canvas && {
        label: 'Size and filter',
        value: `${data.canvas.width}×${data.canvas.height}, ${data.canvas.filter}`,
        note: data.canvas.fill && data.canvas.fill !== 'none' ? `Fill the screen: ${data.canvas.fill}.` : '',
      },
      data.layer && {
        label: 'The game\'s 3D',
        value: data.layer.failed ? 'drawn by the game itself: drawing it again failed'
          : !data.layer.scale ? 'drawn by the game itself'
            : `${data.layer.matches === false ? 'drawn by the game itself, and the picture enlarged to' : 'drawn again at'} ${times(data.layer.scale)}`
              + (data.screen ? ` (${Math.round(data.screen.width * data.layer.scale)}×${Math.round(data.screen.height * data.layer.scale)})` : ''),
        note: data.layer.scale ? `${data.layer.matches === false ? 'What the site knows about this game does not fit this copy of it. ' : ''}Textures ${data.layer.textures === 'linear' ? 'smooth' : 'sharp'}; menus, text and logos ${
          { scaler: 'through the pixel-art scaler', smooth: 'smooth', sharp: 'as sharp pixels' }[data.layer.flat] || data.layer.flat}.` : '',
        mark: data.layer.failed ? 'warn' : undefined,
      },
      data.contextLost !== null && {
        label: 'Graphics context',
        value: data.contextLost || data.contextLosses > 0 ? 'lost' : 'working',
        note: data.contextLost || data.contextLosses > 0 ? 'The picture does not come back without reloading the page.' : '',
        mark: data.contextLost || data.contextLosses > 0 ? 'bad' : 'ok',
      },
      browserDraws && {
        label: 'The browser draws the page',
        value: browserDraws,
        note: stopped ? 'A timer draws the game instead, 30 times a second at most.'
          : data.timerShare > 0 ? `${percent(data.timerShare)} of the frames of the last ${Math.round(data.measuredS)} s were drawn by the timer that stands in when the browser asks for none in a tenth of a second.` : '',
        mark: stopped ? (data.now.visible && !data.hidden ? 'warn' : undefined) : undefined,
      },
      measured && data.busyShare !== null && {
        label: 'Drawing',
        value: `${percent(data.busyShare)} of the time`,
        note: data.busyMsPerFrame === null ? 'No frame was drawn.' : `${number(data.busyMsPerFrame, 1)} ms a frame on the graphics thread.`,
        mark: heavy && heavy.drawing ? (data.busyShare >= BUSY_BAD ? 'bad' : 'warn') : undefined,
      },
      measured && data.waitShare !== null && {
        label: 'The game waits for the picture',
        value: `${percent(data.waitShare)} of the time`,
        note: (data.waitMsPerFrame === null ? '' : `${number(data.waitMsPerFrame, 1)} ms a frame on average. `)
          + 'A little is normal: what the game asks of the graphics thread is answered at the next frame the browser draws.',
        mark: heavy && heavy.waiting ? heavy.level : undefined,
      },
      data.testSwitch > 0 && { label: 'Test switch', value: `animation frames are switched off (mode ${data.testSwitch})`, mark: 'warn' },
    ])];
  },
};
