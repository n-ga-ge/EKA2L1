// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <cstdint>

// Counters of the browser build's diagnostics (GET /v1/web/diag, section
// "audio"): the sound mixer and the ring the page plays from.
//
// They are plain atomics so the code that counts never waits: a core file adds
// to one in a single line inside `#if EKA2L1_PLATFORM(WEB)`, and the web
// frontend (web/src/diag_audio.cpp) reads them. Totals since the page loaded;
// the page works out rates from two readings.
namespace eka2l1::webdiag {
    struct audio_counters {
        // The mixer thread (drivers/audio/backend/web/audio_web.cpp). It sleeps
        // for a fixed interval and then tops the ring up, so how long a sleep
        // really took says whether the machine gives the thread time.
        std::atomic<std::uint64_t> wakeups{ 0 };
        // Wakeups that came much later than asked for (late_after_us more).
        std::atomic<std::uint64_t> late_wakeups{ 0 };
        // Of those, the ones that came so late that the ring's whole reserve
        // was played meanwhile.
        std::atomic<std::uint64_t> stalled_wakeups{ 0 };
        // How much later than asked for, summed over the late wakeups, and the
        // worst one.
        std::atomic<std::uint64_t> late_us{ 0 };
        std::atomic<std::uint64_t> worst_late_us{ 0 };
        // Wakeups that found the ring empty while the page was playing from it
        // and the game was making sound.
        std::atomic<std::uint64_t> dry_wakeups{ 0 };
        // Frames mixed (played or, with nobody listening, thrown away) and the
        // time mixing them took.
        std::atomic<std::uint64_t> frames_mixed{ 0 };
        std::atomic<std::uint64_t> busy_us{ 0 };
        // Turns in which mixing itself took as long as a late wakeup: the
        // mixer was held up inside the emulator, not by the machine.
        std::atomic<std::uint64_t> slow_mixes{ 0 };

        // Streams the guest has open and those playing, as of the last mix.
        std::atomic<std::uint32_t> streams{ 0 };
        std::atomic<std::uint32_t> streams_playing{ 0 };
        // Streams ended because their source returned less than asked for
        // (stream_web.cpp). A clip that reached its end counts as well.
        std::atomic<std::uint64_t> streams_cut_short{ 0 };
    };

    inline audio_counters audio;
}
