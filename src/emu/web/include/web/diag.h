// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <control/api.h>

#include <mutex>

namespace eka2l1 {
    class system;
}

namespace eka2l1::web {
    struct emulator;

    // Diagnostics: what the page needs to tell a visitor why a game runs
    // badly. One request, GET /v1/web/diag, answers
    //
    //   { "v": 1, "uptimeMs": <since start>, "speed": {...}, "graphics": {...},
    //     "audio": {...}, "exits": {...} }
    //
    // Numbers are totals since the page loaded unless a name says otherwise;
    // the page takes a reading a second and works out the rates. Each section
    // is built by its own file (diag_<section>.cpp) from the counters in
    // common/webdiag/<section>.h, and is documented where it is built.
    //
    // The request is answered on the dispatcher thread without the control
    // lock, like GET /v1/net, so it is answered while a long request (an
    // install) runs and never says "busy". A section therefore reads atomics.
    // When it has to look into the emulator itself it takes a `system_access`
    // and leaves those fields out when it does not get one.

    /// Remember the emulator. Call once at startup, before the first request.
    void diag_setup(emulator &state);

    /// Answers GET /v1/web/diag. Returns false for every other request.
    bool diag_route(const control::request &req, control::response &res);

    /// The emulator behind a lock that is only tried: boot, launch and close
    /// hold the same lock, and a diagnostics request must not wait for them.
    /// `sys` is null when the lock is taken elsewhere or nothing is booted.
    struct system_access {
        explicit system_access(emulator &state);
        ~system_access();

        system_access(const system_access &) = delete;
        system_access &operator=(const system_access &) = delete;

        explicit operator bool() const {
            return sys != nullptr;
        }

        system *sys = nullptr;

    private:
        std::recursive_mutex *held_ = nullptr;
    };

    // The sections. Each returns a JSON object; an empty one means the build
    // measures nothing there yet.
    control::json diag_speed(emulator &state);
    control::json diag_graphics(emulator &state);
    control::json diag_audio(emulator &state);
    control::json diag_exits(emulator &state);
}
