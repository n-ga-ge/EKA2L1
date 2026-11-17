// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <services/bluetooth/btmidman.h>
#include <services/bluetooth/protocols/web/stack.h>
#include <services/socket/host.h>

#include <memory>
#include <vector>

namespace eka2l1::epoc::bt::web {
    /**
     * @brief Device inquiry over the page link.
     *
     * An inquiry answers with every room member that has announced itself, one
     * per request, and then ends with KErrEof after the delay the inet resolver
     * uses, so that a game sees its usual "searching" before "nobody found".
     */
    class resolver_web : public socket::host_resolver {
    private:
        static constexpr std::int64_t SEARCH_END_DELAY_US = 2000000;

        midman *mid_;
        std::shared_ptr<stack> stack_;

        std::vector<peer_info> found_;
        std::size_t next_ = 0;
        bool searching_ = false;

        epoc::notify_info info_;
        std::uint64_t end_timer_ = 0;

        void answer(epoc::socket::name_entry *result, epoc::notify_info &info);

    public:
        explicit resolver_web(midman *mid, std::shared_ptr<stack> stk);
        ~resolver_web() override;

        std::u16string host_name() const override;
        bool host_name(const std::u16string &name) override;

        void get_by_address(epoc::socket::saddress &addr, epoc::socket::name_entry *result, epoc::notify_info &info) override;
        void get_by_name(epoc::socket::name_entry *supply_and_result, epoc::notify_info &info) override;
        void next(epoc::socket::name_entry *result, epoc::notify_info &info) override;
        void cancel() override;
    };
}
