// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/link.h>

#include <common/thread.h>

#include <algorithm>
#include <cstring>
#include <thread>

namespace eka2l1::epoc::bt::web {
    std::string clean_name(const char *data, const std::size_t size, const std::size_t max_size) {
        const unsigned char *in = reinterpret_cast<const unsigned char *>(data);
        std::string out;

        for (std::size_t i = 0; i < size;) {
            const unsigned char lead = in[i];
            std::size_t length = 1;
            std::uint32_t code = lead;

            if (lead >= 0xF0) {
                length = 4;
                code = lead & 0x07;
            } else if (lead >= 0xE0) {
                length = 3;
                code = lead & 0x0F;
            } else if (lead >= 0xC0) {
                length = 2;
                code = lead & 0x1F;
            }

            bool good = (lead < 0x80) || ((lead >= 0xC2) && (lead <= 0xF4));
            if (good && (i + length > size)) {
                good = false;
            }

            for (std::size_t k = 1; good && (k < length); k++) {
                if ((in[i + k] & 0xC0) != 0x80) {
                    good = false;
                } else {
                    code = (code << 6) | (in[i + k] & 0x3F);
                }
            }

            // No overlong forms, no surrogates, nothing past the last code point.
            static const std::uint32_t SMALLEST[] = { 0, 0, 0x80, 0x800, 0x10000 };
            if (good && ((code < SMALLEST[length]) || (code > 0x10FFFF) || ((code >= 0xD800) && (code <= 0xDFFF)))) {
                good = false;
            }

            if (!good) {
                i++;
                continue;
            }

            const bool control = (code < 0x20) || ((code >= 0x7F) && (code < 0xA0));
            if (!control) {
                if (out.size() + length > max_size) {
                    break;
                }

                out.append(data + i, length);
            }

            i += length;
        }

        return out;
    }

    link &link::get() {
        static link instance;
        return instance;
    }

    void link::push(event &&evt) {
        bool start = false;

        {
            const std::lock_guard<std::mutex> guard(queue_mutex_);

            if (!thread_started_) {
                // Nothing reads the queue until the page first brings the link
                // up, and nothing that arrives before that can mean anything.
                if ((evt.type != EVENT_LINK) || (evt.id == 0)) {
                    return;
                }

                thread_started_ = true;
                start = true;
            }

            if ((evt.type == EVENT_FRAME) && (queued_bytes_ + evt.data.size() > MAX_QUEUED_BYTES)) {
                // The reader is this far behind. The frame is lost, and since it
                // could have been any kind of frame, the handler is told once
                // (in its place in the queue) to start over with everybody.
                frames_dropped_++;

                if (overflow_queued_) {
                    return;
                }

                overflow_queued_ = true;
                evt.type = EVENT_OVERFLOW;
                evt.data.clear();
            }

            queued_bytes_ += evt.data.size();
            queue_.push_back(std::move(evt));
        }

        if (start) {
            std::thread([this]() { drain(); }).detach();
        }

        queue_signal_.notify_one();
    }

    void link::post_link(const int self_id, const char *name) {
        event evt;
        evt.type = EVENT_LINK;
        evt.id = (self_id > 0 && self_id <= 255) ? self_id : 0;
        evt.present = false;

        if (name) {
            evt.name = clean_name(name, std::strlen(name), MAX_NAME_SIZE);
        }

        push(std::move(evt));
    }

    void link::post_peer(const int id, const bool present) {
        if ((id <= 0) || (id > 255)) {
            return;
        }

        event evt;
        evt.type = EVENT_PEER;
        evt.id = id;
        evt.present = present;

        push(std::move(evt));
    }

    void link::post_frame(const int src, const void *data, const int size) {
        if ((src <= 0) || (src > 255) || !data || (size <= 0) || (static_cast<std::size_t>(size) > MAX_FRAME_SIZE)) {
            return;
        }

        event evt;
        evt.type = EVENT_FRAME;
        evt.id = src;
        evt.present = true;
        evt.data.assign(static_cast<const std::uint8_t *>(data), static_cast<const std::uint8_t *>(data) + size);

        push(std::move(evt));
    }

