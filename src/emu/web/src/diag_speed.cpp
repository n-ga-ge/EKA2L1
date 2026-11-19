// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "speed" section of GET /v1/web/diag (web/diag.h): whether the emulated
// processor keeps up with the game. All times are microseconds and, like the
// counts, totals since the page loaded: the page takes two readings and works
// with the differences.
//
//   clockUs       when this reading was taken, on the clock the times below
//                 are measured with. The page divides by the difference of
//                 two of these, not by its own clock.
//   idleCounted   false when the `cpu_load_save` setting is off: the emulated
//                 processor then spins instead of waiting, and idleUs says
//                 nothing.
//   idleUs        the emulated processor had no thread to run and waited for
//                 one (a timer, a key press, the end of a wait for the screen).
//                 What is left of a stretch of time after idleUs and pausedUs
//                 is the time it was busy: running the guest's ARM code and
//                 the emulator's own work for it.
//   idles         the number of such waits.
//   pausedUs      the emulator was paused. Neither busy nor idle.
//   instructions  ARM instructions executed.
//   slices        runs of the interpreter they were executed in.
//   timers        events of the emulator's timer thread that came due:
//                 `fired` of them, `lateUs` the sum of how long after their
//                 time the thread got to them (the clock is read for each, so
//                 an event that waited for the one before it counts as late),
//                 `maxLateUs` the longest (a pause holds the timers back, so
//                 this one can be the length of a pause), `lateOver` how many
//                 were later than 1, 5, 20 and 100 ms. An event that was asked
//                 for with a time already past counts as late by that much.
//   cache         the interpreter's translation cache: `bytes` in use of
//                 `sizeBytes`, `blocks` of guest code handed to the
//                 translator, `flushes` (emptied because it was full) and
//                 `clears` (emptied on request: the guest's code changed, as
//                 when a program or library is loaded, or the system was
//                 reset).
//
// And, when the emulator can be looked into (see system_access) and has a
// screen:
//
//   guestFps      screen updates the guest made in the last second it was
//                 counted in. It is counted only when an update arrives, so it
//                 goes stale when the guest stops drawing.
//   frameLimit    the most screen updates a second the emulator lets the guest
//                 make (GET /v1/session/frame-limit; 0 for no limit). A guest
//                 that draws faster is put to sleep, which shows as idle time.

#include <web/diag.h>
#include <web/state.h>

#include <common/webdiag/speed.h>
#include <cpu/dyncom/armstate.h>
#include <services/window/screen.h>
#include <services/window/window.h>

namespace eka2l1::web {
    control::json diag_speed(emulator &state) {
        const webdiag::speed_counters &counters = webdiag::speed;
        const std::uint64_t now = webdiag::speed_clock_us();

        const auto number = [](const std::atomic<std::uint64_t> &value) {
            return static_cast<double>(value.load(std::memory_order_relaxed));
        };

        control::json::object late_over;
        for (std::size_t i = 0; i < webdiag::SPEED_TIMER_LATE_STEP_COUNT; i++) {
            late_over.emplace(std::to_string(webdiag::SPEED_TIMER_LATE_STEPS_US[i] / 1000) + "ms",
                number(counters.timers_late_over[i]));
        }

        control::json::object speed{
            { "clockUs", static_cast<double>(now) },
            { "idleCounted", state.conf.cpu_load_save },
            { "idleUs", static_cast<double>(counters.idle.read(now)) },
            { "idles", number(counters.idle.count) },
            { "pausedUs", static_cast<double>(counters.paused.read(now)) },
            { "instructions", number(counters.instructions) },
            { "slices", number(counters.slices) },
            { "timers", control::json({ { "fired", number(counters.timers_fired) },
                            { "lateUs", number(counters.timers_late_us) },
                            { "maxLateUs", number(counters.timers_max_late_us) },
                            { "lateOver", late_over } }) },
            { "cache", control::json({ { "bytes", number(counters.cache_bytes) },
                           { "sizeBytes", static_cast<double>(TRANS_CACHE_SIZE) },
                           { "blocks", number(counters.cache_blocks) },
                           { "flushes", number(counters.cache_flushes) },
                           { "clears", number(counters.cache_clears) } }) },
        };

        // The screen belongs to the guest's window server. Its numbers are
        // plain fields the guest's thread writes; they are read as the desktop
        // frontend reads them for its status bar, without stopping the guest.
        if (const system_access access{ state }) {
            if (epoc::screen *scr = state.winserv ? state.winserv->get_screens() : nullptr) {
                speed.emplace("guestFps", static_cast<double>(scr->last_fps));
                // As GET /v1/session/frame-limit (control/src/native.cpp) gives it.
                speed.emplace("frameLimit", scr->refresh_rate > 60 ? 0 : static_cast<int>(scr->refresh_rate));
            }
        }

        return control::json(std::move(speed));
    }
}
