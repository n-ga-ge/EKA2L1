// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <common/types.h>

namespace eka2l1 {
    class io_system;
}

namespace eka2l1::epoc::fs {
    /**
     * @brief Put on Z: what a phone's factory image has there and a firmware dump can lack.
     *
     * Called once when the file server starts. See factory.cpp for what is supplied and why.
     */
    void supply_factory_settings(io_system *io, const epocver version);
}
