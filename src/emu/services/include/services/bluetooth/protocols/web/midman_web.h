// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <services/bluetooth/protocols/btmidman_inet.h>
#include <services/bluetooth/protocols/web/stack.h>

#include <memory>

namespace eka2l1::epoc::bt {
    /**
     * @brief The Bluetooth midman of the browser build.
     *
     * A midman_inet whose discovery is off creates no sockets, timers or
     * threads and still provides what the socket classes ask it for: the
     * device's random address and the port table. That is the base here,
     * whatever the configuration says, and the traffic goes through the web
     * stack this owns.
     */
    class midman_web : public midman_inet {
    private:
        std::shared_ptr<web::stack> stack_;

    public:
        explicit midman_web();
        ~midman_web() override;

        // Shared: the sockets of a session can outlive the server that owns this.
        std::shared_ptr<web::stack> get_stack() {
            return stack_;
        }
    };
}
