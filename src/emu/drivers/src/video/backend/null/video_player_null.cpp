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

#include <drivers/video/backend/null/video_player_null.h>

#include <algorithm>

namespace eka2l1::drivers {
    bool video_player_null::open_file(const std::string &) {
        return false;
    }

    bool video_player_null::open_custom_io(common::ro_stream &) {
        return false;
    }

    void video_player_null::close() {
    }

    // Unreachable from the guest: its player only plays a clip that opened.
    void video_player_null::play(const std::uint64_t *) {
    }

    void video_player_null::pause() {
    }

    void video_player_null::stop() {
    }

    std::uint32_t video_player_null::max_volume() const {
        return MAX_VOLUME;
    }

    std::uint32_t video_player_null::volume() const {
        return volume_;
    }

    bool video_player_null::set_volume(const std::uint32_t volume) {
        volume_ = std::min(volume, MAX_VOLUME);
        return true;
    }

    std::uint64_t video_player_null::duration() const {
        return 0;
    }

    std::uint64_t video_player_null::position() const {
        return 0;
    }

    void video_player_null::set_position(const std::uint64_t) {
    }

    eka2l1::vec2 video_player_null::get_video_size() const {
        return eka2l1::vec2(0, 0);
    }

    void video_player_null::set_fps(const float fps) {
        fps_ = fps;
    }

    float video_player_null::get_fps() const {
        return fps_;
    }

    std::uint32_t video_player_null::audio_bitrate() const {
        return 0;
    }

    std::uint32_t video_player_null::video_bitrate() const {
        return 0;
    }
}
