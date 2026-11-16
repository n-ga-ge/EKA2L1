// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <drivers/graphics/context.h>

namespace eka2l1::drivers::graphics {
    // WebGL2 (GLES3) context on a canvas of the page. window_system_info's
    // render_surface carries the canvas' CSS selector as a C string; when the
    // emulator runs off the main thread the canvas has been transferred to the
    // graphics thread as an OffscreenCanvas before this is constructed.
    class gl_context_web final : public gl_context {
    private:
        int handle_ = 0;

    public:
        explicit gl_context_web(const window_system_info &wsi, bool stereo, bool core);
        ~gl_context_web() override;

        bool make_current() override;
        bool clear_current() override;

        void swap_buffers() override;
        void update(const std::uint32_t new_width, const std::uint32_t new_height) override;
        void set_swap_interval(const std::int32_t interval) override;

        bool is_headless() const override;

        std::unique_ptr<gl_context> create_shared_context() override;
    };
}
