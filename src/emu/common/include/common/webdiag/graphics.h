// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <chrono>
#include <cstdint>

// Counters of the browser build's diagnostics (GET /v1/web/diag, section
// "graphics"): the graphics thread and the guest's wait for it.
//
// They are plain atomics so the code that counts never waits: a core file adds
// to one in a single line inside `#if EKA2L1_PLATFORM(WEB)`, and the web
// frontend (web/src/diag_graphics.cpp) reads them. Totals since the page loaded;
// the page works out rates from two readings.
namespace eka2l1::webdiag {
    struct graphics_counters {
        // The graphics thread draws when the browser calls it for an animation
        // frame. When none comes (a page that is not shown) a timer does the
        // same work. Counted by ogl_graphics_driver::run: the calls of each
        // kind, and how many of them ended with a frame presented.
        std::atomic<std::uint64_t> animation_calls{ 0 };
        std::atomic<std::uint64_t> animation_frames{ 0 };
        std::atomic<std::uint64_t> timer_calls{ 0 };
        std::atomic<std::uint64_t> timer_frames{ 0 };

        // Before the guest hands over a frame it waits until the one before
        // was presented (web/src/state.cpp). Time spent there is time the game
        // stood still for the picture.
        std::atomic<std::uint64_t> presents{ 0 }; // frames the guest handed over
        std::atomic<std::uint64_t> present_wait_us{ 0 }; // all the waiting, in microseconds
        std::atomic<std::uint64_t> present_waits{ 0 }; // waits of a millisecond or more
        std::atomic<std::uint64_t> present_waits_long{ 0 }; // waits of a tenth of a second or more

        // The other two places where the guest stands still for the graphics
        // thread. A command that returns something (a new bitmap, the pixels
        // of one) is waited for, behind whatever the thread is drawing
        // (drivers/src/itc.cpp). And the queue of command lists has an end:
        // handing over a list waits when it is full (submit_command_list).
        std::atomic<std::uint64_t> sync_commands{ 0 };
        std::atomic<std::uint64_t> sync_wait_us{ 0 };
        std::atomic<std::uint64_t> submit_wait_us{ 0 };

        // Whether the browser has taken the WebGL context away, as the
        // graphics thread last saw it, and how often that happened.
        std::atomic<bool> context_lost{ false };
        std::atomic<std::uint64_t> context_losses{ 0 };

        void note_present_wait(const std::uint64_t microseconds) {
            presents.fetch_add(1, std::memory_order_relaxed);
            present_wait_us.fetch_add(microseconds, std::memory_order_relaxed);

            if (microseconds >= 1000) {
                present_waits.fetch_add(1, std::memory_order_relaxed);
            }

            if (microseconds >= 100000) {
                present_waits_long.fetch_add(1, std::memory_order_relaxed);
            }
        }

        // Called by the one thread that owns the context.
        void note_context(const bool lost) {
            if (context_lost.exchange(lost, std::memory_order_relaxed) != lost && lost) {
                context_losses.fetch_add(1, std::memory_order_relaxed);
            }
        }
    };

    inline graphics_counters graphics;

    // Adds the time it lives to a counter, in microseconds: one line times
    // the rest of a block.
    struct timed {
        explicit timed(std::atomic<std::uint64_t> &total)
            : total_(total)
            , started_(std::chrono::steady_clock::now()) {
        }

        ~timed() {
            total_.fetch_add(static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(
                std::chrono::steady_clock::now() - started_).count()), std::memory_order_relaxed);
        }

        timed(const timed &) = delete;
        timed &operator=(const timed &) = delete;

    private:
        std::atomic<std::uint64_t> &total_;
        std::chrono::steady_clock::time_point started_;
    };
}
