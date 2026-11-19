// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <drivers/audio/backend/baeplat_impl.h>
#include <drivers/audio/backend/web/audio_web.h>
#include <drivers/audio/backend/web/stream_web.h>

#include <common/log.h>
#include <common/thread.h>
#include <common/webdiag/audio.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>

namespace eka2l1::drivers {
    // About 340 ms at 48 kHz. Only a small part is kept filled (see TARGET_FILL_MS).
    static constexpr std::uint32_t RING_CAPACITY_FRAMES = 16384;
    static constexpr std::uint32_t DEFAULT_OUTPUT_RATE = 48000;
    static constexpr std::uint32_t TARGET_FILL_MS = WEB_AUDIO_TARGET_FILL_MS;
    static constexpr std::uint32_t MIX_INTERVAL_MS = WEB_AUDIO_MIX_INTERVAL_MS;
    static constexpr std::size_t MAX_BLOCK_FRAMES = 4096;

    // Diagnostics. A sample quieter than this (-80 dB) is silence: an empty
    // ring is a gap someone hears only while the mix is louder.
    static constexpr float SOUNDING_PEAK = 0.0001f;
    static constexpr std::int64_t LATE_WAKEUP_US = static_cast<std::int64_t>(WEB_AUDIO_LATE_WAKEUP_MS) * 1000;

    // Counts one wakeup of the mixer that slept for `slept_us`.
    static void count_wakeup(const std::int64_t slept_us) {
        webdiag::audio_counters &counters = webdiag::audio;
        counters.wakeups.fetch_add(1, std::memory_order_relaxed);

        const std::int64_t late = slept_us - static_cast<std::int64_t>(MIX_INTERVAL_MS) * 1000;
        if (late < LATE_WAKEUP_US) {
            return;
        }

        counters.late_wakeups.fetch_add(1, std::memory_order_relaxed);
        counters.late_us.fetch_add(static_cast<std::uint64_t>(late), std::memory_order_relaxed);
        if (slept_us >= static_cast<std::int64_t>(TARGET_FILL_MS) * 1000) {
            counters.stalled_wakeups.fetch_add(1, std::memory_order_relaxed);
        }
        // The mixer is the only writer.
        if (static_cast<std::uint64_t>(late) > counters.worst_late_us.load(std::memory_order_relaxed)) {
            counters.worst_late_us.store(static_cast<std::uint64_t>(late), std::memory_order_relaxed);
        }
    }

    web_audio_driver::web_audio_driver(const std::uint32_t initial_master_volume, const player_type preferred_midi_backend)
        : audio_driver(initial_master_volume, preferred_midi_backend) {
        ring_storage_.assign(RING_CAPACITY_FRAMES * 2, 0.0f);
        ring_.read_pos.store(0);
        ring_.write_pos.store(0);
        ring_.capacity = RING_CAPACITY_FRAMES;
        ring_.sample_rate = DEFAULT_OUTPUT_RATE;
        ring_.consumer_attached.store(0);
        ring_.data = ring_storage_.data();
        ring_.layout = WEB_AUDIO_RING_LAYOUT;
        ring_.sounding.store(0);
        ring_.blocks.store(0);
        ring_.underruns.store(0);
        ring_.underrun_frames.store(0);
        ring_.gaps.store(0);

        mixer_ = std::thread([this] { mixer_loop(); });
        LOG_INFO(DRIVER_AUD, "Web audio driver initialized ({} Hz until the page reports its rate)", ring_.sample_rate);
    }

    web_audio_driver::~web_audio_driver() {
        BAE_DriverDeactivated(this);

        quit_.store(true);
        if (mixer_.joinable()) {
            mixer_.join();
        }
    }

    void web_audio_driver::set_output_sample_rate(const std::uint32_t rate) {
        if (rate) {
            std::lock_guard<std::recursive_mutex> guard(streams_lock_);
            ring_.sample_rate = rate;
        }
    }

    void web_audio_driver::add_stream(web_audio_output_stream *stream) {
        std::lock_guard<std::recursive_mutex> guard(streams_lock_);
        streams_.push_back(stream);
    }

    void web_audio_driver::remove_stream(web_audio_output_stream *stream) {
        std::lock_guard<std::recursive_mutex> guard(streams_lock_);
        streams_.erase(std::remove(streams_.begin(), streams_.end(), stream), streams_.end());
    }

