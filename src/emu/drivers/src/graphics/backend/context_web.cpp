// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "context_web.h"

#include <common/log.h>

#include <emscripten/html5.h>

namespace eka2l1::drivers::graphics {
    gl_context_web::gl_context_web(const window_system_info &wsi, bool, bool) {
        m_opengl_mode = mode::opengl_es;

        const char *target = static_cast<const char *>(wsi.render_surface);
        if (!target) {
            return;
        }

        EmscriptenWebGLContextAttributes attrs;
        emscripten_webgl_init_context_attributes(&attrs);
        attrs.majorVersion = 2;
        attrs.minorVersion = 0;
        attrs.alpha = false;
        attrs.depth = true;
        attrs.stencil = true;
        attrs.antialias = false;
        attrs.premultipliedAlpha = false;
        attrs.preserveDrawingBuffer = false;
        // Frames are shown when the graphics thread returns to its event loop
        // (see ogl_graphics_driver::run), which is the only way a browser
        // presents an OffscreenCanvas.
        attrs.explicitSwapControl = false;
        attrs.renderViaOffscreenBackBuffer = false;

        handle_ = static_cast<int>(emscripten_webgl_create_context(target, &attrs));
        if (handle_ <= 0) {
            LOG_ERROR(DRIVER_GRAPHICS, "Unable to create a WebGL2 context on {} (error {})", target, handle_);
            handle_ = 0;
            return;
        }

        make_current();

        int width = 0, height = 0;
        emscripten_webgl_get_drawing_buffer_size(handle_, &width, &height);
        m_backbuffer_width = static_cast<std::uint32_t>(width);
        m_backbuffer_height = static_cast<std::uint32_t>(height);
    }

    gl_context_web::~gl_context_web() {
        if (handle_) {
            emscripten_webgl_make_context_current(0);
            emscripten_webgl_destroy_context(handle_);
        }
    }

    bool gl_context_web::make_current() {
        return handle_ && (emscripten_webgl_make_context_current(handle_) == EMSCRIPTEN_RESULT_SUCCESS);
    }

    bool gl_context_web::clear_current() {
        return emscripten_webgl_make_context_current(0) == EMSCRIPTEN_RESULT_SUCCESS;
    }

    void gl_context_web::swap_buffers() {
        // Nothing to do: the browser presents the canvas when the thread yields.
    }

    void gl_context_web::update(const std::uint32_t new_width, const std::uint32_t new_height) {
        m_backbuffer_width = new_width;
        m_backbuffer_height = new_height;
    }

    void gl_context_web::set_swap_interval(const std::int32_t) {
        // Presentation is paced by the browser's compositor.
    }

    bool gl_context_web::is_headless() const {
        return handle_ == 0;
    }

    std::unique_ptr<gl_context> gl_context_web::create_shared_context() {
        // WebGL has no context sharing.
        return nullptr;
    }
}
