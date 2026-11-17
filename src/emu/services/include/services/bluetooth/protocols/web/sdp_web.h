// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <services/bluetooth/protocols/sdp/sdp_inet.h>
#include <services/bluetooth/protocols/web/stack.h>

#include <memory>

namespace eka2l1::epoc::bt::web {
    /**
     * @brief The client side of service discovery over the page link.
     *
     * There is no host-side SDP server. The other player's own Sdp.exe (guest
     * code from the ROM) listens on L2CAP port 1 through its emulated socket
     * server and builds the answers. This asks it: the queries are built by
     * the inet class, and each PDU travels as one packet of a channel to
     * (L2CAP, 1) on the peer, where upstream opens a TCP connection.
     */
    class sdp_web_net_database : public sdp_inet_net_database, public channel_owner {
    private:
        std::shared_ptr<stack> stack_;
        std::shared_ptr<channel> channel_;

        void handle_response(const std::uint8_t *buffer, const std::size_t size);
        void finish_query(const std::uint8_t *param, const std::uint32_t param_len);

    protected:
        void handle_connect_query(const char *record_buf, const std::uint32_t record_size) override;
        void send_pdu_packet(const char *buf, const std::uint32_t buf_size) override;

    public:
        explicit sdp_web_net_database(sdp_inet_protocol *protocol, std::shared_ptr<stack> stk);
        ~sdp_web_net_database() override;

        void query(const char *query_data, const std::uint32_t query_size, epoc::des8 *result_buffer, epoc::notify_info &complete_info) override;
        void cancel() override;

        void channel_opened(channel &chan) override;
        void channel_failed(channel &chan, const int error) override;
        void channel_changed(channel &chan) override;
    };
}
