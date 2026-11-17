// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "exits" section of GET /v1/web/diag (web/diag.h).

#include <web/diag.h>
#include <web/state.h>

#include <common/webdiag/exits.h>

namespace eka2l1::web {
    control::json diag_exits(emulator &state) {
        (void)state;
        return control::json(control::json::object{});
    }
}
