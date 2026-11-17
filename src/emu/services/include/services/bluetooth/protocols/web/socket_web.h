// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Guest Bluetooth sockets for the browser. The inet classes stay the base, so
// that options, ioctls, local names and the port bookkeeping are theirs; the
// transport half, which upstream hands to a TCP socket, is replaced here by
// channels of the web stack. A btinet_socket without an inner socket is a
// state upstream builds itself (accept placeholders, link-manager sockets).
#pragma once

#include <services/bluetooth/protocols/btlink/btlink_inet.h>
#include <services/bluetooth/protocols/l2cap/l2cap_inet.h>
#include <services/bluetooth/protocols/rfcomm/rfcomm_inet.h>
#include <services/bluetooth/protocols/sdp/sdp_inet.h>
#include <services/bluetooth/protocols/web/stack.h>
#include <services/socket/socket.h>
#include <utils/err.h>

#include <memory>

namespace eka2l1::epoc::bt {
    class midman_web;
}

namespace eka2l1::epoc::bt::web {
    /**
     * @brief What a guest socket does with the stack, independent of its protocol class.
     *
     * The ep_* methods are the guest's calls: they run on the Symbian OS thread,
     * which holds the kernel lock, and take the stack's lock themselves. The
     * owner callbacks come from the stack with both held.
     */
    class endpoint : public channel_owner, public listener_owner {
    private:
        struct receive_request {
            epoc::notify_info info;
            std::uint8_t *data = nullptr;
            std::uint32_t size = 0;
            std::uint32_t *received = nullptr;
            epoc::socket::saddress *addr = nullptr;
            bool available_only = false; ///< RecvOneOrMore, or any read of a packet socket.
            bool continuation = false; ///< A packet that does not fit keeps its tail for the next read.
            bool reports_read = true; ///< The length reported is what was read, not what is left of the packet.
            epoc::socket::receive_done_callback done;
        };

        std::shared_ptr<stack> stack_;
        midman_inet *midman_;
        std::uint16_t protocol_id_;
        bool packets_;

        std::uint16_t port_ = 0;
        bool holds_port_ = false; ///< A reference in the midman's port table is ours to give back.
        bool non_blocking_ = false;
        int last_error_ = 0;

        std::shared_ptr<listener> listener_;
        std::shared_ptr<channel> channel_;

        epoc::notify_info connect_info_;
        epoc::notify_info accept_info_;
        endpoint *accept_target_ = nullptr; ///< In the listener: the socket a pending accept fills.
        endpoint *acceptor_ = nullptr; ///< In that socket: the listener.

        receive_request receive_;

        epoc::notify_info select_info_;
        std::uint8_t *select_buffer_ = nullptr;
        std::uint32_t select_events_ = 0;

        void adopt(const std::shared_ptr<channel> &chan);
        void serve_accept();
        bool try_receive();
        void finish_receive(const int code, const std::size_t length, const std::size_t reported);
        void check_select();
        std::uint32_t poll_status() const;
        void give_back_port();

    protected:
        explicit endpoint(std::shared_ptr<stack> stk, midman_inet *midman, const std::uint16_t protocol_id);

        /// Let go of everything. For the destructor of the socket class, before its bases go.
        void teardown();

        bool ep_bind(const epoc::socket::saddress &addr, epoc::notify_info &info, std::uint16_t &port);
        std::int32_t ep_listen(const std::uint32_t backlog);
        /// False when the accept was answered already and no socket is to be made for it.
        bool ep_accept_begin(epoc::notify_info &info);
        void ep_accept(endpoint *target, epoc::notify_info &info);
        void ep_connect(const epoc::socket::saddress &addr, epoc::notify_info &info);
        void ep_send(const std::uint8_t *data, const std::uint32_t size, std::uint32_t *sent, epoc::notify_info &info);
        void ep_receive(std::uint8_t *data, const std::uint32_t size, std::uint32_t *received, epoc::socket::saddress *addr,
            const std::uint32_t flags, epoc::notify_info &info, epoc::socket::receive_done_callback done);
        void ep_shutdown(epoc::notify_info &info, const int reason);
        std::int32_t ep_remote_name(epoc::socket::saddress &result, std::uint32_t &result_len);

