// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <drivers/audio/stream.h>

#include <atomic>
#include <cstdint>
#include <vector>

namespace eka2l1::drivers {
    struct web_audio_driver;

    struct web_audio_output_stream : public audio_output_stream {
    private:
        friend struct web_audio_driver;

        data_callback callback_;

        std::atomic<bool> playing_{ false };
        std::atomic<bool> pausing_{ false };
        std::atomic<float> volume_{ 1.0f };
        std::atomic<std::uint64_t> frames_played_{ 0 };

        // Mixer-thread state.
        std::vector<std::int16_t> source_;
        double phase_ = 0.0;
        bool ended_ = false;

        // Called on the mixer thread with the driver's stream lock held.
        void render(float *out, const std::size_t frames, const std::uint32_t out_rate, const float master);

    public:
        explicit web_audio_output_stream(audio_driver *driver, const std::uint32_t sample_rate,
            const std::uint8_t channels, data_callback callback);
        ~web_audio_output_stream() override;

        bool start() override;
        bool stop() override;
        void pause() override;

        bool is_playing() override;
        bool is_pausing() override;

        bool set_volume(const float volume) override;
        float get_volume() const override;

        bool current_frame_position(std::uint64_t *pos) override;
    };

    // Recording is not offered in the browser build; the stream never produces data.
    struct web_audio_input_stream : public audio_input_stream {
        explicit web_audio_input_stream(audio_driver *driver, const std::uint32_t sample_rate, const std::uint8_t channels)
            : audio_input_stream(driver, sample_rate, channels) {
        }

        bool start() override {
            return false;
        }

        bool stop() override {
            return true;
        }

        bool is_recording() override {
            return false;
        }

        bool current_frame_position(std::uint64_t *pos) override {
            *pos = 0;
            return true;
        }
    };
}
