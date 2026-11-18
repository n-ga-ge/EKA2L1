// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <cstdint>

// Counters of the browser build's diagnostics (GET /v1/web/diag, section
// "speed"): how busy the emulated processor is: the scheduler, the timers, the interpreter.
//
// They are plain atomics so the code that counts never waits: a core file adds
// to one in a single line inside `#if EKA2L1_PLATFORM(WEB)`, and the web
// frontend (web/src/diag_speed.cpp) reads them. Totals since the page loaded;
// the page works out rates from two readings.
namespace eka2l1::webdiag {
    struct speed_counters {
    };

    inline speed_counters speed;
}
