// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/sdp_web.h>

#include <common/bytes.h>
#include <common/log.h>
#include <kernel/thread.h>
#include <utils/err.h>

#include <cstring>

namespace eka2l1::epoc::bt::web {
    namespace {
        enum {
            ERROR_SDP_PEER_ERROR = -6401,
            ERROR_SDP_BAD_RESULT_DATA = -6410
        };

        constexpr std::uint16_t SDP_PORT = 1;
    }

    sdp_web_net_database::sdp_web_net_database(sdp_inet_protocol *protocol, std::shared_ptr<stack> stk)
        : sdp_inet_net_database(protocol, nullptr)
        , stack_(std::move(stk)) {
    }

    sdp_web_net_database::~sdp_web_net_database() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        stack_->complete(current_query_notify_, epoc::error_cancel);
        provided_result_ = nullptr;

        if (channel_) {
            stack_->release(channel_, CLOSE_NORMAL);
            channel_.reset();
        }
    }

    void sdp_web_net_database::query(const char *query_data, const std::uint32_t query_size, epoc::des8 *result_buffer,
        epoc::notify_info &complete_info) {
        if (!query_data || (query_size < sizeof(sdp_query_base))) {
            complete_info.complete(epoc::error_argument);
            return;
        }

        std::uint32_t type = 0;
        std::memcpy(&type, query_data, sizeof(type));
        type &= SDP_QUERY_TYPE_MASK;

        std::size_t needed = sizeof(sdp_query_base);

        switch (type) {
        case SDP_QUERY_CONNECT:
            needed = sizeof(sdp_connect_query);
            break;

        case SDP_QUERY_SERVICE:
            needed = sizeof(sdp_service_query);
            break;

        case SDP_QUERY_ENCODED:
            needed = sizeof(sdp_encoded_query);
            break;

        case SDP_QUERY_RETRIEVE_RESULT_BUFFER:
            break;

        default:
            // The base only logs these and then holds on to the request for good.
            LOG_ERROR(SERVICE_BLUETOOTH, "Unhandled SDP NetDatabase query 0x{:X}", type);
            complete_info.complete(epoc::error_not_supported);
            return;
        }

        if (query_size < needed) {
            complete_info.complete(epoc::error_argument);
            return;
        }

        // The handlers below run under the stack's lock, like the answers do.
        const std::lock_guard<std::mutex> guard(stack_->lock());

        stack_->totals().sdp_queries++;
        sdp_inet_net_database::query(query_data, query_size, result_buffer, complete_info);
    }

    void sdp_web_net_database::cancel() {
        const std::lock_guard<std::mutex> guard(stack_->lock());
        sdp_inet_net_database::cancel();
    }

    void sdp_web_net_database::handle_connect_query(const char *record_buf, const std::uint32_t) {
        const sdp_connect_query *query = reinterpret_cast<const sdp_connect_query *>(record_buf);

        if (channel_) {
            stack_->release(channel_, CLOSE_NORMAL);
            channel_.reset();
        }

        int error = epoc::error_none;
        channel_ = stack_->connect(query->addr_, L2CAP_PROTOCOL_ID, SDP_PORT, this, error);

        if (!channel_) {
            stack_->note("sdp-connect", SDP_PROTOCOL_ID, SDP_PORT, 0, error);
            current_query_notify_.complete(error);
        }
    }

    void sdp_web_net_database::channel_opened(channel &chan) {
        stack_->note("sdp-connect", SDP_PROTOCOL_ID, SDP_PORT, chan.peer, epoc::error_none);
        stack_->complete(current_query_notify_, epoc::error_none);
    }

    void sdp_web_net_database::channel_failed(channel &chan, const int error) {
        if (channel_.get() == &chan) {
            channel_.reset();
        }

        stack_->note("sdp-connect", SDP_PROTOCOL_ID, SDP_PORT, chan.peer, error);
        stack_->complete(current_query_notify_, error);
    }

    void sdp_web_net_database::send_pdu_packet(const char *buf, const std::uint32_t buf_size) {
        const int error = channel_ ? stack_->send(*channel_, reinterpret_cast<const std::uint8_t *>(buf), buf_size)
                                   : epoc::error_not_ready;

        if (error != epoc::error_none) {
            stack_->note("sdp-query", SDP_PROTOCOL_ID, SDP_PORT, channel_ ? channel_->peer : 0, error);
            current_query_notify_.complete(error);
        }
    }

    void sdp_web_net_database::channel_changed(channel &chan) {
        std::vector<std::uint8_t> packet;

        while (const std::size_t size = chan.readable()) {
            packet.resize(size);
            stack_->read(chan, packet.data(), size);
            handle_response(packet.data(), size);
        }

        if (chan.state == channel::STATE_CLOSED) {
            // Whatever was asked will not be answered now.
            if (!current_query_notify_.empty()) {
                stack_->note("sdp-query", SDP_PROTOCOL_ID, SDP_PORT, chan.peer, epoc::error_disconnected);
            }

            stack_->complete(current_query_notify_, epoc::error_disconnected);

            if (channel_.get() == &chan) {
                stack_->release(channel_, CLOSE_NORMAL);
                channel_.reset();
            }
        }
    }

    // What sdp_inet_net_database::handle_new_pdu_packet does, for a caller that
    // holds the kernel lock already: upstream's takes it itself.
    void sdp_web_net_database::handle_response(const std::uint8_t *buffer, const std::size_t size) {
        if (current_query_notify_.empty()) {
            return;
        }

        if (!stack_->can_complete(current_query_notify_)) {
            // The guest is going away, and the buffer for the answer with it.
            current_query_notify_ = epoc::notify_info();
            provided_result_ = nullptr;
            return;
        }

        if (size < pdu_builder::PDU_HEADER_SIZE) {
            return;
        }

        const std::uint8_t pdu_id = buffer[pdu_builder::PDU_ID_OFFSET];
        std::uint16_t trans_id = 0;
        std::uint16_t param_len = 0;

        std::memcpy(&trans_id, buffer + pdu_builder::TRANS_ID_OFFSET, 2);
        std::memcpy(&param_len, buffer + pdu_builder::PARAM_LEN_OFFSET, 2);

        trans_id = common::to_host_order(trans_id);
        param_len = common::to_host_order(param_len);

        const std::uint8_t *param = buffer + pdu_builder::PDU_HEADER_SIZE;

        if ((trans_id != pdu_packet_builder_.current_transmission_id()) || (param_len > size - pdu_builder::PDU_HEADER_SIZE)) {
            LOG_TRACE(SERVICE_BLUETOOTH, "SDP answer does not match the question (transaction {}, expected {})", trans_id,
                pdu_packet_builder_.current_transmission_id());
            current_query_notify_.complete(ERROR_SDP_BAD_RESULT_DATA);
            return;
        }

        switch (pdu_id) {
        case SDP_PDU_ERROR_RESPONE: {
            if (param_len < 2) {
                current_query_notify_.complete(ERROR_SDP_PEER_ERROR);
                return;
            }

            std::uint16_t error = 0;
            std::memcpy(&error, param, 2);
            error = common::to_host_order(error);

            stack_->note("sdp-query", SDP_PROTOCOL_ID, SDP_PORT, channel_ ? channel_->peer : 0, error);
            current_query_notify_.complete(error);
            return;
        }

        case SDP_PDU_SERVICE_ATTRIBUTE_RESPONSE:
        case SDP_PDU_SERVICE_SEARCH_RESPONSE:
            finish_query(param, param_len);
            return;

        default:
            current_query_notify_.complete(ERROR_SDP_BAD_RESULT_DATA);
            return;
        }
    }

    // sdp_inet_net_database::handle_normal_query_complete, again without the locking.
    void sdp_web_net_database::finish_query(const std::uint8_t *param, const std::uint32_t param_len) {
        if (!provided_result_) {
            LOG_ERROR(SERVICE_BLUETOOTH, "No result buffer for SDP query!");
            current_query_notify_.complete(epoc::error_general);
            return;
        }

        kernel::process *own_pr = current_query_notify_.requester->owning_process();
        const std::uint32_t current_len = provided_result_->get_length();

        if (store_to_temp_buffer_) {
            stored_query_buffer_.assign(reinterpret_cast<const char *>(param), reinterpret_cast<const char *>(param) + param_len);

            if (current_len != 4) {
                LOG_WARN(SERVICE_BLUETOOTH, "Query packet length buffer's size is incorrect");
                current_query_notify_.complete(epoc::error_argument);
                return;
            }

            provided_result_->assign(own_pr, reinterpret_cast<const std::uint8_t *>(&param_len), 4);
        } else {
            if (current_len < param_len) {
                LOG_WARN(SERVICE_BLUETOOTH, "Provided result buffer size is smaller then total query result length!");
                current_query_notify_.complete(epoc::error_argument);
                return;
            }

            provided_result_->assign(own_pr, param, param_len);
            provided_result_ = nullptr;
        }

        stack_->note("sdp-query", SDP_PROTOCOL_ID, SDP_PORT, channel_ ? channel_->peer : 0, epoc::error_none);
        current_query_notify_.complete(epoc::error_none);
    }
}
