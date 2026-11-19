// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics: why a game runs badly on this machine.
//
// The page keeps one Diagnostics object (page.diag). It takes a sample a
// second while the emulator is up and keeps the last two minutes, asks every
// section what it knows, and from that makes
//   - the Diagnostics dialog: what was found, in plain words and worst first,
//     then each section's numbers, refreshed every second while it is open;
//   - a report (report()): the same as one JSON object, which the visitor can
//     copy or download and send to us. Nothing is ever sent by the page.
//
// A section is a module in this folder, listed in sections.js, whose default
// export is an object:
//
//   id        its name in a report, and the name of its part of the
//             emulator's answer where it has one
//   title     the heading in the dialog
//   order     position in the dialog, lowest first
//   init(ctx)     optional, once when the page loads (there is no emulator
//                 yet: ctx.emu is null). For listeners that must not miss
//                 anything, such as errors.
//   start(ctx)    optional, once when the emulator is up.
//   sample(ctx, sample)  optional, every second: returns a small object kept
//                 in the sample as sample.x[id]. `sample` is the one being
//                 made, with everything but `x`. Must not wait for anything.
//   collect(ctx)  what the section knows now, as plain data that survives
//                 JSON, or null when it has nothing to say (the section is
//                 then left out). May be async. Called every second while the
//                 dialog is open, so keep what is costly.
//   findings(data)  the causes that data shows, as a list of
//                 { code, level, title, detail, advice }: `code` from
//                 codes.js, `level` 'bad', 'warn' or 'info', the rest text
//                 for the visitor (what is wrong, the numbers behind it, what
//                 to do). A pure function of `data`, so that a test can call
//                 it and a report can be judged again later.
//   render(data, ctx)  the section's body in the dialog: a list of nodes,
//                 usually [rows([...])] from dom.js.
//
// ctx (see context() below): { page, emu, samples, now, started, game,
// span(seconds) }.
//
// A sample: { t, running, hidden, frames, graphicsBusyMs, heapMB, heapUsedMB,
// diag, x }. `t` is performance.now(); `running` says a game was running and
// not paused; `diag` is the emulator's answer to GET /v1/web/diag (the
// counters behind most sections; null on a build without it); `x` holds what
// the sections added. Counters are totals, so a rate is the difference of two
// samples over their time: span() picks the two.

import { CODES, LEVELS } from './codes.js';
import { el } from './dom.js';

const SAMPLE_MS = 1000;
const KEEP = 120; // samples, so two minutes
const WINDOW_S = 30; // what "now" means for a rate, unless a section asks otherwise

export const REPORT_VERSION = 1;

// The last stretch of play in `samples`, at most `seconds` long: the first
// and last sample of it and the time between them, or null when the game has
// not been running for two samples in a row. A pause, or another game, ends a
// stretch, because the counters before and after do not belong together.
export function span(samples, seconds = WINDOW_S) {
  let last = samples.length - 1;
  while (last >= 0 && !samples[last].running) last--;
  if (last < 1) return null;
  const b = samples[last];
  let first = last;
  while (first > 0 && samples[first - 1].running && samples[first - 1].app === b.app
    && b.t - samples[first - 1].t <= seconds * 1000 + SAMPLE_MS / 2) first--;
  if (first === last) return null;
  const a = samples[first];
  return { a, b, seconds: (b.t - a.t) / 1000, samples: samples.slice(first, last + 1) };
}

// Frames per second between each pair of neighbouring samples of a stretch.
export function frameRates(stretch) {
  const rates = [];
  for (let i = 1; i < stretch.length; i++) {
    const dt = (stretch[i].t - stretch[i - 1].t) / 1000;
    if (dt > 0) rates.push((stretch[i].frames - stretch[i - 1].frames) / dt);
  }
  return rates;
}

// Worst first; within a level, in the order the sections gave them.
export function sortFindings(findings) {
  return findings.map((finding, index) => ({ finding, index }))
    .sort((p, q) => (LEVELS.indexOf(p.finding.level) - LEVELS.indexOf(q.finding.level)) || (p.index - q.index))
    .map((pair) => pair.finding);
}

// A section's findings, checked: a section that returns a code it does not
// own, or a level that does not exist, has a bug that would otherwise show up
// as a finding nobody can look up.
export function checkedFindings(section, data) {
  const list = section.findings ? section.findings(data) : [];
  return (list || []).filter((finding) => {
    const fine = finding && CODES[finding.code] === section.id && LEVELS.includes(finding.level);
    if (!fine) console.warn(`diagnostics: section ${section.id} returned a finding it may not`, finding);
    return fine;
  }).map((finding) => ({ ...finding, section: section.id }));
}

export class Diagnostics {
  // `page` is app.js's page object. `ui` names the dialog's parts:
  // { dialog, body, copy, download, note }; `tools` what app.js lends:
  // { downloadBlob, formatText, redact, helpLink }.
  constructor(page, sections, ui, tools) {
    this.page = page;
    this.sections = [...sections].sort((a, b) => a.order - b.order);
    this.ui = ui;
    this.tools = tools;
    this.samples = [];
    this.listeners = new Set();
    this.endpoint = null; // null: not asked yet; false: the build has none
    this.started = null;
    this.docs = null; // address of the site's documentation, when it has one
    this.busy = false;
    this.refreshTimer = null;
    this.parts = null;
  }

