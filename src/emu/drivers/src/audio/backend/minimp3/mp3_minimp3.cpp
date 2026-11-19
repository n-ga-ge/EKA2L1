// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <drivers/audio/backend/minimp3/mp3_minimp3.h>

#define MINIMP3_IMPLEMENTATION
#include <minimp3.h>

static_assert(eka2l1::drivers::mp3_stream_decoder::MAX_FRAME_SAMPLES == MINIMP3_MAX_SAMPLES_PER_FRAME);

namespace eka2l1::drivers {
    struct mp3_stream_decoder::state {
        mp3dec_t dec;
        std::vector<std::uint8_t> pending;
        std::size_t offset = 0;
    };

    mp3_stream_decoder::mp3_stream_decoder()
        : state_(std::make_unique<state>()) {
        reset();
    }

    mp3_stream_decoder::~mp3_stream_decoder() = default;

    void mp3_stream_decoder::reset() {
        mp3dec_init(&state_->dec);
        state_->pending.clear();
        state_->offset = 0;
    }

    void mp3_stream_decoder::push(const std::uint8_t *data, const std::size_t size) {
        state &s = *state_;
        s.pending.erase(s.pending.begin(), s.pending.begin() + s.offset);
        s.offset = 0;
        s.pending.insert(s.pending.end(), data, data + size);
    }

    bool mp3_stream_decoder::next_frame(std::vector<std::int16_t> &out, frame_format &format) {
        state &s = *state_;
        mp3d_sample_t pcm[MINIMP3_MAX_SAMPLES_PER_FRAME];

        while (s.pending.size() - s.offset >= HDR_SIZE) {
            const std::uint8_t *at = s.pending.data() + s.offset;
            const int available = static_cast<int>(s.pending.size() - s.offset);
            int limit = available;

            // minimp3 only takes a frame when the header after it is in the buffer too. Once in
            // sync, a frame is decoded as soon as all of it has arrived, so the last frame the
            // guest writes is not held back waiting for a successor that never comes.
            bool in_sync = (s.dec.header[0] == 0xFF) && hdr_compare(s.dec.header, at);
            if (in_sync) {
                const int size = hdr_frame_bytes(at, s.dec.free_format_bytes) + hdr_padding(at);
                if (size > available) {
                    return false;
                }

                in_sync = size > HDR_SIZE;
                if (in_sync) {
                    limit = size;
                }
            }

            mp3dec_frame_info_t info{};
            const int samples = mp3dec_decode_frame(&s.dec, at, limit, pcm, &info);

            if (!in_sync && (s.dec.header[0] != 0xFF)) {
                // No frame in what is here. Drop it, except a tail that may be the start of a
                // frame still arriving.
                if (available <= MAX_FREE_FORMAT_FRAME_SIZE) {
                    return false;
                }

                s.offset += available - MAX_FREE_FORMAT_FRAME_SIZE;
                continue;
            }

            if (info.frame_bytes <= 0) {
                return false;
            }

            s.offset += info.frame_bytes;

            if (samples > 0) {
                format.rate = static_cast<std::uint32_t>(info.hz);
                format.channels = static_cast<std::uint8_t>(info.channels);
                out.insert(out.end(), pcm, pcm + samples * info.channels);
                return true;
            }
        }

        return false;
    }
}
