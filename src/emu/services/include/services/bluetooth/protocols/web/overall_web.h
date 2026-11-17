// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where the browser build's Bluetooth is plugged into the shared code.
#pragma once

#include <services/bluetooth/btmidman.h>
#include <services/bluetooth/protocols/common.h>
#include <services/bluetooth/protocols/web/stack.h>

#include <memory>

namespace eka2l1 {
    class io_system;
    class socket_server;
}

namespace eka2l1::epoc::bt::web {
    std::unique_ptr<midman> make_midman();

    /// Register the link manager, L2CAP, RFCOMM and SDP, and start taking traffic.
    void add_protocols(socket_server *sock, midman *mm, const bool oldarch);

    /**
     * @brief Answer the guest's "choose a device" dialog.
     *
     * There is no dialog on the page yet, so the choice is the announced room
     * member with the lowest id: the right one while a room has two players.
     *
     * @returns False when nobody is there to choose.
     */
    bool pick_peer(midman *mm, device_address &selected);

    /**
     * @brief Set the phone's own Bluetooth switch to on (Series 60 1.x devices).
     *
     * The Bluetooth engine of those devices keeps the switch in a shared-data
     * file on C:, "key=value" lines in UTF-16. A game that finds PowerMode other
     * than 1 asks the user to switch Bluetooth on and gives up when that does
     * not happen (Rayman 3 panics with GC-MAIN 4). In the browser there is no
     * radio to switch: Bluetooth is the page's room link, so the phone starts
     * with it on. Call once the device's drives are mounted, before the guest runs.
     */
    void switch_bluetooth_on(io_system *io);

    /// The state of the link and of the running guest's stack, for GET /v1/net.
    void diagnose(diagnostics &out);
}