  context() {
    const page = this.page;
    return {
      page,
      emu: page.emu,
      samples: this.samples,
      now: performance.now(),
      started: this.started, // when the emulator came up, on the same clock; null before
      game: page.app ? { uid: page.app.uid, name: page.app.name, slug: (page.source && page.source.slug) || null } : null,
      span: (seconds) => span(this.samples, seconds),
    };
  }

  each(hook) {
    const ctx = this.context();
    for (const section of this.sections) {
      if (!section[hook]) continue;
      try {
        section[hook](ctx);
      } catch (error) {
        console.warn(`diagnostics: ${section.id}.${hook} failed`, error);
      }
    }
  }

  // When the page loads.
  init() {
    this.each('init');
    if (this.ui && this.ui.dialog) this.wire();
  }

  // When the emulator is up.
  start() {
    this.started = performance.now();
    this.each('start');
    this.sample();
    setInterval(() => this.sample(), SAMPLE_MS);
  }

  onSample(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async sample() {
    const page = this.page;
    if (!page.emu || this.busy) return;
    this.busy = true;
    try {
      let diag = null;
      if (this.endpoint !== false) {
        try {
          const res = await page.emu.request('GET', '/v1/web/diag');
          if (res.ok) {
            diag = res.json();
            this.endpoint = true;
          } else if (res.status === 404) {
            this.endpoint = false;
          }
        } catch (error) {
          console.warn('diagnostics: no answer from the emulator', error);
        }
      }
      const stats = page.emu.stats();
      const sample = {
        t: performance.now(),
        running: Boolean(page.app) && !page.paused && !page.ended,
        app: page.app ? page.app.uid : null,
        hidden: document.hidden,
        frames: stats.frames,
        graphicsBusyMs: stats.graphicsBusyMs,
        heapMB: stats.heapMB,
        heapUsedMB: stats.heapUsedMB,
        diag,
        x: {},
      };
      const ctx = this.context();
      for (const section of this.sections) {
        if (!section.sample) continue;
        try {
          const extra = section.sample(ctx, sample);
          if (extra !== undefined && extra !== null) sample.x[section.id] = extra;
        } catch (error) {
          console.warn(`diagnostics: ${section.id}.sample failed`, error);
        }
      }
      this.samples.push(sample);
      if (this.samples.length > KEEP) this.samples.splice(0, this.samples.length - KEEP);
      for (const listener of this.listeners) listener(sample);
    } finally {
      this.busy = false;
    }
  }

  // Asks every section. Resolves to { findings, sections }, where sections is
  // a list of { id, title, data, findings, error } for those with something
  // to say, in dialog order.
  async collect() {
    const ctx = this.context();
    const sections = [];
    for (const section of this.sections) {
      let data = null;
      let error = null;
      try {
        data = section.collect ? await section.collect(ctx) : null;
      } catch (failure) {
        console.warn(`diagnostics: ${section.id}.collect failed`, failure);
        error = String(failure && failure.message ? failure.message : failure);
      }
      if ((data === null || data === undefined) && !error) continue;
      let findings = [];
      if (!error) {
        try {
          findings = checkedFindings(section, data);
        } catch (failure) {
          console.warn(`diagnostics: ${section.id}.findings failed`, failure);
          error = String(failure && failure.message ? failure.message : failure);
        }
      }
      sections.push({ id: section.id, title: section.title, data, findings, error, section });
    }
    return { ctx, sections, findings: sortFindings(sections.flatMap((entry) => entry.findings)) };
  }

  // The report: everything the dialog shows and the history behind it, as
  // one object that survives JSON.
  async report() {
    const page = this.page;
    const { ctx, sections, findings } = await this.collect();
    const stretch = ctx.span();
    const first = this.samples[0];
    const report = {
      kind: 'eka2l1-web-diagnostics',
      v: REPORT_VERSION,
      generated: new Date().toISOString(),
      page: { address: location.origin + location.pathname, hidden: document.hidden },
      game: ctx.game,
      session: {
        upS: this.started === null ? null : Math.round((ctx.now - this.started) / 1000),
        running: Boolean(page.app) && !page.paused && !page.ended,
        paused: Boolean(page.paused),
        emulatorAnswers: this.endpoint === true,
        samples: this.samples.length,
        measuredS: stretch ? Math.round(stretch.seconds) : 0,
      },
      findings,
      sections: Object.fromEntries(sections.map((entry) => [entry.id, {
        title: entry.title,
        data: entry.data,
        findings: entry.findings.map((finding) => finding.code),
        ...(entry.error ? { error: entry.error } : {}),
      }])),
      // What the page saw each second, oldest first: seconds since the first
      // sample, frames per second since the sample before, and the state.
      series: {
        t: this.samples.map((sample) => Math.round((sample.t - first.t) / 100) / 10),
        fps: this.samples.map((sample, index) => {
          const before = this.samples[index - 1];
          if (!before || sample.t <= before.t) return null;
          return Math.round(((sample.frames - before.frames) * 10000) / (sample.t - before.t)) / 10;
        }),
        running: this.samples.map((sample) => (sample.running ? 1 : 0)),
        hidden: this.samples.map((sample) => (sample.hidden ? 1 : 0)),
      },
    };
    // Through JSON once, so that what is returned is exactly what a file
    // would hold, and a section's stray value (a function, a NaN) shows here
    // and not at the reader's.
    return this.tools.redact(JSON.parse(JSON.stringify(report)));
  }

  // --- the dialog ----------------------------------------------------------

  wire() {
    const { dialog, copy, download } = this.ui;
    dialog.addEventListener('close', () => {
      // The event arrives after the fact: a dialog closed and opened again at
      // once is open by now, and its timer must stay.
      if (dialog.open) return;
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    });
    copy.addEventListener('click', async () => {
      try {
        const report = await this.report();
        await navigator.clipboard.writeText(this.tools.formatText(report));
        this.note(report.redacted && report.redacted.failed ? 'Copied, but the report could only be made in part.' : 'Report copied.');
      } catch (error) {
        console.warn(error);
        this.note('The browser did not allow copying. Use "Download report".');
      }
    });
    download.addEventListener('click', async () => {
      try {
        const text = JSON.stringify(await this.report(), null, 2);
        const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 13);
        this.tools.downloadBlob(new Blob([text], { type: 'application/json' }), `diagnostics-${stamp}.json`);
        this.note('Report saved. Nothing was sent anywhere: attach the file when you write to us.');
      } catch (error) {
        console.warn(error);
        this.note('The report could not be made.');
      }
    });
  }

