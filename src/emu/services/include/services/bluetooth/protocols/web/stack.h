// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bluetooth between browser players. Each emulator runs one of these on top
// of the page link (link.h); they talk to each other in the frames below, and
// the page and its relay carry those frames without looking inside.
//
// One relay frame is one message, little-endian:
//
//   byte 0  magic 0xB7      byte 2  type
//   byte 1  version 1       byte 3  flags
//
//   1 ANNOUNCE  u32 epoch, u8 addr[6], u8 nameLen, name (UTF-8, at most 64 bytes)
//   2 CONNECT   u32 conn, u16 proto (0x0100 L2CAP, 0x0003 RFCOMM), u16 port,
//               u8 dstAddr[6], u32 window (0)
//   3 ACCEPT    u32 conn, u32 window (0)
//   4 REFUSE    u32 conn, u8 reason
//   5 DATA      u32 conn, u16 seq, payload (at most 16 KiB)
//               flags: bit0 FROM_INITIATOR, bit1 MORE (the packet continues)
//   6 CLOSE     u32 conn, u8 reason       flags: bit0 FROM_INITIATOR
//   7 CREDIT    reserved
//
// ANNOUNCE says who an emulator is. It is broadcast when the link comes up and
// when a guest starts, sent to each member that joins, and answered whenever
// it is news to the receiver: the first from that member, or one with another
// epoch. An epoch is one run of a guest; a new one means that the sender knows
// nothing of earlier connections, so the receiver closes its ends of them.
//
// A connection is named by (peer, which side opened it, conn). The relay is
// ordered and reliable, so there is no windowing: a connection whose guest
// leaves more than RX_LIMIT unread is reset, and so is one whose `seq` skips.
//
// Locking. Guest calls arrive on the Symbian OS thread with the kernel lock
// held and then take lock(). The link's drain thread and the guest timer
// thread take the kernel lock first and lock() second (see `guard`), which is
// also what completing a guest request requires. Destructors may run during a
// kernel wipeout with no kernel lock at all: they take lock() only, and
// complete() refuses to touch a request then.
#pragma once

#include <services/bluetooth/protocols/common.h>
#include <services/bluetooth/protocols/web/link.h>
#include <utils/reqsts.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace eka2l1 {
    class kernel_system;
}

namespace eka2l1::epoc::bt::web {
    enum : std::uint8_t {
        FRAME_MAGIC = 0xB7,
        FRAME_VERSION = 1,
        FRAME_HEADER_SIZE = 4,

        FRAME_ANNOUNCE = 1,
        FRAME_CONNECT = 2,
        FRAME_ACCEPT = 3,
        FRAME_REFUSE = 4,
        FRAME_DATA = 5,
        FRAME_CLOSE = 6,
        FRAME_CREDIT = 7,

        FRAME_FLAG_FROM_INITIATOR = 1 << 0,
        FRAME_FLAG_MORE = 1 << 1
    };

    enum refuse_reason : std::uint8_t {
        REFUSE_NO_LISTENER = 1,
        REFUSE_WRONG_ADDRESS = 2,
        REFUSE_BUSY = 3
    };

    enum close_reason : std::uint8_t {
        CLOSE_NORMAL = 0, ///< The other side shut the socket down or closed it.
        CLOSE_RESET = 1, ///< Given up: a cancelled or timed-out connect, a listener that went away.
        CLOSE_OVERFLOW = 2,
        CLOSE_SEQUENCE = 3,
        CLOSE_UNKNOWN = 4 ///< Answer to a frame for a connection the receiver does not have.
    };

    static constexpr std::size_t MAX_DATA_PAYLOAD = 16 * 1024;
    static constexpr std::size_t RX_LIMIT = 512 * 1024;
    static constexpr std::uint32_t MAX_QUEUED_CONNECTIONS = 8;
    static constexpr std::int64_t CONNECT_TIMEOUT_US = 20 * 1000 * 1000;
    static constexpr std::size_t MAX_EVENTS = 32;

    struct channel;
    struct listener;

    /// Whoever uses a channel: a guest socket, or the SDP client. Called with the locks held.
    class channel_owner {
    public:
        virtual ~channel_owner() = default;

        virtual void channel_opened(channel &chan) = 0;
        /// A connect did not get through. The channel is already gone from the stack.
        virtual void channel_failed(channel &chan, const int error) = 0;
        /// Data arrived, or the channel closed.
        virtual void channel_changed(channel &chan) = 0;
    };

    class listener_owner {
    public:
        virtual ~listener_owner() = default;

        /// A connection waits in the listener's queue. Called with the locks held.
        virtual void listener_ready(listener &lis) = 0;
    };

