// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <chrono>
#include <cstddef>
#include <cstdint>

// Counters of the browser build's diagnostics (GET /v1/web/diag, section
// "speed"): how busy the emulated processor is: the scheduler, the timers, the interpreter.
//
// They are plain atomics so the code that counts never waits: a core file adds
// to one in a single line inside `#if EKA2L1_PLATFORM(WEB)`, and the web
// frontend (web/src/diag_speed.cpp) reads them. Totals since the page loaded;
// the page works out rates from two readings.
namespace eka2l1::webdiag {
    /// The clock every time in this file is taken on, in microseconds. Never 0,
    /// which the "since" fields below use for "not now".
    inline std::uint64_t speed_clock_us() {
        const auto now = std::chrono::steady_clock::now().time_since_epoch();
        return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::microseconds>(now).count()) + 1;
    }

    /// A time that is running: the total of the stretches that ended, and the
    /// start of the one in progress. One thread writes, any thread reads.
    ///
    /// The total and the start belong together: a reader that took one before
    /// the end of a stretch and the other after it would count the stretch
    /// twice or not at all, and its readings could go backwards. So the writer
    /// makes `version` odd while it changes them, and a reader takes them
    /// again when the version moved under it. Neither ever waits for a lock.
    struct speed_stopwatch {
        std::atomic<std::uint32_t> version{ 0 };
        std::atomic<std::uint64_t> total_us{ 0 };
        std::atomic<std::uint64_t> since_us{ 0 };
        std::atomic<std::uint64_t> count{ 0 };

        void begin() {
            version.fetch_add(1);
            since_us.store(speed_clock_us());
            version.fetch_add(1);
        }

        void end() {
            const std::uint64_t since = since_us.load();

            if (since) {
                const std::uint64_t now = speed_clock_us();

                version.fetch_add(1);
                since_us.store(0);
                total_us.fetch_add(now > since ? now - since : 0);
                count.fetch_add(1);
                version.fetch_add(1);
            }
        }

        /// The total as of `now_us`, with the stretch in progress.
        std::uint64_t read(const std::uint64_t now_us) const {
            std::uint64_t total = 0;
            std::uint64_t since = 0;

            // A change takes the writer a few instructions, so the first try
            // nearly always holds. The tries are counted so that a writer the
            // host put to sleep in the middle cannot hold the reader up; what
            // was read last is then off by one stretch at most.
            for (int tries = 0; tries < 1000; tries++) {
                const std::uint32_t before = version.load();

                total = total_us.load();
                since = since_us.load();

                if (!(before & 1) && (version.load() == before)) {
                    break;
                }
            }

            return total + (((since != 0) && (now_us > since)) ? (now_us - since) : 0);
        }
    };

    /// Timers that fired later than this many microseconds are counted, one
    /// counter per step. A game at 20 frames a second has 50 ms per frame, so
    /// the steps run from "not noticeable" to "two frames".
    inline constexpr std::uint64_t SPEED_TIMER_LATE_STEPS_US[] = { 1000, 5000, 20000, 100000 };
    inline constexpr std::size_t SPEED_TIMER_LATE_STEP_COUNT = sizeof(SPEED_TIMER_LATE_STEPS_US) / sizeof(SPEED_TIMER_LATE_STEPS_US[0]);

    struct speed_counters {
        // The scheduler (kernel/src/scheduler.cpp): the time the emulated
        // processor had no thread to run and waited for one. With the
        // `cpu_load_save` setting off it never waits, and this stays 0.
        speed_stopwatch idle;

        // The emulator paused (system/src/epoc.cpp): the thread that runs the
        // guest stands still, which is neither work nor waiting for work.
        speed_stopwatch paused;

        // The interpreter (system/src/epoc.cpp): ARM instructions executed, and
        // the number of runs they were executed in (a run ends when the thread
        // waits, is switched away from, or has used its time slice).
        std::atomic<std::uint64_t> instructions{ 0 };
        std::atomic<std::uint64_t> slices{ 0 };

        // The timers (kernel/src/timing.cpp): events that came due, and how
        // long after their time the timer thread got to them.
        std::atomic<std::uint64_t> timers_fired{ 0 };
        std::atomic<std::uint64_t> timers_late_us{ 0 };
        std::atomic<std::uint64_t> timers_max_late_us{ 0 };
        std::atomic<std::uint64_t> timers_late_over[SPEED_TIMER_LATE_STEP_COUNT]{};

        // The interpreter's translation cache (cpu/src/dyncom): bytes in use
        // after the last run, blocks of guest code handed to the translator,
        // the times it filled up and was emptied, and the times it was emptied
        // on request (the guest's code changed, or the system was reset).
        std::atomic<std::uint64_t> cache_bytes{ 0 };
        std::atomic<std::uint64_t> cache_blocks{ 0 };
        std::atomic<std::uint64_t> cache_flushes{ 0 };
        std::atomic<std::uint64_t> cache_clears{ 0 };

        void ran(const std::uint32_t instruction_count) {
            instructions.fetch_add(instruction_count, std::memory_order_relaxed);
            slices.fetch_add(1, std::memory_order_relaxed);
        }

        void timer_fired(const std::uint64_t late_us) {
            timers_fired.fetch_add(1, std::memory_order_relaxed);
            timers_late_us.fetch_add(late_us, std::memory_order_relaxed);

            // Only the timer thread writes the maximum.
            if (late_us > timers_max_late_us.load(std::memory_order_relaxed)) {
                timers_max_late_us.store(late_us, std::memory_order_relaxed);
            }

            for (std::size_t i = 0; (i < SPEED_TIMER_LATE_STEP_COUNT) && (late_us > SPEED_TIMER_LATE_STEPS_US[i]); i++) {
                timers_late_over[i].fetch_add(1, std::memory_order_relaxed);
            }
        }
    };

    inline speed_counters speed;
}
