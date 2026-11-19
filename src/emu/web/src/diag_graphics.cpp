// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "graphics" section of GET /v1/web/diag (web/diag.h): how the picture
// gets to the page and what the game pays for it.
//
//   frames            frames presented to the canvas
//   busyMs            time the graphics thread spent executing draw commands
//                     (the number eka2l1_web_graphics_busy_us gives the page)
//   animationCalls    times the browser called the graphics thread for an
//                     animation frame: one per frame the browser draws of
//                     this page, so their rate is the display's
//   animationFrames   how many of those calls ended with a frame presented
//   timerCalls        times the timer that stands in for animation frames
//                     did a frame's work, because none had come for a tenth
//                     of a second (a page the browser does not draw)
//   timerFrames       how many of those ended with a frame presented
//   presents          frames the guest handed over
//   presentWaitMs     time the guest waited, before handing over a frame,
//                     for the frame before to be presented: time the game
//                     stood still for the picture
//   presentWaits      waits of a millisecond or more
//   presentWaitsLong  waits of a tenth of a second or more
//   syncCommands      draw commands the guest waited for because they return
//                     something (a new bitmap, the pixels of one)
//   syncWaitMs        time the guest waited for those, behind whatever the
//                     graphics thread was drawing
//   submitWaitMs      time the guest spent handing over command lists, which
//                     is next to nothing unless the queue is full
//   contextLost       the browser has taken the WebGL context away (seen by
//                     the graphics thread, which looks about 30 times a second)
//   contextLosses     how often that happened
//   debugAnimationFrames  the test switch eka2l1_web_debug_animation_frames,
//                     0 unless a test set it: a report made under it says so
//
// All of them are totals since the page loaded and all are read from
// atomics, so nothing here needs the emulator's lock.

#include <web/diag.h>
#include <web/state.h>

#include <common/webdiag/graphics.h>

namespace eka2l1::drivers {
    extern std::atomic<std::uint64_t> web_graphics_busy_us;
    extern std::atomic<int> web_debug_animation_frames;
}

namespace eka2l1::web {
    control::json diag_graphics(emulator &state) {
        const webdiag::graphics_counters &counters = webdiag::graphics;

        const auto count = [](const std::atomic<std::uint64_t> &counter) {
            return static_cast<double>(counter.load(std::memory_order_relaxed));
        };

        return control::json({
            { "frames", count(state.frames) },
            { "busyMs", count(drivers::web_graphics_busy_us) / 1000.0 },
            { "animationCalls", count(counters.animation_calls) },
            { "animationFrames", count(counters.animation_frames) },
            { "timerCalls", count(counters.timer_calls) },
            { "timerFrames", count(counters.timer_frames) },
            { "presents", count(counters.presents) },
            { "presentWaitMs", count(counters.present_wait_us) / 1000.0 },
            { "presentWaits", count(counters.present_waits) },
            { "presentWaitsLong", count(counters.present_waits_long) },
            { "syncCommands", count(counters.sync_commands) },
            { "syncWaitMs", count(counters.sync_wait_us) / 1000.0 },
            { "submitWaitMs", count(counters.submit_wait_us) / 1000.0 },
            { "contextLost", counters.context_lost.load(std::memory_order_relaxed) },
            { "contextLosses", count(counters.context_losses) },
            { "debugAnimationFrames", drivers::web_debug_animation_frames.load(std::memory_order_relaxed) },
        });
    }
}
