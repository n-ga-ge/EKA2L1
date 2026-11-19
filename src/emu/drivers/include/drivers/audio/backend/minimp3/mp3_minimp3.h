// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <vector>

namespace eka2l1::drivers {
    // MPEG audio (layer III, also I and II) decoded with minimp3, for the DSP output
    // stream of builds without FFmpeg. The guest hands the stream an MP3 file in pieces
    // of any size, so input is kept until it holds a whole frame.
    class mp3_stream_decoder {
    public:
        struct frame_format {
            std::uint32_t rate = 0;
            std::uint8_t channels = 0;
        };

        // Most interleaved samples one frame decodes to (1152 per channel, two channels).
        static constexpr std::size_t MAX_FRAME_SAMPLES = 1152 * 2;

        mp3_stream_decoder();
        ~mp3_stream_decoder();

        // Forgets the pending input and the decoder state (a new stream starts).
        void reset();

        void push(const std::uint8_t *data, const std::size_t size);

        // Decodes the next whole frame pending and appends its interleaved samples to out.
        // Returns false when no whole frame is pending yet.
        bool next_frame(std::vector<std::int16_t> &out, frame_format &format);

    private:
        struct state;
        std::unique_ptr<state> state_;
    };
}