        void ep_cancel_connect();
        void ep_cancel_accept();
        void ep_cancel_receive();
        void ep_cancel_ioctl();

        /// These three return false for what is not theirs to answer.
        bool ep_get_option(const std::uint32_t option_id, const std::uint32_t option_family, std::uint8_t *buffer,
            const std::size_t avail_size, std::size_t &result);
        bool ep_set_option(const std::uint32_t option_id, const std::uint32_t option_family);
        bool ep_ioctl(const std::uint32_t command, epoc::notify_info &info, std::uint8_t *buffer,
            const std::size_t available_size, const std::size_t max_buffer_size, const std::uint32_t level);

    public:
        virtual ~endpoint() = default;

        void channel_opened(channel &chan) override;
        void channel_failed(channel &chan, const int error) override;
        void channel_changed(channel &chan) override;
        void listener_ready(listener &lis) override;
    };

    struct no_host_socket {
        std::unique_ptr<epoc::socket::socket> none_;
    };

    /**
     * @brief `Base` (an inet Bluetooth socket class) with its transport replaced.
     *
     * Every method of btinet_socket that reaches for the inner TCP socket is
     * overridden; the rest is inherited.
     */
    template <class Base>
    class web_socket final : private no_host_socket, public Base, public endpoint {
    public:
        template <class Protocol>
        explicit web_socket(Protocol *pr, std::shared_ptr<stack> stk, midman_inet *midman, const std::uint16_t protocol_id)
            : Base(pr, none_)
            , endpoint(std::move(stk), midman, protocol_id) {
        }

        ~web_socket() override {
            teardown();

            // The port went back in teardown(), while the midman was known to
            // be alive. The base must not look for it again.
            this->virtual_port_ = 0;
        }

        std::size_t get_option(const std::uint32_t option_id, const std::uint32_t option_family,
            std::uint8_t *buffer, const std::size_t avail_size) override {
            std::size_t result = 0;
            if (ep_get_option(option_id, option_family, buffer, avail_size, result)) {
                return result;
            }

            return Base::get_option(option_id, option_family, buffer, avail_size);
        }

        bool set_option(const std::uint32_t option_id, const std::uint32_t option_family,
            std::uint8_t *buffer, const std::size_t avail_size) override {
            if (ep_set_option(option_id, option_family)) {
                return true;
            }

            return Base::set_option(option_id, option_family, buffer, avail_size);
        }

        void ioctl(const std::uint32_t command, epoc::notify_info &complete_info, std::uint8_t *buffer,
            const std::size_t available_size, const std::size_t max_buffer_size, const std::uint32_t level) override {
            if (ep_ioctl(command, complete_info, buffer, available_size, max_buffer_size, level)) {
                return;
            }

            Base::ioctl(command, complete_info, buffer, available_size, max_buffer_size, level);

            // The base answers what it knows and only logs the rest, which
            // would leave the guest's request pending for good.
            if (!complete_info.empty()) {
                complete_info.complete(epoc::error_not_supported);
            }
        }

        void bind(const epoc::socket::saddress &addr, epoc::notify_info &info) override {
            std::uint16_t port = 0;
            if (ep_bind(addr, info, port)) {
                this->virtual_port_ = port;
            }
        }

        std::int32_t listen(const std::uint32_t backlog) override {
            return ep_listen(backlog);
        }

        void accept(std::unique_ptr<epoc::socket::socket> *pending_sock, epoc::notify_info &complete_info) override {
            if (!ep_accept_begin(complete_info)) {
                return;
            }

            // Replacing the guest's blank socket destroys it, which takes the
            // stack's lock: none may be held here.
            *pending_sock = this->protocol_->make_empty_base_link_socket();

            web_socket *target = static_cast<web_socket *>(pending_sock->get());
            target->virtual_port_ = this->virtual_port_;

            ep_accept(target, complete_info);
        }