    bool web_audio_driver::mix(float *out, const std::size_t frames) {
        std::memset(out, 0, frames * 2 * sizeof(float));

        std::lock_guard<std::recursive_mutex> guard(streams_lock_);
        const float master = static_cast<float>(master_volume()) / 100.0f;

        // A drained callback may add or remove streams; walk a copy and skip
        // any stream that went away meanwhile.
        const std::vector<web_audio_output_stream *> snapshot = streams_;
        std::uint32_t playing = 0;
        for (web_audio_output_stream *stream : snapshot) {
            if (std::find(streams_.begin(), streams_.end(), stream) != streams_.end()) {
                playing += stream->playing_.load(std::memory_order_relaxed) ? 1 : 0;
                stream->render(out, frames, ring_.sample_rate, master);
            }
        }

        float peak = 0.0f;
        for (std::size_t i = 0; i < frames * 2; i++) {
            out[i] = std::clamp(out[i], -1.0f, 1.0f);
            peak = std::max(peak, std::abs(out[i]));
        }

        webdiag::audio.streams.store(static_cast<std::uint32_t>(streams_.size()), std::memory_order_relaxed);
        webdiag::audio.streams_playing.store(playing, std::memory_order_relaxed);
        return peak > SOUNDING_PEAK;
    }

    void web_audio_driver::mixer_loop() {
        common::set_thread_name("Web audio mixer");

        using clock = std::chrono::steady_clock;
        std::vector<float> block(MAX_BLOCK_FRAMES * 2);

        auto last = clock::now();
        double owed = 0.0; // frames due by wall clock while nothing consumes the ring

        auto asleep = last; // when the sleep began
        bool was_attached = false;

        while (!quit_.load()) {
            std::this_thread::sleep_for(std::chrono::milliseconds(MIX_INTERVAL_MS));

            const auto now = clock::now();
            const double elapsed = std::chrono::duration<double>(now - last).count();
            last = now;
            count_wakeup(std::chrono::duration_cast<std::chrono::microseconds>(now - asleep).count());

            const std::uint32_t rate = ring_.sample_rate;
            std::size_t frames = 0;
            const bool attached = ring_.consumer_attached.load(std::memory_order_relaxed) != 0;

            if (attached) {
                // Follow the audio clock: keep a fixed amount queued ahead of the worklet.
                const std::uint32_t fill = ring_.write_pos.load(std::memory_order_relaxed) - ring_.read_pos.load(std::memory_order_acquire);
                const std::uint32_t target = rate * TARGET_FILL_MS / 1000;
                frames = (fill < target) ? (target - fill) : 0;
                owed = 0.0;

                // The worklet starts with an empty ring, which is no fault.
                if (!fill && was_attached && ring_.sounding.load(std::memory_order_relaxed)) {
                    webdiag::audio.dry_wakeups.fetch_add(1, std::memory_order_relaxed);
                }
            } else {
                // Nobody is listening; advance by wall clock and drop the result.
                owed += elapsed * static_cast<double>(rate);
                owed = std::min(owed, static_cast<double>(rate) * 0.25);
                frames = static_cast<std::size_t>(owed);
                owed -= static_cast<double>(frames);
            }

            while (frames && !quit_.load()) {
                const std::size_t chunk = std::min(frames, MAX_BLOCK_FRAMES);
                ring_.sounding.store(mix(block.data(), chunk) ? 1 : 0, std::memory_order_relaxed);
                webdiag::audio.frames_mixed.fetch_add(chunk, std::memory_order_relaxed);

                if (attached) {
                    const std::uint32_t write = ring_.write_pos.load(std::memory_order_relaxed);
                    const std::uint32_t mask = ring_.capacity - 1;
                    for (std::size_t i = 0; i < chunk; i++) {
                        const std::uint32_t at = (write + static_cast<std::uint32_t>(i)) & mask;
                        ring_.data[at * 2] = block[i * 2];
                        ring_.data[at * 2 + 1] = block[i * 2 + 1];
                    }
                    ring_.write_pos.store(write + static_cast<std::uint32_t>(chunk), std::memory_order_release);
                }

                frames -= chunk;
            }

            was_attached = attached;
            asleep = clock::now();

            // A mix that takes as long as a late wakeup empties the ring just
            // the same, and is the emulator's doing: a stream's source or the
            // stream lock held the mixer up.
            const std::int64_t busy = std::chrono::duration_cast<std::chrono::microseconds>(asleep - now).count();
            webdiag::audio.busy_us.fetch_add(static_cast<std::uint64_t>(busy), std::memory_order_relaxed);
            if (busy >= LATE_WAKEUP_US) {
                webdiag::audio.slow_mixes.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

    std::unique_ptr<audio_output_stream> web_audio_driver::new_output_stream(const std::uint32_t sample_rate,
        const std::uint8_t channels, data_callback callback) {
        return std::make_unique<web_audio_output_stream>(this, sample_rate, channels, std::move(callback));
    }

    std::unique_ptr<audio_input_stream> web_audio_driver::new_input_stream(const std::uint32_t sample_rate,
        const std::uint8_t channels, data_callback) {
        return std::make_unique<web_audio_input_stream>(this, sample_rate, channels);
    }

    std::uint32_t web_audio_driver::native_sample_rate() {
        return ring_.sample_rate;
    }
}
