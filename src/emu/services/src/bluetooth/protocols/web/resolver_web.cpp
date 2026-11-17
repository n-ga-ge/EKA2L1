// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/resolver_web.h>

#include <common/cvt.h>
#include <common/log.h>
#include <utils/err.h>

namespace eka2l1::epoc::bt::web {
    resolver_web::resolver_web(midman *mid, std::shared_ptr<stack> stk)
        : mid_(mid)
        , stack_(std::move(stk)) {
    }

    resolver_web::~resolver_web() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        stack_->stop_timer(end_timer_);
        stack_->complete(info_, epoc::error_cancel);
    }

    std::u16string resolver_web::host_name() const {
        const std::lock_guard<std::mutex> guard(stack_->lock());
        return stack_->local_name();
    }

    bool resolver_web::host_name(const std::u16string &name) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (stack_->alive()) {
            mid_->device_name(name);
        }

        // Games set the name they just read, over and over: only a change is
        // worth a line among the last operations.
        if (stack_->set_name(name)) {
            stack_->note("set-name", BTLINK_MANAGER_PROTOCOL_ID, 0, 0, epoc::error_none);
        }

        return true;
    }

    void resolver_web::answer(epoc::socket::name_entry *result, epoc::notify_info &info) {
        if (next_ < found_.size()) {
            const peer_info &peer = found_[next_++];

            // The fields the inet resolver fills, for a phone like this one.
            inquiry_socket_address &cast_addr = static_cast<inquiry_socket_address &>(result->addr_);
            inquiry_info *inquiry = cast_addr.get_inquiry_info();

            inquiry->addr_ = peer.address;
            inquiry->major_service_class_ = MAJOR_SERVICE_TELEPHONY;
            inquiry->major_device_class_ = MAJOR_DEVICE_PHONE;
            inquiry->minor_device_class_ = MINOR_DEVICE_PHONE_CECULLAR;
            cast_addr.family_ = BTADDR_PROTOCOL_FAMILY_ID;

            result->name_.assign(nullptr, peer.name.empty() ? std::u16string(u"N-Gage") : common::utf8_to_ucs2(peer.name));

            info.complete(epoc::error_none);
            return;
        }

        // Nobody (else). Say so after a while, like a search that ran its course.
        info_ = info;
        info = epoc::notify_info();

        end_timer_ = stack_->start_timer(SEARCH_END_DELAY_US, [this]() {
            end_timer_ = 0;
            searching_ = false;
            stack_->complete(info_, epoc::error_eof);
        });

        if (!end_timer_) {
            searching_ = false;
            stack_->complete(info_, epoc::error_eof);
        }
    }

    void resolver_web::get_by_address(epoc::socket::saddress &, epoc::socket::name_entry *result, epoc::notify_info &info) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!info_.empty()) {
            info.complete(epoc::error_server_busy);
            return;
        }

        found_ = stack_->announced_peers();
        next_ = 0;
        searching_ = true;

        stack_->totals().inquiries++;
        stack_->note("inquiry", BTLINK_MANAGER_PROTOCOL_ID, 0, 0, found_.empty() ? epoc::error_eof : epoc::error_none);

        answer(result, info);
    }

    void resolver_web::get_by_name(epoc::socket::name_entry *, epoc::notify_info &info) {
        LOG_WARN(SERVICE_BLUETOOTH, "Get host by name stubbed to not found");
        info.complete(epoc::error_not_supported);
    }

    void resolver_web::next(epoc::socket::name_entry *result, epoc::notify_info &info) {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        if (!info_.empty()) {
            info.complete(epoc::error_server_busy);
            return;
        }

        if (!searching_) {
            info.complete(epoc::error_not_ready);
            return;
        }

        answer(result, info);
    }

    void resolver_web::cancel() {
        const std::lock_guard<std::mutex> guard(stack_->lock());

        stack_->stop_timer(end_timer_);
        searching_ = false;
        stack_->complete(info_, epoc::error_cancel);
    }
}
