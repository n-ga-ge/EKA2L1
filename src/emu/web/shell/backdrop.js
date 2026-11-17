// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The picture behind the game for the "ambient fill" display option: a small
// canvas that follows what the game shows, blurred and dimmed. The style sheet
// enlarges it to cover the space around the game.
//
// It is blurred while it is small, which costs next to nothing. A style-sheet
// blur over the enlarged picture took most of the page's time in a browser
// that renders without a GPU.
//
// The game canvas is drawn by a worker. Chrome lets the page copy such a
// canvas with drawImage(); Firefox hands back a transparent picture from the
// game's first frame on (and an opaque black one before it). While the copy
// comes back empty, the emulator is asked for its own screenshot instead, a
// few times a second, which is enough for a blurred glow.

// How quickly the backdrop follows the picture. Blending towards each new
// frame keeps a flickering game from flickering across the whole screen.
const FOLLOW_MS = 120;
// The screenshot route costs the emulator a readback each time.
const SCREENSHOT_EVERY_MS = 200;
// How often it is checked whether the game canvas can be copied. The answer
// changes while a page runs, so it is never taken as settled; the check reads
// a pixel back from the graphics card, so it is not made for every frame.
const PROBE_EVERY_MS = 1000;
// The backdrop holds the game's picture at this fraction of its size.
const SCALE = 0.25;
// How a frame is drawn on it: blurred and dimmed, so the eye stays on the
// game. The frame is drawn larger than the backdrop by the reach of the blur,
// because a blurred picture fades out towards its own edges.
const BLUR = 2; // backdrop pixels
const LOOK = `blur(${BLUR}px) saturate(1.25) brightness(.6)`;

export class Backdrop {
  // `target` is the backdrop canvas, `source` the game canvas and `emu` the
  // emulator client (frames() and request()).
  constructor(target, source, emu) {
    this.target = target;
    this.source = source;
    this.emu = emu;
    this.context = target.getContext('2d');
    // A browser whose canvas cannot filter what it draws: the style sheet
    // blurs the enlarged picture instead.
    this.filters = 'filter' in this.context;
    target.classList.toggle('unblurred', !this.filters);
    // One pixel of the game canvas, to see whether the page can copy it.
    this.probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
    this.probe.canvas.width = this.probe.canvas.height = 1;
    this.route = null; // where pictures come from now: 'canvas' or 'emulator'
    this.probedAt = 0;
    this.frame = -1; // the emulator's frame counter at the last copy
    this.paintedAt = 0;
    this.asking = false;
    this.askedAt = 0;
    this.timer = 0;
    this.tick = this.tick.bind(this);
  }

  // Starts or stops following the game. `screen` is the game's screen size.
  show(active, screen) {
    const width = Math.max(1, Math.round(screen.width * SCALE));
    const height = Math.max(1, Math.round(screen.height * SCALE));
    if (this.target.width !== width || this.target.height !== height) {
      this.target.width = width;
      this.target.height = height;
      this.paintedAt = 0; // resizing emptied it
    }

    if (active === Boolean(this.timer)) return;
    if (active) {
      this.frame = -1;
      this.paintedAt = 0;
      this.probedAt = 0;
      this.timer = requestAnimationFrame(this.tick);
    } else {
      cancelAnimationFrame(this.timer);
      this.timer = 0;
    }
  }

  tick(now) {
    this.timer = requestAnimationFrame(this.tick);
    const frame = this.emu.frames();
    if (frame === this.frame) return; // nothing new to show: paused, or between the game's frames

    if (now - this.probedAt >= PROBE_EVERY_MS) {
      this.probedAt = now;
      this.route = this.canCopy() ? 'canvas' : 'emulator';
    }
    if (this.route === 'emulator') {
      this.askEmulator(now, frame);
      return;
    }

    this.frame = frame;
    try {
      this.paint(this.source, now);
    } catch { /* the canvas is being resized; the next frame is drawn */ }
  }

  // A copy that worked is opaque, because the emulator clears every frame to
  // solid black before drawing the game's picture on it. A copy that did not
  // is transparent.
  canCopy() {
    try {
      this.probe.clearRect(0, 0, 1, 1);
      this.probe.drawImage(this.source, 0, 0, 1, 1);
      return this.probe.getImageData(0, 0, 1, 1).data[3] > 0;
    } catch {
      return false;
    }
  }

  async askEmulator(now, frame) {
    if (this.asking || now - this.askedAt < SCREENSHOT_EVERY_MS) return;
    this.asking = true;
    this.askedAt = now;
    try {
      const shot = await this.emu.request('GET', '/v1/screenshot');
      // Not ok: no game screen to copy right now (starting, restarting).
      if (shot.ok) {
        const picture = await createImageBitmap(new Blob([shot.body], { type: 'image/png' }));
        if (this.timer) this.paint(picture, performance.now());
        picture.close();
        this.frame = frame;
      }
    } catch (error) {
      console.warn('backdrop not updated:', error);
    } finally {
      this.asking = false;
    }
  }

  paint(picture, now) {
    const { context, target } = this;
    if (this.filters) context.filter = LOOK;
    context.globalAlpha = this.paintedAt ? 1 - Math.exp(-(now - this.paintedAt) / FOLLOW_MS) : 1;
    const rim = this.filters ? BLUR * 2 : 0;
    context.drawImage(picture, -rim, -rim, target.width + rim * 2, target.height + rim * 2);
    this.paintedAt = now;
  }
}
