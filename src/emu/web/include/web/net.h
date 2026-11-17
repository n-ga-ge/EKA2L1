// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <control/api.h>

namespace eka2l1::web {
    // Multiplayer: the guest's Bluetooth runs over frames that the page
    // carries between players (services/bluetooth/protocols/web). This is the
    // page's side of that boundary; the exports are in net.cpp.

    /// Give the Bluetooth link its way out to the page. Call once at startup.
    void net_setup();

    /// Answers GET /v1/net, the state of the link and of the guest's Bluetooth
    /// stack. Returns false for every other request.
    bool net_route(const control::request &req, control::response &res);
}