    void link::drain() {
        common::set_thread_name("Bluetooth link thread");

        for (;;) {
            event evt;

            {
                std::unique_lock<std::mutex> lock(queue_mutex_);
                queue_signal_.wait(lock, [this] { return !queue_.empty(); });

                evt = std::move(queue_.front());
                queue_.pop_front();
                queued_bytes_ -= evt.data.size();

                if (evt.type == EVENT_OVERFLOW) {
                    overflow_queued_ = false;
                }
            }

            handle(evt);
        }
    }

    void link::handle(event &evt) {
        link_handler *handler = nullptr;
        link_state snapshot;
        bool restarted = false;

        {
            const std::lock_guard<std::mutex> guard(mutex_);

            switch (evt.type) {
            case EVENT_LINK:
                // The same id again is only a change of name. Anything else is
                // another room, or none, and what was known of the old one is void.
                restarted = !(state_.up && (evt.id != 0) && (state_.self == evt.id));
                if (restarted) {
                    state_.peers.clear();
                }

                state_.up = (evt.id != 0);
                state_.self = evt.id;
                state_.name = state_.up ? evt.name : std::string();
                break;

            case EVENT_PEER: {
                if (!state_.up || (evt.id == state_.self)) {
                    return;
                }

                auto existing = std::find(state_.peers.begin(), state_.peers.end(), evt.id);
                if (evt.present) {
                    if (existing != state_.peers.end()) {
                        return;
                    }
                    state_.peers.push_back(evt.id);
                } else {
                    if (existing == state_.peers.end()) {
                        return;
                    }
                    state_.peers.erase(existing);
                }
                break;
            }

            case EVENT_FRAME:
                if (!state_.up || (evt.id == state_.self)) {
                    return;
                }

                frames_in_++;
                break;

            case EVENT_OVERFLOW:
                if (!state_.up) {
                    return;
                }
                break;
            }

            handler = handler_;
            if (!handler) {
                return;
            }

            snapshot = state_;
            in_flight_++;
        }

        switch (evt.type) {
        case EVENT_LINK:
            handler->on_link(snapshot, restarted);
            break;

        case EVENT_PEER:
            handler->on_peer(evt.id, evt.present);
            break;

        case EVENT_FRAME:
            handler->on_frame(evt.id, evt.data.data(), evt.data.size());
            break;

        case EVENT_OVERFLOW:
            handler->on_overflow();
            break;
        }

        {
            const std::lock_guard<std::mutex> guard(mutex_);
            in_flight_--;
        }

        idle_.notify_all();
    }

    bool link::send(const int dst, const std::uint8_t *data, const std::size_t size) {
        const emitter emit = emitter_;
        if (!emit || !data || (size == 0) || (size > MAX_FRAME_SIZE) || (dst < 0) || (dst > 255)) {
            return false;
        }

        {
            const std::lock_guard<std::mutex> guard(mutex_);
            if (!state_.up) {
                return false;
            }
        }

        frames_out_++;
        emit(dst, data, size);

        return true;
    }

    link_state link::attach(link_handler *handler) {
        const std::lock_guard<std::mutex> guard(mutex_);
        handler_ = handler;

        return state_;
    }

    void link::detach(link_handler *handler) {
        std::unique_lock<std::mutex> lock(mutex_);
        if (handler_ == handler) {
            handler_ = nullptr;
        }

        idle_.wait(lock, [this] { return in_flight_ == 0; });
    }

    bool link::with_handler(const std::function<void(link_handler &)> &fn) {
        link_handler *handler = nullptr;

        {
            const std::lock_guard<std::mutex> guard(mutex_);
            handler = handler_;
            if (!handler) {
                return false;
            }

            in_flight_++;
        }

        fn(*handler);

        {
            const std::lock_guard<std::mutex> guard(mutex_);
            in_flight_--;
        }

        idle_.notify_all();
        return true;
    }

    link_state link::state() {
        const std::lock_guard<std::mutex> guard(mutex_);
        return state_;
    }

    bool link::thread_started() {
        const std::lock_guard<std::mutex> guard(queue_mutex_);
        return thread_started_;
    }
}
