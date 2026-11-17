// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// GET /v1/web/diag: see web/diag.h.

#include <web/diag.h>
#include <web/state.h>

#include <chrono>

namespace eka2l1::web {
    namespace {
        emulator *the_emulator = nullptr;
        std::chrono::steady_clock::time_point started;
    }

    void diag_setup(emulator &state) {
        the_emulator = &state;
        started = std::chrono::steady_clock::now();
    }

    system_access::system_access(emulator &state) {
        if (!state.control_mutex.try_lock()) {
            return;
        }

        held_ = &state.control_mutex;
        sys = state.symsys.get();
    }

    system_access::~system_access() {
        if (held_) {
            held_->unlock();
        }
    }

    bool diag_route(const control::request &req, control::response &res) {
        if (req.path != std::vector<std::string>{ "v1", "web", "diag" }) {
            return false;
        }

        if (req.method != "GET") {
            res = control::response::error(405, "method_not_allowed", "only GET is supported");
            return true;
        }

        if (!the_emulator) {
            res = control::response::error(503, "not_ready", "the emulator has not started");
            return true;
        }

        const auto uptime = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::steady_clock::now() - started);

        res = control::response::from_json({
            { "v", 1 },
            { "uptimeMs", static_cast<double>(uptime.count()) },
            { "speed", diag_speed(*the_emulator) },
            { "graphics", diag_graphics(*the_emulator) },
            { "audio", diag_audio(*the_emulator) },
            { "exits", diag_exits(*the_emulator) },
        });

        return true;
    }
}