    struct channel {
        enum state_type {
            STATE_CONNECTING,
            STATE_OPEN,
            STATE_CLOSED
        };

        int peer = 0;
        bool initiator = false;
        std::uint32_t id = 0;

        std::uint16_t protocol = 0;
        std::uint16_t port = 0;
        bool packets = false; ///< L2CAP keeps packet boundaries; RFCOMM is a byte stream.

        state_type state = STATE_CONNECTING;
        int error = 0; ///< Why it closed: what a read past the queued data returns.
        device_address remote{};
        channel_owner *owner = nullptr;

        // Received and not yet read: whole packets, or chunks of the stream.
        std::deque<std::vector<std::uint8_t>> rx;
        std::size_t rx_offset = 0; ///< Bytes of rx.front() already read.
        std::size_t rx_queued = 0;
        std::size_t rx_limit = RX_LIMIT;
        std::vector<std::uint8_t> partial; ///< A packet whose last frame has not arrived.

        std::uint16_t tx_seq = 0;
        std::uint16_t rx_seq = 0;
        std::uint64_t tx_bytes = 0;
        std::uint64_t rx_bytes = 0;
        std::uint64_t timer = 0;

        /// Bytes that one read can return now: the next packet, or all of the stream.
        std::size_t readable() const;
    };

    struct listener {
        std::uint16_t protocol = 0;
        std::uint16_t port = 0;
        std::uint32_t backlog = 1;
        bool accepting = false; ///< The guest has an accept pending. For the diagnostics.
        listener_owner *owner = nullptr;

        std::deque<std::shared_ptr<channel>> queue;
    };

    struct peer_info {
        int id = 0;
        bool announced = false; ///< We have its address and name.
        std::uint32_t epoch = 0;
        device_address address{};
        std::string name;
    };

    struct diagnostics {
        struct peer {
            int id;
            bool announced;
            std::string address;
            std::string name;
        };

        struct listener_entry {
            std::string protocol;
            std::uint32_t port;
            std::uint32_t queued;
            bool accepting;
        };

        struct connection {
            int peer;
            std::uint32_t id;
            bool initiator;
            std::string protocol;
            std::uint32_t port;
            std::string state;
            std::uint64_t tx_bytes;
            std::uint64_t rx_bytes;
            std::uint64_t rx_queued;
        };

        struct event {
            std::uint64_t ms;
            std::string op;
            std::string protocol;
            std::uint32_t port;
            int peer;
            int result;
        };

        struct counters {
            std::uint64_t frames_in = 0;
            std::uint64_t frames_out = 0;
            std::uint64_t bad_frames = 0;
            std::uint64_t seq_errors = 0;
            std::uint64_t connects_in = 0;
            std::uint64_t connects_out = 0;
            std::uint64_t refused = 0;
            std::uint64_t inquiries = 0;
            std::uint64_t selections = 0;
            std::uint64_t sdp_queries = 0;
        };

        std::uint64_t frames_dropped = 0; ///< Frames the link threw away for want of room.

        bool attached = false; ///< A guest is running and has a Bluetooth stack.
        bool thread = false; ///< The link's drain thread exists.
        link_state link;
        std::string address;
        std::string name; ///< The device's Bluetooth name, as the others are told it.

        std::vector<peer> peers;
        std::vector<listener_entry> listeners;
        std::vector<connection> connections;
        std::vector<event> events;
        counters totals;
    };

    std::string address_to_string(const device_address &addr);
    const char *protocol_name(const std::uint16_t protocol);

    class stack : public link_handler {
    private:
        struct timer {
            std::uint64_t id;
            std::function<void()> fire;
        };

        std::mutex mutex_;
        kernel_system *kern_ = nullptr;
        bool attached_ = false;
        bool dead_ = false;

        device_address address_{};
        std::u16string name_; ///< The device's Bluetooth name: what the guest reads and the others are told.
        std::string link_name_taken_; ///< The room name that last became the device's name.
        std::uint32_t epoch_ = 0;
        std::uint32_t conn_counter_ = 0;

        link_state link_;
        std::vector<peer_info> peers_;
        std::vector<std::shared_ptr<channel>> channels_;
        std::vector<std::shared_ptr<listener>> listeners_;
        std::vector<timer> timers_;
        int timer_event_ = -1;

        std::deque<diagnostics::event> events_;
        diagnostics::counters totals_;
        std::chrono::steady_clock::time_point born_;

        peer_info *find_peer(const int id);
        peer_info &add_peer(const int id);
        std::shared_ptr<channel> find_channel(const int peer, const bool initiator, const std::uint32_t id);
        void forget(const channel &chan);
        void unqueue(const std::shared_ptr<channel> &chan);

