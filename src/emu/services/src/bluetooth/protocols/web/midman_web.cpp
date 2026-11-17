// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/midman_web.h>

#include <config/config.h>

namespace eka2l1::epoc::bt {
    // A default configuration has discovery off. The real one is not passed
    // on: its discovery mode can be changed through the control API, and any
    // other mode would have the base open sockets a browser does not have.
    midman_web::midman_web()
        : midman_inet(config::state())
        , stack_(std::make_shared<web::stack>(local_device_address())) {
    }

    midman_web::~midman_web() {
        stack_->shutdown();
    }
}
