/*
 * Copyright (c) 2026 EKA2L1 Team.
 * 
 * This file is part of EKA2L1 project.
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#pragma once

#include <drivers/video/video.h>

namespace eka2l1::drivers {
    /**
     * @brief Video player for builds without a decoder (no FFmpeg, as on the web).
     *
     * Every open fails, so the guest's player reports "not supported" through its open callback
     * and a game goes on without its movie, instead of the HLE player calling a missing backend.
     */
    class video_player_null : public video_player {
        std::uint32_t volume_ = MAX_VOLUME;
        float fps_ = 0.0f;

    public:
        static constexpr std::uint32_t MAX_VOLUME = 10;

        bool open_file(const std::string &path) override;
        bool open_custom_io(common::ro_stream &stream) override;
        void close() override;

        void play(const std::uint64_t *us_range) override;
        void pause() override;
        void stop() override;

        std::uint32_t max_volume() const override;
        std::uint32_t volume() const override;
        bool set_volume(const std::uint32_t volume) override;

        std::uint64_t duration() const override;
        std::uint64_t position() const override;
        void set_position(const std::uint64_t pos) override;
        eka2l1::vec2 get_video_size() const override;

        void set_fps(const float fps) override;
        float get_fps() const override;

        std::uint32_t audio_bitrate() const override;
        std::uint32_t video_bitrate() const override;
    };
}
