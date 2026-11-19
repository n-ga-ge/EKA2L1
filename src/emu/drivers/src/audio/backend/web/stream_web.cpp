// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <drivers/audio/backend/web/audio_web.h>
#include <drivers/audio/backend/web/stream_web.h>

#include <common/webdiag/audio.h>

#include <algorithm>
#include <cmath>

namespace eka2l1::drivers {
    web_audio_output_stream::web_audio_output_stream(audio_driver *driver, const std::uint32_t sample_rate,
        const std::uint8_t channels, data_callback callback)
        : audio_output_stream(driver, sample_rate, channels)
        , callback_(std::move(callback)) {
        static_cast<web_audio_driver *>(driver_)->add_stream(this);
    }

    web_audio_output_stream::~web_audio_output_stream() {
        static_cast<web_audio_driver *>(driver_)->remove_stream(this);
    }

    void web_audio_output_stream::render(float *out, const std::size_t frames, const std::uint32_t out_rate, const float master) {
        if (!playing_.load(std::memory_order_relaxed) || !sample_rate || !channels || !frames) {
            return;
        }

        if (pausing_.load(std::memory_order_relaxed) || driver_->suspending()) {
            return;
        }

        // source_ holds source frames not yet fully consumed; phase_ is the
        // fractional read position relative to its first frame. Linear
        // interpolation reads one frame past the last whole position.
        const double step = static_cast<double>(sample_rate) / static_cast<double>(out_rate);
        const std::size_t wanted = static_cast<std::size_t>(phase_ + step * static_cast<double>(frames)) + 2;

        std::size_t have = source_.size() / channels;
        if (have < wanted && !ended_) {
            const std::size_t missing = wanted - have;
            source_.resize(wanted * channels);
            const std::size_t got = callback_(source_.data() + have * channels, missing);
            if (got < missing) {
                // A short read ends the stream, as with the other backends.
                ended_ = true;
                webdiag::audio.streams_cut_short.fetch_add(1, std::memory_order_relaxed);
                source_.resize((have + got) * channels);
            }
            have += got;
        }

        const float gain = volume_.load(std::memory_order_relaxed) * master;
        const int right = (channels >= 2) ? 1 : 0;

        auto sample_at = [&](const std::size_t frame, const int channel) -> float {
            if (frame >= have) {
                return 0.0f;
            }
            return static_cast<float>(source_[frame * channels + channel]) * (1.0f / 32768.0f);
        };

        double position = phase_;
        for (std::size_t i = 0; i < frames; i++) {
            const std::size_t whole = static_cast<std::size_t>(position);
            const float frac = static_cast<float>(position - static_cast<double>(whole));
            const float l0 = sample_at(whole, 0), l1 = sample_at(whole + 1, 0);
            const float r0 = sample_at(whole, right), r1 = sample_at(whole + 1, right);
            out[i * 2] += (l0 + (l1 - l0) * frac) * gain;
            out[i * 2 + 1] += (r0 + (r1 - r0) * frac) * gain;
            position += step;
        }

        const std::size_t consumed = std::min(static_cast<std::size_t>(position), have);
        source_.erase(source_.begin(), source_.begin() + consumed * channels);
        phase_ = position - static_cast<double>(consumed);
        frames_played_.fetch_add(consumed, std::memory_order_relaxed);

        if (ended_ && source_.empty()) {
            playing_.store(false, std::memory_order_relaxed);
            ended_ = false;
            phase_ = 0.0;
            if (drained_callback_) {
                drained_callback_();
            }
        }
    }

    bool web_audio_output_stream::start() {
        if (pausing_.exchange(false)) {
            return true;
        }

        if (!playing_.load()) {
            std::lock_guard<std::recursive_mutex> guard(static_cast<web_audio_driver *>(driver_)->streams_lock_);
            frames_played_.store(0);
            phase_ = 0.0;
            source_.clear();
            ended_ = false;
            playing_.store(true);
        }

        return true;
    }

    bool web_audio_output_stream::stop() {
        // Taking the stream lock guarantees the mixer is not inside the data
        // or drained callback once this returns.
        std::lock_guard<std::recursive_mutex> guard(static_cast<web_audio_driver *>(driver_)->streams_lock_);
        playing_.store(false);
        pausing_.store(false);
        return true;
    }

    void web_audio_output_stream::pause() {
        pausing_.store(true);
    }

    bool web_audio_output_stream::is_playing() {
        return playing_.load();
    }

    bool web_audio_output_stream::is_pausing() {
        return pausing_.load();
    }

    bool web_audio_output_stream::set_volume(const float volume) {
        volume_.store(volume);
        return true;
    }

    float web_audio_output_stream::get_volume() const {
        return volume_.load();
    }

    bool web_audio_output_stream::current_frame_position(std::uint64_t *pos) {
        *pos = frames_played_.load();
        return true;
    }
}