  note(text) {
    if (this.ui.note) this.ui.note.textContent = text;
  }

  async open() {
    this.note('');
    await this.refresh();
    this.ui.dialog.showModal();
    if (!this.refreshTimer) this.refreshTimer = setInterval(() => this.refresh().catch((error) => console.warn(error)), SAMPLE_MS);
  }

  // Draws the dialog. Each section keeps its element, and only its body is
  // replaced, so the dialog does not jump while it is read.
  async refresh() {
    const body = this.ui.body;
    const { ctx, sections, findings } = await this.collect();

    if (!this.parts) {
      this.parts = { lead: el('p', { class: 'hint', id: 'diag-lead' }), found: el('div', { id: 'diag-findings' }), sections: new Map() };
      body.replaceChildren(this.parts.lead, this.parts.found);
    }

    const stretch = ctx.span();
    this.parts.lead.textContent = !ctx.emu ? ''
      : !ctx.game ? 'No game is running. Start one and play for half a minute, then look here again.'
        : !stretch || stretch.seconds < 10 ? 'Still measuring: play for half a minute for the full picture.'
          : `Measured over the last ${Math.round(stretch.seconds)} seconds of play.`;

    this.parts.found.replaceChildren(...(findings.length ? findings.map((finding) => this.findingNode(finding))
      : [el('p', { class: 'notice' }, ctx.game ? 'Nothing wrong was found.' : 'Nothing wrong was found with this browser.')]));

    const shown = new Set();
    let after = this.parts.found;
    for (const entry of sections) {
      shown.add(entry.id);
      let part = this.parts.sections.get(entry.id);
      if (!part) {
        const content = el('div', { class: 'diag-body' });
        part = { node: el('section', { class: 'diag-section', id: `diag-${entry.id}` }, el('h3', null, entry.title), content), content };
        this.parts.sections.set(entry.id, part);
      }
      if (after.nextSibling !== part.node) after.after(part.node);
      after = part.node;
      let nodes;
      try {
        nodes = entry.error ? [el('p', { class: 'hint' }, `This part could not be read: ${entry.error}`)]
          : entry.section.render ? entry.section.render(entry.data, ctx) : [];
      } catch (error) {
        console.warn(`diagnostics: ${entry.id}.render failed`, error);
        nodes = [el('p', { class: 'hint' }, 'This part could not be shown.')];
      }
      // A section that gives the very nodes that are there keeps them in
      // place, so that a button of its own is not taken out from under a
      // click or the keyboard every second.
      const next = [nodes].flat().filter(Boolean);
      const there = part.content.childNodes;
      if (next.length !== there.length || next.some((node, index) => node !== there[index])) part.content.replaceChildren(...next);
    }
    for (const [id, part] of this.parts.sections) {
      if (!shown.has(id)) part.node.remove();
    }
  }

  findingNode(finding) {
    const help = this.docs ? this.tools.helpLink(finding.code, this.docs) : null;
    return el('div', { class: `notice finding ${finding.level === 'info' ? '' : finding.level}`.trim(), 'data-code': finding.code },
      el('strong', null, finding.title),
      finding.detail ? el('p', null, finding.detail) : null,
      finding.advice ? el('p', { class: 'advice' }, finding.advice) : null,
      help ? el('p', null, el('a', { href: help, target: '_blank', rel: 'noopener' }, 'More about this')) : null);
  }
}
