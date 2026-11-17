// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the diagnostics sections draw with. Nothing here touches the document
// until it is called, so a section can be imported by a test outside a browser.

// Builds an element. Children are nodes or strings, and strings become text:
// nothing a section shows is ever parsed as HTML.
export function el(tag, attributes, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes || {})) {
    if (value === null || value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? '' : value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== ''));
  return node;
}

const MARKS = { ok: '✓', warn: '–', bad: '✗' };

// The usual body of a section: a list of rows
//   { label, value, note, mark }
// `mark` is 'ok', 'warn' or 'bad' (a coloured sign before the row) or absent;
// `note` is a smaller line below. Rows that are null are left out.
export function rows(list) {
  return el('ul', null, list.filter(Boolean).map((row) => el('li', null,
    el('span', row.mark ? { class: row.mark } : null, row.mark ? MARKS[row.mark] : ''),
    el('span', null, row.label !== undefined && row.label !== null ? `${row.label}: ${row.value}` : String(row.value)),
    row.note ? el('small', null, String(row.note)) : null)));
}

// Numbers as the dialog and the report's text show them. A value that is not
// a finite number is shown as a dash, so a counter the build does not have
// never prints "NaN".
export function number(value, digits = 0) {
  return Number.isFinite(value) ? value.toFixed(digits) : '–';
}

export function percent(share, digits = 0) {
  return Number.isFinite(share) ? `${(share * 100).toFixed(digits)}%` : '–';
}

export function megabytes(bytes, digits = 0) {
  return Number.isFinite(bytes) ? `${(bytes / 1048576).toFixed(digits)} MB` : '–';
}

export function seconds(ms) {
  if (!Number.isFinite(ms)) return '–';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m} min ${s % 60} s` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
