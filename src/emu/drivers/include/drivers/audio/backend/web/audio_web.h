// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <drivers/audio/audio.h>

#include <atomic>
#include <cstdint>
#include <mutex>
#include <thread>
#include <vector>

namespace eka2l1::drivers {
    struct web_audio_output_stream;

    // The mixer wakes every WEB_AUDIO_MIX_INTERVAL_MS and keeps
    // WEB_AUDIO_TARGET_FILL_MS of sound queued ahead of the worklet. For the
    // diagnostics, a wakeup that comes WEB_AUDIO_LATE_WAKEUP_MS later than
    // asked for is late: a quarter of that reserve was played meanwhile.
    inline constexpr std::uint32_t WEB_AUDIO_MIX_INTERVAL_MS = 5;
    inline constexpr std::uint32_t WEB_AUDIO_TARGET_FILL_MS = 60;
    inline constexpr std::uint32_t WEB_AUDIO_LATE_WAKEUP_MS = WEB_AUDIO_TARGET_FILL_MS / 4;

    // What web_audio_ring::layout holds: a mark in the upper half and the
    // number of times fields were appended in the lower. A page can meet an
    // older build (the dev server lays page sources over any build), where a
    // pointer is in that place; the mark is a value no pointer has.
    inline constexpr std::uint32_t WEB_AUDIO_RING_LAYOUT = 0xE2A10001;

    // Single-producer / single-consumer ring of interleaved stereo float frames.
    // The producer is the mixer thread below; the consumer is an AudioWorklet on
    // the page, which reads this structure straight out of the shared wasm
    // memory. Keep the layout in step with the worklet (web/shell/audio-worklet.js).
    // The worklet, the page's diagnostics and the tests under tools/web read
    // the fields by their position: never reorder them, only append.
    struct web_audio_ring {
        std::atomic<std::uint32_t> read_pos; // frames, free-running
        std::atomic<std::uint32_t> write_pos; // frames, free-running
        std::uint32_t capacity; // frames, power of two
        std::uint32_t sample_rate;
        std::atomic<std::uint32_t> consumer_attached;
        float *data; // capacity * 2 floats

        // Appended for the diagnostics (GET /v1/web/diag, section "audio").
        // The worklet touches what follows only when `layout` says it exists.
        // The mixer writes `sounding`, the worklet the rest.
        std::uint32_t layout; // WEB_AUDIO_RING_LAYOUT
        std::atomic<std::uint32_t> sounding; // the block mixed last was not silence
        std::atomic<std::uint32_t> blocks; // blocks the worklet was asked for
        std::atomic<std::uint32_t> underruns; // blocks it could not fill while sound was playing
        std::atomic<std::uint32_t> underrun_frames; // frames missing from those blocks
        std::atomic<std::uint32_t> gaps; // runs of such blocks: what a listener hears as one gap
    };

    static_assert(sizeof(web_audio_ring) == 12 * sizeof(std::uint32_t), "the worklet reads web_audio_ring by word offsets");

    // Audio driver for the browser. cubeb has no web backend, so this mixes all
    // guest streams itself on a host thread, resampling each to the page's
    // AudioContext rate, and hands the result over through web_audio_ring.
    //
    // With no worklet attached (headless runs, or before the first user gesture
    // unlocks audio) the mixer paces itself by wall clock and discards its
    // output, so guest code that waits on audio progress still advances.
    struct web_audio_driver : public audio_driver {
    private:
        friend struct web_audio_output_stream;

        web_audio_ring ring_;
        std::vector<float> ring_storage_;

        // Recursive: a stream's drained callback runs on the mixer with this held
        // and may stop or restart streams.
        std::recursive_mutex streams_lock_;
        std::vector<web_audio_output_stream *> streams_;

        std::thread mixer_;
        std::atomic<bool> quit_{ false };

        void mixer_loop();
        // Returns whether the block has sound in it.
        bool mix(float *out, const std::size_t frames);

        void add_stream(web_audio_output_stream *stream);
        void remove_stream(web_audio_output_stream *stream);

    public:
        explicit web_audio_driver(const std::uint32_t initial_master_volume = 100, const player_type preferred_midi_backend = player_type_tsf);
        ~web_audio_driver() override;

        std::unique_ptr<audio_output_stream> new_output_stream(const std::uint32_t sample_rate,
            const std::uint8_t channels, data_callback callback) override;

        std::unique_ptr<audio_input_stream> new_input_stream(const std::uint32_t sample_rate,
            const std::uint8_t channels, data_callback callback) override;

        std::uint32_t native_sample_rate() override;

        // The page calls this once its AudioContext exists, before attaching the worklet.
        void set_output_sample_rate(const std::uint32_t rate);

        web_audio_ring *ring() {
            return &ring_;
        }
    };
}