        std::string announced_name() const;
        void take_link_name();
        void send_announce(const int dst);
        void send_control(const int dst, const std::uint8_t type, const std::uint8_t flags, const std::uint32_t conn,
            const std::uint8_t *body, const std::size_t body_size);
        void send_close(const channel &chan, const close_reason reason);
        bool emit(const int dst, const std::vector<std::uint8_t> &frame);

        /// Close a channel from our side of things and tell whoever holds it.
        void drop(const std::shared_ptr<channel> &chan, const int error, const bool keep_data);
        void drop_peer(const int id);
        void drop_everything();

        void handle_announce(const int src, const std::uint8_t *body, const std::size_t size);
        void handle_connect(const int src, const std::uint8_t *body, const std::size_t size);
        void handle_accept(const int src, const std::uint8_t *body, const std::size_t size);
        void handle_refuse(const int src, const std::uint8_t *body, const std::size_t size);
        void handle_data(const int src, const std::uint8_t flags, const std::uint8_t *body, const std::size_t size);
        void handle_close(const int src, const std::uint8_t flags, const std::uint8_t *body, const std::size_t size);

    public:
        /// The kernel lock, then the stack's. For every thread but the guest's own.
        struct guard {
            kernel_system *kern_;
            std::unique_lock<std::mutex> lock_;

            explicit guard(stack &stk);
            ~guard();
        };

        explicit stack(const device_address &address);
        ~stack() override;

        /// Start taking traffic. `kern` is the kernel whose lock guards guest requests.
        void attach(kernel_system *kern);

        /// Stop for good: nothing is delivered or completed after this returns. The
        /// object itself stays valid for the sockets that still point at it.
        void shutdown();

        std::mutex &lock() {
            return mutex_;
        }

        // Everything from here to diagnose() is called with lock() held.

        /// Complete a guest request, unless the guest is being torn down or the
        /// requesting thread is gone. Always leaves `info` empty.
        void complete(epoc::notify_info &info, const int code);
        bool can_complete(const epoc::notify_info &info) const;

        void note(const char *op, const std::uint16_t protocol, const std::uint32_t port, const int peer, const int result);

        diagnostics::counters &totals() {
            return totals_;
        }

        const device_address &address() const {
            return address_;
        }

        bool link_up() const {
            return link_.up && !dead_;
        }

        /// False once shutdown() ran, which is when the midman went away.
        bool alive() const {
            return !dead_;
        }

        /// The device's Bluetooth name. A phone has one: the guest reads it,
        /// the guest may change it, and a search by another phone shows it.
        /// The name the player has in the room becomes it when the player
        /// enters the room; a name the guest sets after that replaces it,
        /// because games put things in it that the other side looks for
        /// (Call of Duty hosts under its UID followed by the old name, and
        /// joins only a device named so). Returns whether the name changed.
        bool set_name(const std::u16string &name);
        std::u16string local_name() const;

        std::vector<peer_info> announced_peers() const;
        const peer_info *peer_by_address(const device_address &addr) const;

        std::shared_ptr<listener> listen(const std::uint16_t protocol, const std::uint16_t port,
            const std::uint32_t backlog, listener_owner *owner, int &error);
        void unlisten(const std::shared_ptr<listener> &lis);

        std::shared_ptr<channel> connect(const device_address &addr, const std::uint16_t protocol,
            const std::uint16_t port, channel_owner *owner, int &error);

        /// Send as one packet (L2CAP) or as part of the stream. Returns an error code.
        int send(channel &chan, const std::uint8_t *data, const std::size_t size);

        /// Take up to `size` bytes off the channel. For a packet channel, at most the
        /// rest of the current packet; `remainder` is what is then left of it.
        std::size_t read(channel &chan, std::uint8_t *dest, const std::size_t size, std::size_t *remainder = nullptr);

        /// Throw away what is left of the packet a read has started on.
        void skip_packet(channel &chan);

        /// The holder is finished with the channel. Tells the peer if it was open.
        void release(const std::shared_ptr<channel> &chan, const close_reason reason);

        std::uint64_t start_timer(const std::int64_t microseconds, std::function<void()> fire);
        void stop_timer(std::uint64_t &id);

        /// Takes lock() itself.
        void diagnose(diagnostics &out);

        void on_link(const link_state &state, const bool restarted) override;
        void on_peer(const int id, const bool present) override;
        void on_frame(const int src, const std::uint8_t *data, const std::size_t size) override;
        void on_timer(const std::uint64_t id) override;
        void on_overflow() override;
    };
}
