// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A diagnostics report (core.js: report()) on its way out of the page: with
// what identifies the visitor taken out, and as text for pasting into a
// message. Nothing here touches the document, so tests can call it.

// Returns the report without anything that should not leave the browser.
// Not written yet: the report holds nothing of the kind so far.
export function redact(report) {
  return report;
}

// The report as text. Not written yet: it is the JSON.
export function formatText(report) {
  return JSON.stringify(report, null, 2);
}
