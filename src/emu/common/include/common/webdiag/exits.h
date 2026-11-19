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
//
// How a program or a thread ended is not a number, so that is kept by the
// frontend itself (diag_exits.cpp), which hears of it through the kernel's
// callbacks and needs no line in a core file.
namespace eka2l1::webdiag {
    struct exits_counters {
        // System calls of the guest that the emulator has no function for
        // (the kernel logs "Unimplement system call" and carries on).
        std::atomic<std::uint64_t> unimplemented_calls{ 0 };

        // Which calls those were: the first few different numbers, each with
        // how often it was made. A slot holds the number plus one, so that
        // zero means free; a number that finds no slot is only in the total.
        static constexpr int CALL_SLOTS = 8;
        std::atomic<std::uint32_t> call_number[CALL_SLOTS]{};
        std::atomic<std::uint64_t> call_count[CALL_SLOTS]{};

        void count_unimplemented_call(const std::uint32_t number) {
            unimplemented_calls.fetch_add(1, std::memory_order_relaxed);

            const std::uint32_t tag = number + 1;
            if (tag == 0) {
                return;
            }

            for (int i = 0; i < CALL_SLOTS; i++) {
                std::uint32_t held = call_number[i].load(std::memory_order_relaxed);
                if (held == 0 && call_number[i].compare_exchange_strong(held, tag, std::memory_order_relaxed)) {
                    held = tag;
                }
                if (held == tag) {
                    call_count[i].fetch_add(1, std::memory_order_relaxed);
                    return;
                }
            }
        }

        // Turns of the loop that runs the guest (the "Symbian OS thread"): a
        // few hundred a second while a game plays, none while the guest has
        // nothing to do. A request for the diagnostics wakes the loop, so a
        // number that stands still from one request to the next means that
        // thread is paused, stuck or gone.
        std::atomic<std::uint64_t> loop_turns{ 0 };

        // For tests of what the page does when the emulator stops: 1 makes
        // that loop throw an exception at its next turn, 2 makes it abort,
        // 3 makes it stay in that turn for good.
        // Set by POST /v1/web/diag/stop; 0 is normal.
        std::atomic<int> debug_stop{ 0 };
    };

    inline exits_counters exits;
}
