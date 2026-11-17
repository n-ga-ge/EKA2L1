// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The page link: the one way Bluetooth traffic leaves and enters a browser
// build. The page owns the real transport (a relay, later perhaps WebRTC) and
// hands the emulator whole frames; this class is the emulator's end of it.
//
// It lives for the whole process, unlike the Bluetooth stack, which is rebuilt
// with every restart of the guest. The page calls post_*() from its main
// thread, where nothing may block: they copy their arguments into a queue. A
// drain thread, started with the first link-up, hands the queue to whatever
// stack is attached. A build that is never linked therefore starts no thread.
#pragma once

#include <atomic>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <string>
#include <vector>

namespace eka2l1::epoc::bt::web {
    struct link_state {
        bool up = false;
        int self = 0; ///< Our id in the room. Zero while the link is down.
        std::string name; ///< Device name the page gave us, UTF-8.
        std::vector<int> peers; ///< Ids of the other room members.
    };

    /**
     * @brief What the link delivers to. Implemented by the Bluetooth stack.
     *
     * Every method is called on the drain thread or the guest timer thread,
     * never on the page's main thread, and never while the link holds a lock.
     */
    /**
     * @brief What can be shown of a name that came from outside.
     *
     * Keeps the well-formed UTF-8 characters that are not control characters,
     * up to `max_size` bytes. A name comes from a page or from another player,
     * and the converters it is later given to throw on malformed input.
     */
    std::string clean_name(const char *data, const std::size_t size, const std::size_t max_size);

    class link_handler {
    public:
        virtual ~link_handler() = default;

        /// The link went up, went down, or changed its name. Peers start empty.
        virtual void on_link(const link_state &state, const bool restarted) = 0;
        virtual void on_peer(const int id, const bool present) = 0;
        virtual void on_frame(const int src, const std::uint8_t *data, const std::size_t size) = 0;
        virtual void on_timer(const std::uint64_t id) = 0;

        /// Frames were thrown away because the queue was full: any of them may be
        /// missing, so nothing known about the other side can be relied on.
        virtual void on_overflow() = 0;
    };

    class link {
    public:
        /// Hands one frame to the page. Installed once by the frontend.
        using emitter = void (*)(int dst, const std::uint8_t *data, std::size_t size);

        static constexpr std::size_t MAX_FRAME_SIZE = 32768;
        static constexpr std::size_t MAX_NAME_SIZE = 64;
        static constexpr std::size_t MAX_QUEUED_BYTES = 8 * 1024 * 1024;

    private:
        enum event_type {
            EVENT_LINK,
            EVENT_PEER,
            EVENT_FRAME,
            EVENT_OVERFLOW
        };

        struct event {
            event_type type;
            int id;
            bool present;
            std::string name;
            std::vector<std::uint8_t> data;
        };

        // Inbound queue. Held for a copy and a push, nothing else.
        std::mutex queue_mutex_;
        std::condition_variable queue_signal_;
        std::deque<event> queue_;
        std::size_t queued_bytes_ = 0;
        bool thread_started_ = false;
        bool overflow_queued_ = false;

        // State and the attached handler.
        std::mutex mutex_;
        std::condition_variable idle_;
        link_state state_;
        link_handler *handler_ = nullptr;
        int in_flight_ = 0;

        std::atomic<emitter> emitter_{ nullptr };
        std::atomic<std::uint64_t> frames_in_{ 0 };
        std::atomic<std::uint64_t> frames_out_{ 0 };
        std::atomic<std::uint64_t> frames_dropped_{ 0 };
        std::atomic<std::uint64_t> timer_counter_{ 0 };

        void push(event &&evt);
        void drain();
        void handle(event &evt);

    public:
        static link &get();

        // From the page's main thread. They copy, queue and return.
        void post_link(const int self_id, const char *name);
        void post_peer(const int id, const bool present);
        void post_frame(const int src, const void *data, const int size);

        void set_emitter(emitter fn) {
            emitter_ = fn;
        }

        /// Send one frame to a peer (0 = every peer). False when it was not sent.
        bool send(const int dst, const std::uint8_t *data, const std::size_t size);

        /// Make `handler` the receiver. Returns the state it starts from.
        link_state attach(link_handler *handler);

        /// Stop delivering to `handler`. Returns once no call into it is running,
        /// so the caller must not hold a lock such a call may be waiting for.
        void detach(link_handler *handler);

        /// Run `fn` with the attached handler, if there is one. detach() waits for it.
        bool with_handler(const std::function<void(link_handler &)> &fn);

        link_state state();

        /// Ids for the handler's timers, unique for the life of the process.
        std::uint64_t new_timer_id() {
            return ++timer_counter_;
        }

        bool thread_started();

        std::uint64_t frames_in() const {
            return frames_in_;
        }

        std::uint64_t frames_out() const {
            return frames_out_;
        }

        std::uint64_t frames_dropped() const {
            return frames_dropped_;
        }
    };
}
