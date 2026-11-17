// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/stack.h>

#include <common/cvt.h>
#include <common/log.h>
#include <common/random.h>
#include <kernel/kernel.h>
#include <kernel/timing.h>
#include <utils/err.h>

#include <algorithm>
#include <cstdio>
#include <cstring>

namespace eka2l1::epoc::bt::web {
    namespace {
        constexpr const char *TIMER_EVENT_NAME = "BluetoothWebLinkTimer";
        constexpr std::size_t ADDRESS_SIZE = 6;

        void put16(std::vector<std::uint8_t> &out, const std::uint16_t value) {
            out.push_back(static_cast<std::uint8_t>(value));
            out.push_back(static_cast<std::uint8_t>(value >> 8));
        }

        void put32(std::vector<std::uint8_t> &out, const std::uint32_t value) {
            put16(out, static_cast<std::uint16_t>(value));
            put16(out, static_cast<std::uint16_t>(value >> 16));
        }

        std::uint16_t get16(const std::uint8_t *data) {
            return static_cast<std::uint16_t>(data[0] | (data[1] << 8));
        }

        std::uint32_t get32(const std::uint8_t *data) {
            return static_cast<std::uint32_t>(get16(data)) | (static_cast<std::uint32_t>(get16(data + 2)) << 16);
        }

        std::vector<std::uint8_t> new_frame(const std::uint8_t type, const std::uint8_t flags, const std::size_t reserve) {
            std::vector<std::uint8_t> frame;
            frame.reserve(FRAME_HEADER_SIZE + reserve);
            frame.push_back(FRAME_MAGIC);
            frame.push_back(FRAME_VERSION);
            frame.push_back(type);
            frame.push_back(flags);

            return frame;
        }

    }

    std::string address_to_string(const device_address &addr) {
        char text[24];
        std::snprintf(text, sizeof(text), "%02x:%02x:%02x:%02x:%02x:%02x", addr.addr_[0], addr.addr_[1], addr.addr_[2],
            addr.addr_[3], addr.addr_[4], addr.addr_[5]);

        return text;
    }

    const char *protocol_name(const std::uint16_t protocol) {
        switch (protocol) {
        case L2CAP_PROTOCOL_ID:
            return "l2cap";

        case RFCOMM_PROTOCOL_ID:
            return "rfcomm";

        case SDP_PROTOCOL_ID:
            return "sdp";

        case BTLINK_MANAGER_PROTOCOL_ID:
            return "link";

        default:
            return "";
        }
    }

    std::size_t channel::readable() const {
        if (rx.empty()) {
            return 0;
        }

        return packets ? (rx.front().size() - rx_offset) : rx_queued;
    }

    stack::guard::guard(stack &stk)
        : kern_(stk.kern_) {
        if (kern_) {
            kern_->lock();
        }

        lock_ = std::unique_lock<std::mutex>(stk.mutex_);
    }

    stack::guard::~guard() {
        lock_.unlock();

        if (kern_) {
            kern_->unlock();
        }
    }

    stack::stack(const device_address &address)
        : address_(address)
        , epoch_(random_range(1, 0x7FFFFFFF))
        , born_(std::chrono::steady_clock::now()) {
    }

    stack::~stack() {
        shutdown();
    }

    void stack::attach(kernel_system *kern) {
        // Set before the link can call in: the handlers read it without the lock.
        kern_ = kern;

        const std::lock_guard<std::mutex> guard(mutex_);
        if (attached_ || dead_) {
            return;
        }

        attached_ = true;
        link_ = link::get().attach(this);
        peers_.clear();

        // The room may be older than this guest: a restart leaves the link up.
        remember_given_name(room_name());

        if (link_.up) {
            for (const int id : link_.peers) {
                add_peer(id);
            }

            send_announce(0);
        }
    }

    void stack::shutdown() {
        // Not under the lock: a handler in flight may be waiting for it.
        link::get().detach(this);

        const std::lock_guard<std::mutex> guard(mutex_);
        if (dead_) {
            return;
        }

        // Pending guest requests are left alone. The sockets that hold them are
        // destroyed with the guest, and complete() refuses from here on. Timers
        // still scheduled find no handler, or one that does not know their id.
        dead_ = true;
        attached_ = false;
        timers_.clear();

        for (auto &chan : channels_) {
            if (chan->state != channel::STATE_CLOSED) {
                chan->state = channel::STATE_CLOSED;
                chan->error = epoc::error_disconnected;
            }
            chan->timer = 0;
        }
    }

