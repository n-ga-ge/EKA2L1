// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <control/api.h>

#include <cstdint>

namespace eka2l1 {
    class system;

    namespace kernel {
        class process;
    }
}

namespace eka2l1::web {
    // What the "exits" part of GET /v1/web/diag (diag_exits.cpp) is told by
    // the rest of the frontend, and the one request of its own.

    /// How the page is told of an event (main.cpp's notify_page). Call once
    /// at startup, before the guest runs.
    void exits_setup(void (*notify)(const char *event));

    /// Answers POST /v1/web/diag/stop, which is for tests: see diag_exits.cpp.
    /// Returns false for every other request.
    bool exits_route(const control::request &req, control::response &res);

    /// Listen to the kernel for threads that end. Call after every system
    /// reset; a kernel that is already listened to is left alone.
    void exits_watch(system *sys);

    /// The page launches the application with this UID. Call before the launch.
    void exits_app_launched(std::uint32_t uid);

    /// The launch is over: the program it started, or one that program
    /// started, has ended (the launch callback).
    void exits_app_ended(kernel::process *process);

    /// The thread that runs the guest has given up: remember why and tell the
    /// page with an "emulator-stopped" event.
    void exits_emulator_stopped(const char *message);
}
