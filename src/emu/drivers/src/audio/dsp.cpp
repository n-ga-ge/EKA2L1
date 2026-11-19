/*
 * Copyright (c) 2020 EKA2L1 Team.
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

#include <drivers/audio/backend/dsp_shared.h>
#include <drivers/audio/dsp.h>

#include <common/log.h>
#include <common/platform.h>

#if EKA2L1_HAS_FFMPEG
#include <drivers/audio/backend/ffmpeg/dsp_ffmpeg.h>
#else
#include <drivers/audio/backend/minimp3/mp3_minimp3.h>
#endif

namespace eka2l1::drivers {
#if !EKA2L1_HAS_FFMPEG
    // Builds without FFmpeg (iOS when it is switched off, and the web build) play raw PCM
    // streams, which is what games feed the DevSound path, and decode MP3 with minimp3
    // (N-Gage 2.0 games stream their music as MP3). MP3 is decoded when the guest writes it,
    // so the ring holds PCM and the stream asks for more as a PCM16 one does, in decoded
    // samples. What does not fit in the ring stays pending and the render callback decodes
    // it as the ring drains, before the guest is asked for more.
    struct dsp_output_stream_pcm final : public dsp_output_stream_shared {
        // Guards the decoder and the frame state below. The render callback only ever
        // try-locks it: the guest thread may hold it while set_properties() waits for the
        // render callback to finish.
        std::mutex mp3_lock_;
        mp3_stream_decoder mp3_;
        std::vector<std::int16_t> frame_;
        bool frame_held_ = false;
        mp3_stream_decoder::frame_format held_format_;
        std::uint32_t mp3_rate_ = 0;
        std::uint8_t mp3_channels_ = 0;

        // Whole frames may be pending that the render callback can decode itself.
        std::atomic<bool> mp3_backlog_{ false };

        explicit dsp_output_stream_pcm(drivers::audio_driver *aud)
            : dsp_output_stream_shared(aud) {
            format(PCM16_FOUR_CC_CODE);
        }

        ~dsp_output_stream_pcm() override {
            // Stop the render callback before the vtable degrades to the abstract
            // base, so an in-flight data_callback() can't hit a pure virtual.
            shutdown_stream();
        }

        bool decode_data(std::vector<std::uint8_t> &dest) override {
            dest.clear();
            return false;
        }

        void reset_mp3() {
            const std::lock_guard<std::mutex> guard(mp3_lock_);
            mp3_.reset();
            frame_.clear();
            frame_held_ = false;
            mp3_rate_ = 0;
            mp3_channels_ = 0;
            mp3_backlog_ = false;
        }

        // Decodes pending frames into the ring while it has room for one more; returns the
        // samples added. The stream plays at the MP3's own rate and channel count, as
        // DevSound's MP3 codec does, whatever the guest configured; only the guest thread
        // may rebuild the stream for a new one, so the render callback holds back a frame
        // in another format. The caller holds mp3_lock_.
        std::size_t decode_mp3(const bool on_guest_thread) {
            std::size_t queued = 0;
            mp3_stream_decoder::frame_format frame = held_format_;

            while (RING_BUFFER_MAX_SAMPLE_COUNT - buffer_.size() >= mp3_stream_decoder::MAX_FRAME_SAMPLES) {
                if (!frame_held_) {
                    frame_.clear();
                    if (!mp3_.next_frame(frame_, frame)) {
                        mp3_backlog_ = false;
                        return queued;
                    }
                }

                if ((frame.rate != mp3_rate_) || (frame.channels != mp3_channels_)) {
                    if (!on_guest_thread) {
                        frame_held_ = true;
                        held_format_ = frame;
                        mp3_backlog_ = false;
                        return queued;
                    }

                    mp3_rate_ = frame.rate;
                    mp3_channels_ = frame.channels;
                    dsp_output_stream_shared::set_properties(frame.rate, frame.channels);
                }

                frame_held_ = false;
                queued += buffer_.push(reinterpret_cast<const std::uint16_t *>(frame_.data()), frame_.size());
            }

            mp3_backlog_ = true;
            return queued;
        }

        bool write(const std::uint8_t *data, const std::uint32_t data_size) override {
            if (format_ != MP3_FOUR_CC_CODE) {
                return dsp_output_stream_shared::write(data, data_size);
            }

            std::size_t queued = 0;
            {
                const std::lock_guard<std::mutex> guard(mp3_lock_);
                mp3_.push(data, data_size);
                queued = decode_mp3(true);
            }

            // The look-ahead is measured in decoded samples. A write that completes no frame
            // keeps the previous measure rather than dropping it to nothing.
            if (queued != 0) {
                last_write_samples_.store(queued, std::memory_order_relaxed);
            }

            more_requested = false;
            return true;
        }

        bool set_properties(const std::uint32_t freq, const std::uint8_t channels) override {
            // Once MP3 frames play, their own format wins over what the guest configures.
            if ((format_ == MP3_FOUR_CC_CODE) && (mp3_rate_ != 0)) {
                return true;
            }

            return dsp_output_stream_shared::set_properties(freq, channels);
        }

        bool claim_more_buffer_request() override {
            if (format_ != MP3_FOUR_CC_CODE) {
                return dsp_output_stream_shared::claim_more_buffer_request();
            }

            if (mp3_backlog_ || (buffer_.size() > low_water_mark_samples())) {
                return false;
            }

            return !more_requested.exchange(true);
        }

        bool internal_decode_running_out() override {
            if (format_ != MP3_FOUR_CC_CODE) {
                return dsp_output_stream_shared::internal_decode_running_out();
            }

            if (buffer_.size() > low_water_mark_samples()) {
                return false;
            }

            // Top the ring up from what the guest already wrote before asking for more.
            if (mp3_backlog_) {
                std::unique_lock<std::mutex> guard(mp3_lock_, std::try_to_lock);
                if (guard.owns_lock()) {
                    decode_mp3(false);
                }
            }

            return !mp3_backlog_ && (buffer_.size() <= low_water_mark_samples());
        }

        bool stop() override {
            reset_mp3();
            return dsp_output_stream_shared::stop();
        }

        void queue_data_decode(const std::uint8_t *original, const std::size_t original_size) override {
            if (format_ == PCM8_FOUR_CC_CODE) {
                std::vector<std::int16_t> converted(original_size);
                for (std::size_t i = 0; i < original_size; ++i) {
                    converted[i] = static_cast<std::int16_t>(
                        static_cast<std::int8_t>(original[i])) << 8;
                }
                buffer_.push(reinterpret_cast<const std::uint16_t *>(converted.data()), converted.size());
                return;
            }

            buffer_.push(reinterpret_cast<const std::uint16_t *>(original), (original_size + 1) / 2);
        }

        bool format(const four_cc fmt) override {
            if ((fmt != PCM16_FOUR_CC_CODE) && (fmt != PCM8_FOUR_CC_CODE) && (fmt != MP3_FOUR_CC_CODE)) {
                LOG_WARN(DRIVER_AUD, "DSP output without FFmpeg only supports PCM and MP3 (asked for 0x{:08X} '{}{}{}{}')",
                    fmt, static_cast<char>(fmt & 0xFF), static_cast<char>((fmt >> 8) & 0xFF),
                    static_cast<char>((fmt >> 16) & 0xFF), static_cast<char>((fmt >> 24) & 0xFF));
                return false;
            }

            reset_mp3();
            format_ = fmt;
            return true;
        }

        void get_supported_formats(std::vector<four_cc> &cc_list) override {
            cc_list = { PCM16_FOUR_CC_CODE, PCM8_FOUR_CC_CODE, MP3_FOUR_CC_CODE };
        }
    };
#endif

    dsp_stream::dsp_stream()
        : samples_played_(0)
        , samples_copied_(0)
        , freq_(0)
        , channels_(0)
        , complete_callback_(nullptr)
        , more_buffer_callback_(nullptr)
        , complete_userdata_(nullptr)
        , more_buffer_userdata_(nullptr) {
    }

    dsp_output_stream::dsp_output_stream()
        : dsp_stream()
        , volume_(10) {
    }

    void dsp_stream::reset_stat() {
        samples_played_.store(0, std::memory_order_relaxed);
        samples_copied_.store(0, std::memory_order_relaxed);
    }

    void dsp_stream::register_callback(dsp_stream_notification_type nof_type, dsp_stream_notification_callback callback,
        void *userdata) {
        const std::lock_guard<std::mutex> guard(callback_lock_);

        switch (nof_type) {
        case dsp_stream_notification_done:
            complete_callback_ = callback;
            complete_userdata_ = userdata;
            break;

        case dsp_stream_notification_more_buffer:
            more_buffer_userdata_ = userdata;
            more_buffer_callback_ = callback;
            break;

        default:
            LOG_ERROR(DRIVER_AUD, "Unsupport notification type!");
            break;
        }
    }

    void *dsp_stream::get_userdata(dsp_stream_notification_type nof_type) {
        switch (nof_type) {
        case dsp_stream_notification_done:
            return complete_userdata_;

        case dsp_stream_notification_more_buffer:
            return more_buffer_userdata_;

        default:
            LOG_ERROR(DRIVER_AUD, "Unsupport notification type!");
            break;
        }

        return nullptr;
    }


    std::unique_ptr<dsp_stream> new_dsp_out_stream(drivers::audio_driver *aud, const dsp_stream_backend dsp_backend) {
        switch (dsp_backend) {
        case dsp_stream_backend_ffmpeg:
#if EKA2L1_HAS_FFMPEG
            return std::make_unique<dsp_output_stream_ffmpeg>(aud);
#else
            return std::make_unique<dsp_output_stream_pcm>(aud);
#endif

        default:
            break;
        }

        return nullptr;
    }

    std::unique_ptr<dsp_stream> new_dsp_in_stream(drivers::audio_driver *aud, const dsp_stream_backend dsp_backend) {
        switch (dsp_backend) {
        case dsp_stream_backend_ffmpeg:
            return std::make_unique<dsp_input_stream_shared>(aud);

        default:
            break;
        }

        return nullptr;
    }
}
