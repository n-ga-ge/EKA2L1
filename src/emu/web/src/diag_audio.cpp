// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "audio" section of GET /v1/web/diag (web/diag.h): whether the sound the
// guest makes reaches the page without gaps.
//
// Sound goes guest streams -> mixer thread -> ring in wasm memory -> the
// page's AudioWorklet (drivers/audio/backend/web/audio_web.h). The section is
//
//   rate            frames per second the mixer produces (the AudioContext's
//                   rate once the page has one)
//   attached        the page's worklet plays from the ring; until then the
//                   mixer throws its output away
//   capacity, fill  the ring's size and what waits in it now, in frames
//   targetMs        how much the mixer keeps queued ahead of the worklet
//   sounding        the block mixed last was not silence
//   streams         streams the guest has open, as of the last mix
//   playing         those of them that play
//                   (the mixer mixes nothing while the page's output is
//                   suspended and the ring is full, so these three are then
//                   as old as the suspension)
//   streamsCutShort streams ended because their source gave less than asked
//                   for; a clip that simply reached its end counts too
//   mixer           the mixer thread:
//     intervalMs      how long it sleeps between two top-ups
//     lateAfterMs     a wakeup this much later than asked for counts as late
//     wakeups         times it woke
//     late            wakeups that came late
//     stalled         of those, the ones later than targetMs after the sleep
//                     began: the ring's whole reserve was played meanwhile
//     lateMs          how much later than asked for, summed over late wakeups
//     worstLateMs     the worst one
//     dry             wakeups that found the ring empty while the worklet was
//                     attached and the mix had sound
//     frames          frames mixed
//     busyMs          time spent mixing
//     slow            turns in which mixing took lateAfterMs or longer: the
//                     mixer was held up inside the emulator (a stream's
//                     source, which for an MP3 stream decodes there, or the
//                     stream lock), which is no late wakeup
//   worklet         what the page's worklet counted into the ring:
//     blocks          blocks the browser asked it for
//     underruns       blocks it could not fill while `sounding` was set
//     underrunFrames  frames missing from them (it plays silence instead)
//     gaps            runs of such blocks, which is what is heard as one gap
//
// All but rate, attached, capacity, fill, targetMs, sounding, streams and
// playing are totals since the page loaded; the worklet's wrap at 2^32. An
// empty ring while the game is silent is no underrun: the worklet looks at
// `sounding` to tell.

#include <web/diag.h>
#include <web/state.h>

#include <common/webdiag/audio.h>
#include <drivers/audio/backend/web/audio_web.h>

namespace eka2l1::web {
    control::json diag_audio(emulator &state) {
        // Created once before the first request and never replaced.
        auto *driver = static_cast<drivers::web_audio_driver *>(state.audio_driver.get());
        if (!driver) {
            return control::json(control::json::object{});
        }

        const drivers::web_audio_ring &ring = *driver->ring();
        const webdiag::audio_counters &counters = webdiag::audio;
        const auto ms = [](const std::atomic<std::uint64_t> &us) {
            return static_cast<double>(us.load(std::memory_order_relaxed)) / 1000.0;
        };
        const auto total = [](const std::atomic<std::uint64_t> &count) {
            return static_cast<double>(count.load(std::memory_order_relaxed));
        };

        const std::uint32_t fill = ring.write_pos.load(std::memory_order_relaxed) - ring.read_pos.load(std::memory_order_relaxed);

        return control::json({
            { "rate", ring.sample_rate },
            { "attached", ring.consumer_attached.load(std::memory_order_relaxed) != 0 },
            { "capacity", ring.capacity },
            // The two positions are read one after the other while both move.
            { "fill", fill <= ring.capacity ? fill : 0 },
            { "targetMs", drivers::WEB_AUDIO_TARGET_FILL_MS },
            { "sounding", ring.sounding.load(std::memory_order_relaxed) != 0 },
            { "streams", counters.streams.load(std::memory_order_relaxed) },
            { "playing", counters.streams_playing.load(std::memory_order_relaxed) },
            { "streamsCutShort", total(counters.streams_cut_short) },
            { "mixer", control::json({
                           { "intervalMs", drivers::WEB_AUDIO_MIX_INTERVAL_MS },
                           { "lateAfterMs", drivers::WEB_AUDIO_LATE_WAKEUP_MS },
                           { "wakeups", total(counters.wakeups) },
                           { "late", total(counters.late_wakeups) },
                           { "stalled", total(counters.stalled_wakeups) },
                           { "lateMs", ms(counters.late_us) },
                           { "worstLateMs", ms(counters.worst_late_us) },
                           { "dry", total(counters.dry_wakeups) },
                           { "frames", total(counters.frames_mixed) },
                           { "busyMs", ms(counters.busy_us) },
                           { "slow", total(counters.slow_mixes) },
                       }) },
            { "worklet", control::json({
                             { "blocks", ring.blocks.load(std::memory_order_relaxed) },
                             { "underruns", ring.underruns.load(std::memory_order_relaxed) },
                             { "underrunFrames", ring.underrun_frames.load(std::memory_order_relaxed) },
                             { "gaps", ring.gaps.load(std::memory_order_relaxed) },
                         }) },
        });
    }
}
