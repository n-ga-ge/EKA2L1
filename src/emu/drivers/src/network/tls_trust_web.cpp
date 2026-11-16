// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "tls_trust.h"

namespace eka2l1::drivers {
    // A web page cannot read the host's trust store, and raw sockets are not
    // available to the guest anyway, so no chain is ever accepted.
    bool verify_system_certificate(const tls_certificate_chain &, const std::string &) {
        return false;
    }
}
