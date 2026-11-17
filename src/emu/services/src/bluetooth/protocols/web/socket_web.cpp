// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/midman_web.h>
#include <services/bluetooth/protocols/web/resolver_web.h>
#include <services/bluetooth/protocols/web/sdp_web.h>
#include <services/bluetooth/protocols/web/socket_web.h>

#include <common/log.h>
#include <utils/err.h>

#include <algorithm>
#include <cstring>

namespace eka2l1::epoc::bt::web {
    namespace {
        // RSocket::Shutdown's argument (RSocket::TShutdown).
        enum {
            SHUTDOWN_NORMAL = 0,
            SHUTDOWN_STOP_INPUT = 1,
            SHUTDOWN_STOP_OUTPUT = 2,
            SHUTDOWN_IMMEDIATE = 3
        };

        // What KIOctlSelect and KSOSelectPoll report (KSockSelectRead, Write, Except).
        enum {
            SELECT_READ = 1,
            SELECT_WRITE = 2,
            SELECT_EXCEPT = 4
        };

        constexpr std::uint32_t K_UNDEFINED_PROTOCOL_OPTION_LEVEL = 0xFFFFFFFE;

        // KSockReadContinuation: read a datagram like a stream, without
        // discarding what does not fit the buffer.
        constexpr std::uint32_t SOCKET_FLAG_READ_CONTINUATION = 0x01000000;

        /**
         * @brief The link-manager control socket: ioctls and options, no data.
         *
         * Upstream uses a btinet_socket without an inner socket for this and
         * relies on the guest never asking it for anything else. Here every
         * call that would reach the missing socket has an answer instead.
         */
        class control_socket final : private no_host_socket, public btinet_socket {
        public:
            explicit control_socket(btlink_inet_protocol *protocol)
                : btinet_socket(protocol, none_) {
            }

            bool set_option(const std::uint32_t option_id, const std::uint32_t option_family,
                std::uint8_t *buffer, const std::size_t avail_size) override {
                // See btlink_control_inet_socket upstream: Symbian 8.1 enables the
                // provider with option 1 at an undefined protocol level.
                if ((option_family == K_UNDEFINED_PROTOCOL_OPTION_LEVEL) && (option_id == 1)) {
                    return true;
                }

                return btinet_socket::set_option(option_id, option_family, buffer, avail_size);
            }

            void ioctl(const std::uint32_t command, epoc::notify_info &complete_info, std::uint8_t *buffer,
                const std::size_t available_size, const std::size_t max_buffer_size, const std::uint32_t level) override {
                btinet_socket::ioctl(command, complete_info, buffer, available_size, max_buffer_size, level);

                if (!complete_info.empty()) {
                    complete_info.complete(epoc::error_not_supported);
                }
            }

            void bind(const epoc::socket::saddress &, epoc::notify_info &info) override {
                info.complete(epoc::error_not_supported);
            }

            void connect(const epoc::socket::saddress &, epoc::notify_info &info) override {
                info.complete(epoc::error_not_supported);
            }

            void accept(std::unique_ptr<epoc::socket::socket> *, epoc::notify_info &complete_info) override {
                complete_info.complete(epoc::error_not_supported);
            }

            void send(const std::uint8_t *, const std::uint32_t, std::uint32_t *, const epoc::socket::saddress *, std::uint32_t,
                epoc::notify_info &complete_info) override {
                complete_info.complete(epoc::error_not_supported);
            }

            void receive(std::uint8_t *, const std::uint32_t, std::uint32_t *, epoc::socket::saddress *, std::uint32_t,
                epoc::notify_info &complete_info, epoc::socket::receive_done_callback done_callback) override {
                if (done_callback) {
                    done_callback(epoc::error_not_supported);
                }

                complete_info.complete(epoc::error_not_supported);
            }

            std::int32_t listen(const std::uint32_t) override {
                return epoc::error_not_supported;
            }

            std::int32_t remote_name(epoc::socket::saddress &, std::uint32_t &) override {
                return epoc::error_not_supported;
            }

