// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: the game that is running and how fast it is drawn.
// The summary a reader looks at first; the sections after it say why.

import { frameRates } from './core.js';
import { number, rows, seconds } from './dom.js';

export default {
  id: 'session',
  title: 'Session',
  order: 10,

  collect(ctx) {
    if (!ctx.emu) return null;
    const stretch = ctx.span();
    const rates = stretch ? frameRates(stretch.samples) : [];
    const last = ctx.samples[ctx.samples.length - 1] || null;
    const surface = ctx.page.surface || null;
    return {
      game: ctx.game,
      state: !ctx.game ? 'none' : ctx.page.paused ? 'paused' : 'running',
      upS: ctx.started === null ? 0 : Math.round((ctx.now - ctx.started) / 1000),
      frames: last ? last.frames : 0,
      // Frames the game presented per second: now, on average over the last
      // stretch of play, and in the worst second of it.
      fps: rates.length ? rates[rates.length - 1] : null,
      fpsAverage: stretch ? (stretch.b.frames - stretch.a.frames) / stretch.seconds : null,
      fpsWorst: rates.length ? Math.min(...rates) : null,
      measuredS: stretch ? stretch.seconds : 0,
      gamepads: ctx.page.gamepads || 0,
      canvas: surface ? { width: surface.width, height: surface.height, filter: surface.filter, fill: surface.fill } : null,
    };
  },

  findings() {
    return [];
  },

  render(data) {
    const states = { none: 'no game running', paused: 'paused', running: 'running' };
    return [rows([
      { label: 'Game', value: data.game ? `${data.game.name} (${states[data.state]})` : states.none },
      data.game && {
        label: 'Frames per second',
        value: `${number(data.fps, 1)} now`,
        note: data.fpsAverage === null ? 'Not measured yet.'
          : `${number(data.fpsAverage, 1)} on average and ${number(data.fpsWorst, 1)} in the worst second of the last ${Math.round(data.measuredS)} s.`
            + ' Many games draw only when something moves, so a still screen counts few frames.',
      },
      { label: 'Emulator up', value: seconds(data.upS * 1000), note: `${Math.round(data.frames)} frames drawn` },
      data.canvas && { label: 'Picture', value: `${data.canvas.width}×${data.canvas.height}, ${data.canvas.filter}` },
      { label: 'Gamepads', value: String(data.gamepads) },
    ])];
  },
};
