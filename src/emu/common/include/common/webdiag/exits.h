// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <cstdint>

// Counters of the browser build's diagnostics (GET /v1/web/diag, section
// "exits"): how programs and threads of the guest ended, and calls nobody implements.
//
// They are plain atomics so the code that counts never waits: a core file adds
// to one in a single line inside `#if EKA2L1_PLATFORM(WEB)`, and the web
// frontend (web/src/diag_exits.cpp) reads them. Totals since the page loaded;
// the page works out rates from two readings.
namespace eka2l1::webdiag {
    struct exits_counters {
    };

    inline exits_counters exits;
}
