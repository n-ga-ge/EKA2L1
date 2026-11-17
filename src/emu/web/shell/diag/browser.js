// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Diagnostics section: what the browser can do and what the device is, from
// support.js. It needs no emulator, so it is what the dialog shows on a
// browser that cannot run one.

import { rows } from './dom.js';

export default {
  id: 'browser',
  title: 'Browser and device',
  order: 90,

  collect(ctx) {
    const support = ctx.page.support;
    if (!support) return null;
    const item = (entry) => ({ name: entry.name, ok: Boolean(entry.ok), detail: entry.detail || '' });
    return {
      ok: Boolean(support.ok),
      required: support.required.map(item),
      optional: support.optional.map(item),
      cores: support.cores || null,
      memoryGB: support.memoryGB || null,
      mobile: Boolean(support.mobile),
      userAgent: support.userAgent,
    };
  },

  findings(data) {
    const missing = data.required.filter((item) => !item.ok);
    if (!missing.length) return [];
    return [{
      code: 'browser-unsupported',
      level: 'bad',
      title: 'This browser cannot run the emulator',
      detail: `It lacks: ${missing.map((item) => item.name + (item.detail ? ` (${item.detail})` : '')).join('; ')}.`,
      advice: 'Use a current version of Chrome, Edge or Firefox. A page opened inside another app (a chat or mail program) often lacks these: open it in the browser itself.',
    }];
  },

  render(data) {
    const device = [data.cores ? `${data.cores} processor threads` : null, data.memoryGB ? `${data.memoryGB} GB of memory or more` : null,
      data.mobile ? 'phone or tablet' : 'desktop'].filter(Boolean).join(', ');
    return [
      rows([{ label: 'Device', value: device, note: data.userAgent }]),
      rows(data.required.map((item) => ({ value: item.name, note: item.detail, mark: item.ok ? 'ok' : 'bad' }))),
      rows(data.optional.map((item) => ({ value: item.name, note: item.detail, mark: item.ok ? 'ok' : 'warn' }))),
    ];
  },
};