    bool stack::can_complete(const epoc::notify_info &info) const {
        return !info.empty() && !dead_ && kern_ && !kern_->wipeout_in_progress() && kern_->is_thread_alive(info.requester);
    }

    void stack::complete(epoc::notify_info &info, const int code) {
        if (can_complete(info)) {
            info.complete(code);
        }

        info = epoc::notify_info();
    }

    void stack::note(const char *op, const std::uint16_t protocol, const std::uint32_t port, const int peer, const int result) {
        diagnostics::event evt;
        evt.ms = static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - born_).count());
        evt.op = op;
        evt.protocol = protocol_name(protocol);
        evt.port = port;
        evt.peer = peer;
        evt.result = result;

        events_.push_back(std::move(evt));
        while (events_.size() > MAX_EVENTS) {
            events_.pop_front();
        }
    }

    void stack::remember_given_name(const std::u16string &name) {
        if (name.empty() || (std::find(given_names_.begin(), given_names_.end(), name) != given_names_.end())) {
            return;
        }

        // A player does not change names often; this only keeps the list finite.
        static constexpr std::size_t MAX_GIVEN_NAMES = 16;
        if (given_names_.size() >= MAX_GIVEN_NAMES) {
            given_names_.erase(given_names_.begin() + 1);
        }

        given_names_.push_back(name);
    }

    void stack::set_device_name(const std::u16string &name) {
        device_name_ = name;
        remember_given_name(name);

        if (link_up()) {
            send_announce(0);
        }
    }

    bool stack::set_name(const std::u16string &name) {
        if (guest_named_ && (guest_name_ == name)) {
            return false;
        }

        guest_named_ = true;
        guest_name_ = name;

        if (link_up()) {
            send_announce(0);
        }

        return true;
    }

    std::u16string stack::room_name() const {
        return (link_.up && !link_.name.empty()) ? name_from_utf8(link_.name) : std::u16string();
    }

    std::u16string stack::local_name() const {
        if (guest_named_) {
            return guest_name_;
        }

        const std::u16string room = room_name();
        return room.empty() ? device_name_ : room;
    }

    std::string stack::announced_name() const {
        std::u16string name = local_name();
        const std::u16string room = room_name();

        if (guest_named_ && !room.empty()) {
            // The longest given name the guest's ends with is the part that
            // names the player. Only an end is looked for: what games add is
            // in front, and a short name would match the start of anything.
            const std::u16string *given = nullptr;

            for (const std::u16string &candidate : given_names_) {
                if ((candidate.size() <= name.size()) && (!given || (candidate.size() > given->size()))
                    && (name.compare(name.size() - candidate.size(), candidate.size(), candidate) == 0)) {
                    given = &candidate;
                }
            }

            if (given) {
                name.replace(name.size() - given->size(), given->size(), room);
            }
        }

        const std::string wire = name_to_utf8(name);
        return clean_name(wire.data(), wire.size(), link::MAX_NAME_SIZE, true);
    }

    peer_info *stack::find_peer(const int id) {
        for (auto &peer : peers_) {
            if (peer.id == id) {
                return &peer;
            }
        }

        return nullptr;
    }

    peer_info &stack::add_peer(const int id) {
        if (peer_info *existing = find_peer(id)) {
            return *existing;
        }

        peer_info peer;
        peer.id = id;
        peers_.push_back(peer);

        // Lowest id first: the device selection takes the first announced one.
        std::sort(peers_.begin(), peers_.end(), [](const peer_info &lhs, const peer_info &rhs) { return lhs.id < rhs.id; });

        return *find_peer(id);
    }

    std::vector<peer_info> stack::announced_peers() const {
        std::vector<peer_info> result;
        if (!link_up()) {
            return result;
        }

        for (const auto &peer : peers_) {
            if (peer.announced) {
                result.push_back(peer);
            }
        }

        return result;
    }

    const peer_info *stack::peer_by_address(const device_address &addr) const {
        if (!link_up()) {
            return nullptr;
        }

        for (const auto &peer : peers_) {
            if (peer.announced && (std::memcmp(peer.address.addr_, addr.addr_, ADDRESS_SIZE) == 0)) {
                return &peer;
            }
        }

        return nullptr;
    }

    std::shared_ptr<channel> stack::find_channel(const int peer, const bool initiator, const std::uint32_t id) {
        for (auto &chan : channels_) {
            if ((chan->peer == peer) && (chan->initiator == initiator) && (chan->id == id)) {
                return chan;
            }
        }

        return nullptr;
    }

    void stack::forget(const channel &chan) {
        channels_.erase(std::remove_if(channels_.begin(), channels_.end(),
                            [&chan](const std::shared_ptr<channel> &candidate) { return candidate.get() == &chan; }),
            channels_.end());
    }

    bool stack::emit(const int dst, const std::vector<std::uint8_t> &frame) {
        if (!link_up()) {
            return false;
        }

        return link::get().send(dst, frame.data(), frame.size());
    }

    void stack::send_announce(const int dst) {
        const std::string name = announced_name();

        std::vector<std::uint8_t> frame = new_frame(FRAME_ANNOUNCE, 0, 12 + name.size());
        put32(frame, epoch_);
        frame.insert(frame.end(), address_.addr_, address_.addr_ + ADDRESS_SIZE);
        frame.push_back(static_cast<std::uint8_t>(name.size()));
        frame.insert(frame.end(), name.begin(), name.end());

        emit(dst, frame);
    }

    void stack::send_control(const int dst, const std::uint8_t type, const std::uint8_t flags, const std::uint32_t conn,
        const std::uint8_t *body, const std::size_t body_size) {
        std::vector<std::uint8_t> frame = new_frame(type, flags, 4 + body_size);
        put32(frame, conn);
        if (body_size) {
            frame.insert(frame.end(), body, body + body_size);
        }

        emit(dst, frame);
    }

    void stack::send_close(const channel &chan, const close_reason reason) {
        const std::uint8_t body = reason;
        send_control(chan.peer, FRAME_CLOSE, chan.initiator ? FRAME_FLAG_FROM_INITIATOR : 0, chan.id, &body, 1);
    }

    void stack::drop(const std::shared_ptr<channel> &chan, const int error, const bool keep_data) {
        if (!chan || (chan->state == channel::STATE_CLOSED)) {
            return;
        }

        const bool was_connecting = (chan->state == channel::STATE_CONNECTING);

        stop_timer(chan->timer);
        chan->state = channel::STATE_CLOSED;
        chan->error = error;
        chan->partial.clear();

        if (!keep_data) {
            chan->rx.clear();
            chan->rx_offset = 0;
            chan->rx_queued = 0;
        }

        if (was_connecting) {
            forget(*chan);

            if (chan->owner) {
                chan->owner->channel_failed(*chan, error);
            }

            return;
        }

        note("close", chan->protocol, chan->port, chan->peer, error);

        if (chan->owner) {
            chan->owner->channel_changed(*chan);
            return;
        }

        // Nobody accepted it yet. A connection that the other side closed
        // properly stays in its listener's queue all the same: the guest
        // accepts it, learns who called, reads what was sent and then the end.
        // Rayman 3 joins a game this way, by connecting and hanging up at once.
        // A connection that broke just goes.
        if (error == epoc::error_eof) {
            return;
        }

        unqueue(chan);
        forget(*chan);
    }

    void stack::unqueue(const std::shared_ptr<channel> &chan) {
        for (auto &lis : listeners_) {
            lis->queue.erase(std::remove(lis->queue.begin(), lis->queue.end(), chan), lis->queue.end());
        }
    }

    void stack::drop_peer(const int id) {
        const std::vector<std::shared_ptr<channel>> all = channels_;
        for (const auto &chan : all) {
            if (chan->peer == id) {
                drop(chan, epoc::error_disconnected, true);
            }
        }
    }

    void stack::drop_everything() {
        const std::vector<std::shared_ptr<channel>> all = channels_;
        for (const auto &chan : all) {
            drop(chan, epoc::error_disconnected, true);
        }

        peers_.clear();
    }

    std::shared_ptr<listener> stack::listen(const std::uint16_t protocol, const std::uint16_t port,
        const std::uint32_t backlog, listener_owner *owner, int &error) {
        for (const auto &existing : listeners_) {
            if ((existing->protocol == protocol) && (existing->port == port)) {
                error = epoc::error_in_use;
                note("listen", protocol, port, 0, error);

                return nullptr;
            }
        }

        auto lis = std::make_shared<listener>();
        lis->protocol = protocol;
        lis->port = port;
        lis->backlog = backlog;
        lis->owner = owner;

        listeners_.push_back(lis);

        error = epoc::error_none;
        note("listen", protocol, port, 0, error);

        return lis;
    }

    void stack::unlisten(const std::shared_ptr<listener> &lis) {
        if (!lis) {
            return;
        }

        lis->owner = nullptr;

        for (auto &chan : lis->queue) {
            if (chan->state == channel::STATE_OPEN) {
                send_close(*chan, CLOSE_RESET);
            }

            chan->state = channel::STATE_CLOSED;
            chan->error = epoc::error_disconnected;
            forget(*chan);
        }

        lis->queue.clear();
        listeners_.erase(std::remove(listeners_.begin(), listeners_.end(), lis), listeners_.end());

        note("unlisten", lis->protocol, lis->port, 0, epoc::error_none);
    }

    std::shared_ptr<channel> stack::connect(const device_address &addr, const std::uint16_t protocol,
        const std::uint16_t port, channel_owner *owner, int &error) {
        totals_.connects_out++;

        const peer_info *peer = peer_by_address(addr);
        if (!peer) {
            // The link is down, or nobody in the room has that address.
            error = epoc::error_could_not_connect;
            return nullptr;
        }

        auto chan = std::make_shared<channel>();
        chan->peer = peer->id;
        chan->initiator = true;
        chan->id = ++conn_counter_;
        chan->protocol = protocol;
        chan->port = port;
        chan->packets = (protocol == L2CAP_PROTOCOL_ID);
        chan->state = channel::STATE_CONNECTING;
        chan->remote = addr;
        chan->owner = owner;

        std::vector<std::uint8_t> body;
        put16(body, protocol);
        put16(body, port);
        body.insert(body.end(), addr.addr_, addr.addr_ + ADDRESS_SIZE);
        put32(body, 0);

        std::vector<std::uint8_t> frame = new_frame(FRAME_CONNECT, 0, 4 + body.size());
        put32(frame, chan->id);
        frame.insert(frame.end(), body.begin(), body.end());

        if (!emit(chan->peer, frame)) {
            error = epoc::error_could_not_connect;
            return nullptr;
        }

        channels_.push_back(chan);

        const std::weak_ptr<channel> weak = chan;
        chan->timer = start_timer(CONNECT_TIMEOUT_US, [this, weak]() {
            const std::shared_ptr<channel> waiting = weak.lock();
            if (waiting && (waiting->state == channel::STATE_CONNECTING)) {
                waiting->timer = 0;
                send_close(*waiting, CLOSE_RESET);
                drop(waiting, epoc::error_timed_out, false);
            }
        });

        error = epoc::error_none;
        return chan;
    }

    int stack::send(channel &chan, const std::uint8_t *data, const std::size_t size) {
        if (chan.state == channel::STATE_CONNECTING) {
            return epoc::error_not_ready;
        }

        if (chan.state != channel::STATE_OPEN) {
            return epoc::error_disconnected;
        }

        std::size_t done = 0;
        while (done < size) {
            const std::size_t piece = std::min(size - done, MAX_DATA_PAYLOAD);
            const bool more = chan.packets && (done + piece < size);

            std::vector<std::uint8_t> frame = new_frame(FRAME_DATA,
                static_cast<std::uint8_t>((chan.initiator ? FRAME_FLAG_FROM_INITIATOR : 0) | (more ? FRAME_FLAG_MORE : 0)),
                6 + piece);
            put32(frame, chan.id);
            put16(frame, chan.tx_seq);
            frame.insert(frame.end(), data + done, data + done + piece);

            if (!emit(chan.peer, frame)) {
                return epoc::error_disconnected;
            }

            chan.tx_seq++;
            chan.tx_bytes += piece;
            done += piece;
        }

        return epoc::error_none;
    }

    std::size_t stack::read(channel &chan, std::uint8_t *dest, const std::size_t size, std::size_t *remainder) {
        std::size_t done = 0;

        if (remainder) {
            *remainder = 0;
        }

        while ((done < size) && !chan.rx.empty()) {
            std::vector<std::uint8_t> &front = chan.rx.front();
            const std::size_t available = front.size() - chan.rx_offset;
            const std::size_t piece = std::min(size - done, available);

            std::memcpy(dest + done, front.data() + chan.rx_offset, piece);
            done += piece;
            chan.rx_queued -= piece;

            if (piece == available) {
                chan.rx.pop_front();
                chan.rx_offset = 0;
            } else {
                chan.rx_offset += piece;
            }

            if (chan.packets) {
                // One read never crosses into the next packet. What did not fit
                // stays at the head of the queue for the next read.
                if (remainder) {
                    *remainder = available - piece;
                }
                break;
            }
        }

        return done;
    }

    void stack::skip_packet(channel &chan) {
        if (!chan.packets || (chan.rx_offset == 0) || chan.rx.empty()) {
            return;
        }

        chan.rx_queued -= chan.rx.front().size() - chan.rx_offset;
        chan.rx.pop_front();
        chan.rx_offset = 0;
    }

    void stack::release(const std::shared_ptr<channel> &chan, const close_reason reason) {
        if (!chan) {
            return;
        }

        chan->owner = nullptr;
        stop_timer(chan->timer);

        if (chan->state != channel::STATE_CLOSED) {
            send_close(*chan, (chan->state == channel::STATE_CONNECTING) ? CLOSE_RESET : reason);

            if (chan->state == channel::STATE_OPEN) {
                note("close", chan->protocol, chan->port, chan->peer, epoc::error_none);
            }

            chan->state = channel::STATE_CLOSED;
            chan->error = epoc::error_disconnected;
        }

        forget(*chan);
    }

    std::uint64_t stack::start_timer(const std::int64_t microseconds, std::function<void()> fire) {
        if (!kern_ || dead_) {
            return 0;
        }

        ntimer *timing = kern_->get_ntimer();
        if (!timing) {
            return 0;
        }

        if (timer_event_ < 0) {
            timer_event_ = timing->get_register_event(TIMER_EVENT_NAME);
        }

        if (timer_event_ < 0) {
            // The event outlives this stack, so it finds the current one by itself.
            timer_event_ = timing->register_event(TIMER_EVENT_NAME, [](std::uint64_t userdata, int) {
                link::get().with_handler([userdata](link_handler &handler) { handler.on_timer(userdata); });
            });
        }

        const std::uint64_t id = link::get().new_timer_id();
        timers_.push_back({ id, std::move(fire) });
        timing->schedule_event(microseconds, timer_event_, id);

        return id;
    }

    void stack::stop_timer(std::uint64_t &id) {
        if (!id) {
            return;
        }

        const std::uint64_t stopped = id;
        id = 0;

        const auto found = std::find_if(timers_.begin(), timers_.end(), [stopped](const timer &t) { return t.id == stopped; });
        if (found == timers_.end()) {
            return;
        }

        timers_.erase(found);

        if (kern_ && !dead_ && !kern_->wipeout_in_progress() && (timer_event_ >= 0)) {
            kern_->get_ntimer()->unschedule_event(timer_event_, stopped);
        }
    }

    void stack::on_timer(const std::uint64_t id) {
        const guard locked(*this);
        if (dead_) {
            return;
        }

        const auto found = std::find_if(timers_.begin(), timers_.end(), [id](const timer &t) { return t.id == id; });
        if (found == timers_.end()) {
            return;
        }

        std::function<void()> fire = std::move(found->fire);
        timers_.erase(found);

        fire();
    }

    void stack::on_overflow() {
        const guard locked(*this);
        if (dead_ || !link_.up) {
            return;
        }

        // Some frame did not reach us, and it need not have been data: a
        // CLOSE, an ACCEPT, an ANNOUNCE. Rather than guess, start over towards
        // everybody, the way a restarted guest does: our connections close,
        // and the new epoch makes the others close theirs and say who they are.
        LOG_WARN(SERVICE_BLUETOOTH, "The Bluetooth link fell too far behind and lost frames; resetting every connection");

        const std::vector<std::shared_ptr<channel>> all = channels_;
        for (const auto &chan : all) {
            drop(chan, epoc::error_disconnected, false);
        }

        for (auto &peer : peers_) {
            peer.announced = false;
        }

        epoch_ = (epoch_ % 0x7FFFFFFE) + 1;
        note("overflow", 0, 0, 0, epoc::error_disconnected);
        send_announce(0);
    }

    void stack::on_link(const link_state &state, const bool restarted) {
        const guard locked(*this);
        if (dead_) {
            return;
        }

        if (restarted) {
            // Another room, or none: whatever was connected is not any more.
            link_.up = false;
            drop_everything();
        }

        link_ = state;
        if (restarted) {
            link_.peers.clear();
            note(state.up ? "link-up" : "link-down", 0, 0, state.self, epoc::error_none);

            // Whatever we had with the others went with the old link, and so
            // did what we knew of them. A new epoch says so: members that knew
            // us close their ends and answer, which is how we learn them again.
            // (A guest that restarted in between has a new epoch anyway.)
            if (state.up) {
                epoch_ = (epoch_ % 0x7FFFFFFE) + 1;
            }
        }

        remember_given_name(room_name());

        if (link_.up) {
            send_announce(0);
        }
    }

    void stack::on_peer(const int id, const bool present) {
        const guard locked(*this);
        if (dead_ || !link_.up) {
            return;
        }

        auto listed = std::find(link_.peers.begin(), link_.peers.end(), id);

        if (present) {
            if (listed == link_.peers.end()) {
                link_.peers.push_back(id);
            }

            add_peer(id);
            send_announce(id);

            note("peer-join", 0, 0, id, epoc::error_none);
        } else {
            if (listed != link_.peers.end()) {
                link_.peers.erase(listed);
            }

            drop_peer(id);
            peers_.erase(std::remove_if(peers_.begin(), peers_.end(), [id](const peer_info &peer) { return peer.id == id; }),
                peers_.end());

            note("peer-leave", 0, 0, id, epoc::error_none);
        }
    }

    void stack::on_frame(const int src, const std::uint8_t *data, const std::size_t size) {
        const guard locked(*this);
        if (dead_ || !link_.up) {
            return;
        }

        if ((size < FRAME_HEADER_SIZE) || (data[0] != FRAME_MAGIC) || (data[1] != FRAME_VERSION)) {
            totals_.bad_frames++;
            return;
        }

        const std::uint8_t type = data[2];
        const std::uint8_t flags = data[3];
        const std::uint8_t *body = data + FRAME_HEADER_SIZE;
        const std::size_t body_size = size - FRAME_HEADER_SIZE;

        if (!find_peer(src) && (type != FRAME_ANNOUNCE)) {
            // From someone the page says is not in the room (any more).
            return;
        }

        switch (type) {
        case FRAME_ANNOUNCE:
            handle_announce(src, body, body_size);
            break;

        case FRAME_CONNECT:
            handle_connect(src, body, body_size);
            break;

        case FRAME_ACCEPT:
            handle_accept(src, body, body_size);
            break;

        case FRAME_REFUSE:
            handle_refuse(src, body, body_size);
            break;

        case FRAME_DATA:
            handle_data(src, flags, body, body_size);
            break;

        case FRAME_CLOSE:
            handle_close(src, flags, body, body_size);
            break;

        case FRAME_CREDIT:
            break;

        default:
            totals_.bad_frames++;
            break;
        }
    }

    void stack::handle_announce(const int src, const std::uint8_t *body, const std::size_t size) {
        if ((size < 11) || (body[10] > link::MAX_NAME_SIZE) || (size < 11u + body[10])) {
            totals_.bad_frames++;
            return;
        }

        const std::uint32_t epoch = get32(body);

        if (std::find(link_.peers.begin(), link_.peers.end(), src) == link_.peers.end()) {
            link_.peers.push_back(src);
        }

        peer_info &peer = add_peer(src);

        // A new epoch is a guest that started over: it knows none of our
        // connections, nor our address.
        const bool started_over = peer.announced && (peer.epoch != epoch);
        if (started_over) {
            drop_peer(src);
        }

        const bool first = !peer.announced;

        peer.announced = true;
        peer.epoch = epoch;
        std::memcpy(peer.address.addr_, body + 4, ADDRESS_SIZE);
        peer.address.padding_ = 0;
        // As the other guest named its device: see clean_name() for why its
        // control characters stay.
        peer.name = clean_name(reinterpret_cast<const char *>(body + 11), body[10], link::MAX_NAME_SIZE, true);

        // News to us means that we may be news to the sender: its guest may
        // have started after ours announced, with nobody there to hear it. The
        // answer is not news to the sender a second time, so this ends.
        if (first || started_over) {
            note("peer-announce", 0, 0, src, epoc::error_none);
            send_announce(src);
        }
    }

    void stack::handle_connect(const int src, const std::uint8_t *body, const std::size_t size) {
        if (size < 18) {
            totals_.bad_frames++;
            return;
        }

        const std::uint32_t conn = get32(body);
        const std::uint16_t protocol = get16(body + 4);
        const std::uint16_t port = get16(body + 6);

        const auto refuse = [&](const refuse_reason reason) {
            const std::uint8_t why = reason;
            send_control(src, FRAME_REFUSE, 0, conn, &why, 1);

            totals_.refused++;
            note("incoming", protocol, port, src, epoc::error_could_not_connect);
        };

        const peer_info *peer = find_peer(src);
        if (!peer || !peer->announced || (std::memcmp(body + 8, address_.addr_, ADDRESS_SIZE) != 0)) {
            refuse(REFUSE_WRONG_ADDRESS);
            return;
        }

        if (const std::shared_ptr<channel> stale = find_channel(src, false, conn)) {
            // The number was used before: by a guest that has since started
            // over, whose connection a socket here still holds closed, or by a
            // sender that lost count. Either way the old one is over, and must
            // not be found under this name again.
            drop(stale, epoc::error_disconnected, false);
            unqueue(stale);
            forget(*stale);
        }

        std::shared_ptr<listener> lis;
        for (const auto &candidate : listeners_) {
            if ((candidate->protocol == protocol) && (candidate->port == port)) {
                lis = candidate;
                break;
            }
        }

        if (!lis) {
            refuse(REFUSE_NO_LISTENER);
            return;
        }

        const std::uint32_t room = std::min<std::uint32_t>(std::max<std::uint32_t>(lis->backlog, 1), MAX_QUEUED_CONNECTIONS);
        if (lis->queue.size() >= room) {
            refuse(REFUSE_BUSY);
            return;
        }

        auto chan = std::make_shared<channel>();
        chan->peer = src;
        chan->initiator = false;
        chan->id = conn;
        chan->protocol = protocol;
        chan->port = port;
        chan->packets = (protocol == L2CAP_PROTOCOL_ID);
        chan->state = channel::STATE_OPEN;
        chan->remote = peer->address;

        channels_.push_back(chan);
        lis->queue.push_back(chan);

        std::vector<std::uint8_t> window;
        put32(window, 0);
        send_control(src, FRAME_ACCEPT, 0, conn, window.data(), window.size());

        totals_.connects_in++;
        note("incoming", protocol, port, src, epoc::error_none);

        if (lis->owner) {
            lis->owner->listener_ready(*lis);
        }
    }

    void stack::handle_accept(const int src, const std::uint8_t *body, const std::size_t size) {
        if (size < 8) {
            totals_.bad_frames++;
            return;
        }

        const std::uint32_t conn = get32(body);
        const std::shared_ptr<channel> chan = find_channel(src, true, conn);

        if (!chan) {
            // We gave up on it (timeout, cancel). Tell the other side so that it
            // does not keep a connection nobody holds.
            const std::uint8_t why = CLOSE_UNKNOWN;
            send_control(src, FRAME_CLOSE, FRAME_FLAG_FROM_INITIATOR, conn, &why, 1);
            return;
        }

        if (chan->state != channel::STATE_CONNECTING) {
            return;
        }

        stop_timer(chan->timer);
        chan->state = channel::STATE_OPEN;

        if (chan->owner) {
            chan->owner->channel_opened(*chan);
        }
    }

    void stack::handle_refuse(const int src, const std::uint8_t *body, const std::size_t size) {
        if (size < 5) {
            totals_.bad_frames++;
            return;
        }

        const std::shared_ptr<channel> chan = find_channel(src, true, get32(body));
        if (!chan || (chan->state != channel::STATE_CONNECTING)) {
            return;
        }

        totals_.refused++;
        drop(chan, epoc::error_could_not_connect, false);
    }

    void stack::handle_data(const int src, const std::uint8_t flags, const std::uint8_t *body, const std::size_t size) {
        if (size < 6) {
            totals_.bad_frames++;
            return;
        }

        const std::uint32_t conn = get32(body);
        const std::uint16_t seq = get16(body + 4);
        const std::uint8_t *payload = body + 6;
        const std::size_t payload_size = size - 6;

        // The sender's flag says which side it is; ours is the other one.
        const bool we_initiated = !(flags & FRAME_FLAG_FROM_INITIATOR);
        const std::shared_ptr<channel> chan = find_channel(src, we_initiated, conn);

        if (!chan) {
            const std::uint8_t why = CLOSE_UNKNOWN;
            send_control(src, FRAME_CLOSE, we_initiated ? FRAME_FLAG_FROM_INITIATOR : 0, conn, &why, 1);
            return;
        }

        if (chan->state != channel::STATE_OPEN) {
            // Closed on our side already; the peer will hear of it.
            return;
        }

        if (payload_size > MAX_DATA_PAYLOAD) {
            totals_.bad_frames++;
            send_close(*chan, CLOSE_SEQUENCE);
            drop(chan, epoc::error_disconnected, false);
            return;
        }

        if (seq != chan->rx_seq) {
            // A frame went missing. Better a clean reset than a stream with a hole.
            totals_.seq_errors++;
            send_close(*chan, CLOSE_SEQUENCE);
            drop(chan, epoc::error_disconnected, false);
            return;
        }

        chan->rx_seq++;
        chan->rx_bytes += payload_size;

        if (chan->packets) {
            chan->partial.insert(chan->partial.end(), payload, payload + payload_size);

            if (!(flags & FRAME_FLAG_MORE)) {
                if (!chan->partial.empty()) {
                    chan->rx_queued += chan->partial.size();
                    chan->rx.push_back(std::move(chan->partial));
                }
                chan->partial.clear();
            }
        } else if (payload_size) {
            chan->rx_queued += payload_size;
            chan->rx.emplace_back(payload, payload + payload_size);
        }

        if (chan->rx_queued + chan->partial.size() > chan->rx_limit) {
            LOG_WARN(SERVICE_BLUETOOTH, "Bluetooth connection {} from peer {} is not being read; resetting it", conn, src);
            send_close(*chan, CLOSE_OVERFLOW);
            drop(chan, epoc::error_disconnected, false);
            return;
        }

        if (chan->owner) {
            chan->owner->channel_changed(*chan);
        }
    }

    void stack::handle_close(const int src, const std::uint8_t flags, const std::uint8_t *body, const std::size_t size) {
        if (size < 5) {
            totals_.bad_frames++;
            return;
        }

        const bool we_initiated = !(flags & FRAME_FLAG_FROM_INITIATOR);
        const std::shared_ptr<channel> chan = find_channel(src, we_initiated, get32(body));
        if (!chan) {
            return;
        }

        const std::uint8_t reason = body[4];

        if (chan->state == channel::STATE_CONNECTING) {
            drop(chan, epoc::error_could_not_connect, false);
        } else {
            drop(chan, (reason == CLOSE_NORMAL) ? epoc::error_eof : epoc::error_disconnected,
                (reason == CLOSE_NORMAL) || (reason == CLOSE_RESET));
        }
    }

    void stack::diagnose(diagnostics &out) {
        const std::lock_guard<std::mutex> guard(mutex_);

        out.attached = attached_ && !dead_;
        out.address = address_to_string(address_);
        out.name = announced_name();
        out.totals = totals_;

        for (const auto &peer : peers_) {
            out.peers.push_back({ peer.id, peer.announced, peer.announced ? address_to_string(peer.address) : std::string(),
                peer.name });
        }

        for (const auto &lis : listeners_) {
            out.listeners.push_back({ protocol_name(lis->protocol), lis->port, static_cast<std::uint32_t>(lis->queue.size()),
                lis->accepting });
        }

        for (const auto &chan : channels_) {
            const char *state = "closed";
            if (chan->state == channel::STATE_CONNECTING) {
                state = "connecting";
            } else if (chan->state == channel::STATE_OPEN) {
                state = chan->owner ? "open" : "queued";
            }

            out.connections.push_back({ chan->peer, chan->id, chan->initiator, protocol_name(chan->protocol), chan->port,
                state, chan->tx_bytes, chan->rx_bytes, chan->rx_queued });
        }

        out.events.assign(events_.begin(), events_.end());
    }
}
