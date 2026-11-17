// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <cstdint>
#include <functional>
#include <string>

namespace eka2l1::web::persist {
    // The emulator works on an in-memory data tree; this mirrors the part of
    // it a visitor creates (the phone's memory, C:, with the saves) to the
    // origin's private file system (OPFS) so it survives a reload. The
    // installed firmware and the game card are left out: the page installs
    // them again each session from its own download cache, which is far
    // quicker than copying their thousands of files back from OPFS. Running
    // directly on OPFS is not an option: the ROM is memory-mapped, which that
    // backend does not support, and per-call proxying would slow every guest
    // file access.

    // Mounts persistent storage and copies a previous snapshot into `live_root`.
    // Returns false when storage is unavailable or empty. Call before the
    // emulator reads its data tree.
    bool restore(const std::string &live_root);

    // Starts the background mirror: copies files that changed since the last
    // pass, removes ones that disappeared, on request and every few seconds.
    // `on_pass` is called after each pass with the highest request ticket that
    // pass covers.
    void start(const std::string &live_root, std::function<void(std::uint64_t)> on_pass);

    // Asks for a pass now (after saves were imported, or when the page is
    // being hidden or left).
    // Returns a ticket; everything written before the call is stored once
    // `on_pass` reports that ticket or a later one. Zero when storage is off.
    std::uint64_t request_save();
}