        void connect(const epoc::socket::saddress &addr, epoc::notify_info &info) override {
            ep_connect(addr, info);
        }

        void send(const std::uint8_t *data, const std::uint32_t data_size, std::uint32_t *sent_size,
            const epoc::socket::saddress *addr, std::uint32_t flags, epoc::notify_info &complete_info) override {
            ep_send(data, data_size, sent_size, complete_info);
        }

        void receive(std::uint8_t *data, const std::uint32_t data_size, std::uint32_t *sent_size, epoc::socket::saddress *addr,
            std::uint32_t flags, epoc::notify_info &complete_info, epoc::socket::receive_done_callback done_callback) override {
            ep_receive(data, data_size, sent_size, addr, flags, complete_info, std::move(done_callback));
        }

        void shutdown(epoc::notify_info &complete_info, int reason) override {
            ep_shutdown(complete_info, reason);
        }

        std::int32_t remote_name(epoc::socket::saddress &result, std::uint32_t &result_len) override {
            return ep_remote_name(result, result_len);
        }

        void cancel_receive() override {
            ep_cancel_receive();
        }

        void cancel_send() override {
            // A send is finished by the time the call returns.
        }

        void cancel_connect() override {
            ep_cancel_connect();
        }

        void cancel_accept() override {
            ep_cancel_accept();
        }

        void cancel_ioctl() override {
            ep_cancel_ioctl();
        }
    };

    using l2cap_web_socket = web_socket<l2cap_inet_socket>;
    using rfcomm_web_socket = web_socket<rfcomm_inet_socket>;

    class btlink_web_protocol : public btlink_inet_protocol {
    private:
        std::shared_ptr<stack> stack_;

    public:
        explicit btlink_web_protocol(midman_web *mid, const bool oldarch);

        std::unique_ptr<epoc::socket::socket> make_socket(const std::uint32_t family_id, const std::uint32_t protocol_id,
            const socket::socket_type sock_type) override;
        std::unique_ptr<epoc::socket::host_resolver> make_host_resolver(const std::uint32_t id, const std::uint32_t family_id) override;
    };

    class l2cap_web_protocol : public l2cap_inet_protocol {
    private:
        std::shared_ptr<stack> stack_;

    public:
        explicit l2cap_web_protocol(midman_web *mid, const bool oldarch);

        std::unique_ptr<epoc::socket::socket> make_socket(const std::uint32_t family_id, const std::uint32_t protocol_id,
            const socket::socket_type sock_type) override;
        std::unique_ptr<epoc::socket::socket> make_empty_base_link_socket() override;
        std::unique_ptr<epoc::socket::host_resolver> make_host_resolver(const std::uint32_t id, const std::uint32_t family_id) override;
    };

    class rfcomm_web_protocol : public rfcomm_inet_protocol {
    private:
        std::shared_ptr<stack> stack_;

    public:
        explicit rfcomm_web_protocol(midman_web *mid, const bool oldarch);

        std::unique_ptr<epoc::socket::socket> make_socket(const std::uint32_t family_id, const std::uint32_t protocol_id,
            const socket::socket_type sock_type) override;
        std::unique_ptr<epoc::socket::socket> make_empty_base_link_socket() override;
        std::unique_ptr<epoc::socket::host_resolver> make_host_resolver(const std::uint32_t id, const std::uint32_t family_id) override;
    };

    class sdp_web_protocol : public sdp_inet_protocol {
    private:
        std::shared_ptr<stack> stack_;

    public:
        explicit sdp_web_protocol(midman_web *mid, const bool oldarch);

        std::unique_ptr<epoc::socket::net_database> make_net_database(const std::uint32_t id, const std::uint32_t family_id) override;
    };
}