            void cancel_receive() override {
            }

            void cancel_send() override {
            }

            void cancel_connect() override {
            }

            void cancel_accept() override {
            }
        };
    }

    endpoint::endpoint(std::shared_ptr<stack> stk, midman_inet *midman, const std::uint16_t protocol_id)
        : stack_(std::move(stk))
        , midman_(midman)
        , protocol_id_(protocol_id)
        , packets_(protocol_id == L2CAP_PROTOCOL_ID) {
    }

    void endpoint::give_back_port() {
        // The midman goes when its server does, which can be before the sockets
        // of a session; the stack knows (shutdown() runs in its destructor).
        if (holds_port_ && stack_->alive()) {
            midman_->close_port(port_);
        }

        holds_port_ = false;
    }

    void endpoint::teardown() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        // A socket closed with requests outstanding cancels them, as ESock does.
        // complete() does nothing when the whole guest is going away.
        stack_->complete(connect_info_, epoc::error_cancel);
        stack_->complete(receive_.info, epoc::error_cancel);
        stack_->complete(select_info_, epoc::error_cancel);
        stack_->complete(accept_info_, epoc::error_cancel);
        receive_ = receive_request();

        if (accept_target_) {
            accept_target_->acceptor_ = nullptr;
            accept_target_ = nullptr;
        }

        if (acceptor_) {
            // We were the socket a pending accept was going to fill.
            acceptor_->accept_target_ = nullptr;
            if (acceptor_->listener_) {
                acceptor_->listener_->accepting = false;
            }
            stack_->complete(acceptor_->accept_info_, epoc::error_cancel);
            acceptor_ = nullptr;
        }

        if (listener_) {
            stack_->unlisten(listener_);
            listener_.reset();
        }

        if (channel_) {
            stack_->release(channel_, CLOSE_NORMAL);
            channel_.reset();
        }

        give_back_port();
    }

    bool endpoint::ep_bind(const epoc::socket::saddress &addr, epoc::notify_info &info, std::uint16_t &port) {
        // A family of zero only names a port, which upstream accepts too.
        if (((addr.family_ != BTADDR_PROTOCOL_FAMILY_ID) && (addr.family_ != 0)) || (addr.port_ > 0xFFFF)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Address to bind is not a Bluetooth address with a 16-bit port!");
            info.complete(epoc::error_argument);
            return false;
        }

        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (listener_ || (channel_ && (channel_->state != channel::STATE_CLOSED))) {
            info.complete(epoc::error_in_use);
            return false;
        }

        std::uint16_t wanted = static_cast<std::uint16_t>(addr.port_);
        if (wanted == 0) {
            wanted = midman_->get_free_port();
            if (wanted == 0) {
                LOG_ERROR(SERVICE_BLUETOOTH, "Bluetooth ports have ran out. Can't bind!");
                info.complete(epoc::error_eof);
                return false;
            }
        }

        give_back_port();

        // The midman's table only has room for ports 1 to 60, which is all the
        // TCP mapping upstream ever needed. Here a port is just the number both
        // sides agree on, so a dynamic L2CAP PSM (0x1001 and up) is taken as it
        // is and merely not entered in that table.
        if (wanted <= midman::MAX_PORT) {
            midman_->ref_and_public_port(wanted);
            holds_port_ = true;
        }

        port_ = wanted;
        port = wanted;

        stack_->note("bind", protocol_id_, wanted, 0, epoc::error_none);
        info.complete(epoc::error_none);

        return true;
    }

    std::int32_t endpoint::ep_listen(const std::uint32_t backlog) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (listener_) {
            listener_->backlog = backlog;
            return epoc::error_none;
        }

        if (channel_ && (channel_->state != channel::STATE_CLOSED)) {
            return epoc::error_in_use;
        }

        if (port_ == 0) {
            stack_->note("listen", protocol_id_, 0, 0, epoc::error_not_ready);
            return epoc::error_not_ready;
        }

        int error = epoc::error_none;
        listener_ = stack_->listen(protocol_id_, port_, backlog, this, error);

        return error;
    }

    bool endpoint::ep_accept_begin(epoc::notify_info &info) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!listener_) {
            stack_->note("accept", protocol_id_, port_, 0, epoc::error_not_ready);
            info.complete(epoc::error_not_ready);
            return false;
        }

        if (!accept_info_.empty()) {
            info.complete(epoc::error_in_use);
            return false;
        }

        if (non_blocking_ && listener_->queue.empty()) {
            info.complete(epoc::socket::SOCKET_ERROR_WOULD_BLOCK);
            return false;
        }

        return true;
    }

    void endpoint::ep_accept(endpoint *target, epoc::notify_info &info) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        // The accepted socket answers for the listener's port, and holds it.
        target->port_ = port_;
        if (port_ && (port_ <= midman::MAX_PORT) && stack_->alive()) {
            midman_->ref_port(port_);
            target->holds_port_ = true;
        }

        if (!listener_) {
            info.complete(epoc::error_not_ready);
            return;
        }

        accept_info_ = info;
        info = epoc::notify_info();
        accept_target_ = target;
        target->acceptor_ = this;
        listener_->accepting = true;

        // Completes at once when a connection is waiting; otherwise when one comes.
        serve_accept();
    }

    void endpoint::serve_accept() {
        if (accept_info_.empty() || !accept_target_ || !listener_ || listener_->queue.empty()) {
            return;
        }

        const std::shared_ptr<channel> chan = listener_->queue.front();
        listener_->queue.pop_front();
        listener_->accepting = false;

        endpoint *target = accept_target_;
        accept_target_ = nullptr;
        target->acceptor_ = nullptr;
        target->adopt(chan);

        stack_->note("accept", protocol_id_, port_, chan->peer, epoc::error_none);
        stack_->complete(accept_info_, epoc::error_none);
    }

    void endpoint::adopt(const std::shared_ptr<channel> &chan) {
        channel_ = chan;
        chan->owner = this;
        last_error_ = 0;
    }

    void endpoint::listener_ready(listener &) {
        serve_accept();
        check_select();
    }

    void endpoint::ep_cancel_accept() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (accept_info_.empty()) {
            return;
        }

        if (accept_target_) {
            accept_target_->acceptor_ = nullptr;
            accept_target_ = nullptr;
        }

        if (listener_) {
            listener_->accepting = false;
        }

        stack_->complete(accept_info_, epoc::error_cancel);
    }

    void endpoint::ep_connect(const epoc::socket::saddress &addr, epoc::notify_info &info) {
        if ((addr.family_ != BTADDR_PROTOCOL_FAMILY_ID) || (addr.port_ > 0xFFFF)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Address to connect to is not a Bluetooth address with a 16-bit port!");
            info.complete(epoc::error_argument);
            return;
        }

        const socket_device_address &dvc_addr = static_cast<const socket_device_address &>(addr);
        const std::uint16_t port = static_cast<std::uint16_t>(addr.port_);

        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (listener_ || !connect_info_.empty() || (channel_ && (channel_->state != channel::STATE_CLOSED))) {
            info.complete(epoc::error_in_use);
            return;
        }

        if (channel_) {
            stack_->release(channel_, CLOSE_NORMAL);
            channel_.reset();
        }

        int error = epoc::error_none;
        channel_ = stack_->connect(*dvc_addr.get_device_address_const(), protocol_id_, port, this, error);

        if (!channel_) {
            // Nobody to reach: the link is down, or the address is not in the
            // room. Said at once, so that the game shows its own message.
            last_error_ = error;
            stack_->note("connect", protocol_id_, port, 0, error);
            info.complete(error);
            return;
        }

        last_error_ = 0;
        connect_info_ = info;
        info = epoc::notify_info();
    }

    void endpoint::channel_opened(channel &chan) {
        last_error_ = 0;
        stack_->note("connect", chan.protocol, chan.port, chan.peer, epoc::error_none);
        stack_->complete(connect_info_, epoc::error_none);

        check_select();
    }

    void endpoint::channel_failed(channel &chan, const int error) {
        if (channel_.get() == &chan) {
            channel_.reset();
        }

        last_error_ = error;
        stack_->note("connect", chan.protocol, chan.port, chan.peer, error);
        stack_->complete(connect_info_, error);

        check_select();
    }

    void endpoint::ep_cancel_connect() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (connect_info_.empty()) {
            return;
        }

        if (channel_) {
            stack_->note("connect", channel_->protocol, channel_->port, channel_->peer, epoc::error_cancel);
            stack_->release(channel_, CLOSE_RESET);
            channel_.reset();
        }

        stack_->complete(connect_info_, epoc::error_cancel);
    }

    void endpoint::ep_send(const std::uint8_t *data, const std::uint32_t size, std::uint32_t *sent, epoc::notify_info &info) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!channel_) {
            info.complete(epoc::error_not_ready);
            return;
        }

        const int error = stack_->send(*channel_, data, size);
        if (error == epoc::error_none) {
            if (sent) {
                *sent = size;
            }
        } else {
            stack_->note("send", channel_->protocol, channel_->port, channel_->peer, error);
        }

        info.complete(error);
    }

    void endpoint::ep_receive(std::uint8_t *data, const std::uint32_t size, std::uint32_t *received, epoc::socket::saddress *addr,
        const std::uint32_t flags, epoc::notify_info &info, epoc::socket::receive_done_callback done) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!receive_.info.empty()) {
            info.complete(epoc::error_in_use);
            return;
        }

        if (!channel_ || (channel_->state == channel::STATE_CONNECTING)) {
            if (done) {
                done(epoc::error_not_ready);
            }

            info.complete(epoc::error_not_ready);
            return;
        }

        if (!packets_ && (size == 0)) {
            if (received) {
                *received = 0;
            }

            if (done) {
                done(0);
            }

            info.complete(epoc::error_none);
            return;
        }

        const bool one_or_more = (flags & epoc::socket::SOCKET_FLAG_DONT_WAIT_FULL) != 0;

        receive_.info = info;
        receive_.data = data;
        receive_.size = size;
        receive_.received = received;
        receive_.addr = addr;
        receive_.done = std::move(done);
        // L2CAP hands over one packet per read whichever call was used. What
        // does not fit the buffer is discarded, as ESock does with a datagram,
        // unless the read asks for continuation: then the tail stays for the
        // next read, and Recv reports how much of it there is. RecvOneOrMore
        // reports what was read (see l2cap_inet_socket::receive upstream).
        receive_.available_only = packets_ || one_or_more;
        receive_.continuation = packets_ && !one_or_more && (flags & SOCKET_FLAG_READ_CONTINUATION);
        receive_.reports_read = !packets_ || one_or_more;

        info = epoc::notify_info();

        if (!receive_.available_only) {
            // A read that waits for its whole buffer must be allowed to queue that much.
            channel_->rx_limit = std::max<std::size_t>(RX_LIMIT, static_cast<std::size_t>(size) + RX_LIMIT);
        }

        if (try_receive()) {
            return;
        }

        if (non_blocking_) {
            finish_receive(epoc::socket::SOCKET_ERROR_WOULD_BLOCK, 0, 0);
        }
    }

    bool endpoint::try_receive() {
        if (receive_.info.empty()) {
            return true;
        }

        if (!stack_->can_complete(receive_.info)) {
            // The requester is gone, and its buffer with it.
            receive_ = receive_request();
            return true;
        }

        if (!channel_) {
            finish_receive(epoc::error_disconnected, 0, 0);
            return true;
        }

        channel &chan = *channel_;
        const bool closed = (chan.state == channel::STATE_CLOSED);

        if (chan.packets) {
            if (!chan.rx.empty()) {
                std::size_t remainder = 0;
                const std::size_t length = stack_->read(chan, receive_.data, receive_.size, &remainder);

                if (remainder && !receive_.continuation) {
                    stack_->skip_packet(chan);
                    remainder = 0;
                }

                // A plain Recv on a datagram socket reports what is left of the
                // datagram, which is nothing unless a tail was kept.
                finish_receive(epoc::error_none, length, receive_.reports_read ? length : remainder);
                return true;
            }
        } else if (chan.rx_queued && (receive_.available_only || (chan.rx_queued >= receive_.size) || closed)) {
            const std::size_t length = stack_->read(chan, receive_.data, receive_.size);

            // A read for a full buffer that the end of the connection cut
            // short hands over what there was, together with the reason.
            const bool cut_short = !receive_.available_only && (length < receive_.size);
            finish_receive(cut_short ? (chan.error ? chan.error : epoc::error_disconnected) : epoc::error_none, length, length);
            return true;
        }

        if (closed) {
            finish_receive(chan.error ? chan.error : epoc::error_disconnected, 0, 0);
            return true;
        }

        return false;
    }

    void endpoint::finish_receive(const int code, const std::size_t length, const std::size_t reported) {
        receive_request request = std::move(receive_);
        receive_ = receive_request();

        if (channel_) {
            channel_->rx_limit = RX_LIMIT;
        }

        if (!stack_->can_complete(request.info)) {
            return;
        }

        if (request.received) {
            *request.received = static_cast<std::uint32_t>(reported);
        }

        if (request.addr && channel_) {
            socket_device_address &from = static_cast<socket_device_address &>(*request.addr);
            std::memset(from.user_data_, 0, sizeof(from.user_data_));
            *from.get_device_address() = channel_->remote;
            from.family_ = BTADDR_PROTOCOL_FAMILY_ID;
            from.port_ = channel_->port;
        }

        if (request.done) {
            // The callback sets the length of the guest's descriptor.
            request.done(((code != epoc::error_none) && (length == 0)) ? static_cast<std::int64_t>(code)
                                                                      : static_cast<std::int64_t>(length));
        }

        stack_->complete(request.info, code);
    }

    void endpoint::channel_changed(channel &chan) {
        if ((chan.state == channel::STATE_CLOSED) && (chan.error != epoc::error_eof)) {
            last_error_ = chan.error;
        }

        if (!receive_.info.empty()) {
            try_receive();
        }

        check_select();
    }

    void endpoint::ep_cancel_receive() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!receive_.info.empty()) {
            finish_receive(epoc::error_cancel, 0, 0);
        }
    }

    void endpoint::ep_shutdown(epoc::notify_info &info, const int reason) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (reason == SHUTDOWN_STOP_INPUT) {
            if (channel_) {
                channel_->rx.clear();
                channel_->rx_offset = 0;
                channel_->rx_queued = 0;
            }

            if (!receive_.info.empty()) {
                finish_receive(epoc::error_eof, 0, 0);
            }

            info.complete(epoc::error_none);
            return;
        }

        // There is no half-closed state between two emulators: stopping the
        // output closes the connection, like the normal and the immediate kind.
        if (!accept_info_.empty()) {
            if (accept_target_) {
                accept_target_->acceptor_ = nullptr;
                accept_target_ = nullptr;
            }
            stack_->complete(accept_info_, epoc::error_cancel);
        }

        stack_->complete(connect_info_, epoc::error_cancel);

        if (listener_) {
            stack_->unlisten(listener_);
            listener_.reset();
        }

        if (channel_) {
            stack_->note("shutdown", channel_->protocol, channel_->port, channel_->peer, epoc::error_none);

            // The channel stays with us, closed: what was received can still be read.
            stack_->release(channel_, CLOSE_NORMAL);
        }

        if (!receive_.info.empty()) {
            try_receive();
        }

        check_select();
        info.complete(epoc::error_none);
    }

    std::int32_t endpoint::ep_remote_name(epoc::socket::saddress &result, std::uint32_t &result_len) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!channel_ || (channel_->state == channel::STATE_CONNECTING)) {
            return epoc::error_not_ready;
        }

        socket_device_address &addr = static_cast<socket_device_address &>(result);
        std::memset(addr.user_data_, 0, sizeof(addr.user_data_));
        *addr.get_device_address() = channel_->remote;
        addr.family_ = BTADDR_PROTOCOL_FAMILY_ID;
        addr.port_ = channel_->port;

        result_len = socket_device_address::DATA_LEN;
        return epoc::error_none;
    }

    std::uint32_t endpoint::poll_status() const {
        std::uint32_t status = 0;

        if (listener_ && !listener_->queue.empty()) {
            status |= SELECT_READ;
        }

        if (channel_) {
            const bool closed = (channel_->state == channel::STATE_CLOSED);

            if (channel_->rx_queued || closed) {
                status |= SELECT_READ;
            }

            if (channel_->state == channel::STATE_OPEN) {
                status |= SELECT_WRITE;
            }

            if (closed && (channel_->error != epoc::error_eof)) {
                status |= SELECT_EXCEPT;
            }
        }

        if (last_error_) {
            status |= SELECT_EXCEPT;
        }

        return status;
    }

    void endpoint::check_select() {
        if (select_info_.empty()) {
            return;
        }

        const std::uint32_t ready = poll_status() & select_events_;
        if (!ready) {
            return;
        }

        if (stack_->can_complete(select_info_)) {
            std::memcpy(select_buffer_, &ready, sizeof(ready));
        }

        stack_->complete(select_info_, epoc::error_none);
    }

    void endpoint::ep_cancel_ioctl() {
        const std::lock_guard<std::mutex> guard(stack_->lock());
        stack_->complete(select_info_, epoc::error_cancel);
    }

    bool endpoint::ep_get_option(const std::uint32_t option_id, const std::uint32_t option_family, std::uint8_t *buffer,
        const std::size_t avail_size, std::size_t &result) {
        if (option_family != epoc::socket::SOCKET_OPTION_FAMILY_BASE) {
            return false;
        }

        std::int32_t value = 0;

        {
            const std::lock_guard<std::mutex> guard(stack_->lock());

            switch (option_id) {
            case epoc::socket::SOCKET_OPTION_ID_NON_BLOCKING_IO:
                value = non_blocking_;
                break;

            case epoc::socket::SOCKET_OPTION_ID_BLOCKING_IO:
                value = !non_blocking_;
                break;

            case epoc::socket::SOCKET_OPTION_ID_SELECT_POLL:
                value = static_cast<std::int32_t>(poll_status());
                break;

            case epoc::socket::SOCKET_OPTION_ID_READ_BYTES_PENDING:
                // For a packet socket, the size of the packet a read would return.
                value = channel_ ? static_cast<std::int32_t>(channel_->readable()) : 0;
                break;

            case epoc::socket::SOCKET_OPTION_ID_SELECT_LAST_ERROR:
                value = last_error_;
                break;

            default:
                return false;
            }
        }

        if (!buffer || (avail_size < sizeof(value))) {
            result = MAKE_SOCKET_GETOPT_ERROR(epoc::error_argument);
            return true;
        }

        std::memcpy(buffer, &value, sizeof(value));
        result = sizeof(value);

        return true;
    }

    bool endpoint::ep_set_option(const std::uint32_t option_id, const std::uint32_t option_family) {
        if ((option_family != epoc::socket::SOCKET_OPTION_FAMILY_BASE)
            || ((option_id != epoc::socket::SOCKET_OPTION_ID_NON_BLOCKING_IO)
                && (option_id != epoc::socket::SOCKET_OPTION_ID_BLOCKING_IO))) {
            return false;
        }

        const std::lock_guard<std::mutex> guard(stack_->lock());
        non_blocking_ = (option_id == epoc::socket::SOCKET_OPTION_ID_NON_BLOCKING_IO);

        return true;
    }

    bool endpoint::ep_ioctl(const std::uint32_t command, epoc::notify_info &info, std::uint8_t *buffer,
        const std::size_t available_size, const std::size_t max_buffer_size, const std::uint32_t level) {
        if ((level != epoc::socket::SOCKET_IOCTL_LEVEL_BASE)
            || (command != epoc::socket::SOCKET_IOCTL_LEVEL_BASE_COMMAND_SELECT)) {
            return false;
        }

        if (!buffer || (available_size < sizeof(std::uint32_t)) || (max_buffer_size < sizeof(std::uint32_t))) {
            info.complete(epoc::error_argument);
            return true;
        }

        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!select_info_.empty()) {
            info.complete(epoc::error_in_use);
            return true;
        }

        std::memcpy(&select_events_, buffer, sizeof(select_events_));
        select_buffer_ = buffer;
        select_info_ = info;
        info = epoc::notify_info();

        check_select();
        return true;
    }

    btlink_web_protocol::btlink_web_protocol(midman_web *mid, const bool oldarch)
        : btlink_inet_protocol(mid, oldarch)
        , stack_(mid->get_stack()) {
    }

    std::unique_ptr<epoc::socket::socket> btlink_web_protocol::make_socket(const std::uint32_t, const std::uint32_t,
        const socket::socket_type) {
        return std::make_unique<control_socket>(this);
    }

    std::unique_ptr<epoc::socket::host_resolver> btlink_web_protocol::make_host_resolver(const std::uint32_t, const std::uint32_t) {
        return std::make_unique<resolver_web>(get_midman(), stack_);
    }

    l2cap_web_protocol::l2cap_web_protocol(midman_web *mid, const bool oldarch)
        : l2cap_inet_protocol(mid, nullptr, oldarch)
        , stack_(mid->get_stack()) {
    }

    std::unique_ptr<epoc::socket::socket> l2cap_web_protocol::make_socket(const std::uint32_t, const std::uint32_t,
        const socket::socket_type) {
        return make_empty_base_link_socket();
    }

    std::unique_ptr<epoc::socket::socket> l2cap_web_protocol::make_empty_base_link_socket() {
        return std::make_unique<l2cap_web_socket>(static_cast<l2cap_inet_protocol *>(this), stack_,
            static_cast<midman_inet *>(get_midman()), static_cast<std::uint16_t>(L2CAP_PROTOCOL_ID));
    }

    std::unique_ptr<epoc::socket::host_resolver> l2cap_web_protocol::make_host_resolver(const std::uint32_t, const std::uint32_t) {
        return std::make_unique<resolver_web>(get_midman(), stack_);
    }

    rfcomm_web_protocol::rfcomm_web_protocol(midman_web *mid, const bool oldarch)
        : rfcomm_inet_protocol(mid, nullptr, oldarch)
        , stack_(mid->get_stack()) {
    }

    std::unique_ptr<epoc::socket::socket> rfcomm_web_protocol::make_socket(const std::uint32_t, const std::uint32_t,
        const socket::socket_type) {
        return make_empty_base_link_socket();
    }

    std::unique_ptr<epoc::socket::socket> rfcomm_web_protocol::make_empty_base_link_socket() {
        return std::make_unique<rfcomm_web_socket>(static_cast<rfcomm_inet_protocol *>(this), stack_,
            static_cast<midman_inet *>(get_midman()), static_cast<std::uint16_t>(RFCOMM_PROTOCOL_ID));
    }

    std::unique_ptr<epoc::socket::host_resolver> rfcomm_web_protocol::make_host_resolver(const std::uint32_t, const std::uint32_t) {
        return std::make_unique<resolver_web>(get_midman(), stack_);
    }

    sdp_web_protocol::sdp_web_protocol(midman_web *mid, const bool oldarch)
        : sdp_inet_protocol(mid, nullptr, oldarch)
        , stack_(mid->get_stack()) {
    }

    std::unique_ptr<epoc::socket::net_database> sdp_web_protocol::make_net_database(const std::uint32_t, const std::uint32_t) {
        return std::make_unique<sdp_web_net_database>(this, stack_);
    }
}
