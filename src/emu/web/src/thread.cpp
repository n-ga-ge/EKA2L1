// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <web/diag_exits.h>
#include <web/state.h>

#include <common/log.h>
#include <common/thread.h>
#include <common/webdiag/exits.h>
#include <drivers/audio/audio.h>
#include <drivers/graphics/graphics.h>
#include <system/devices.h>

#include <emscripten.h>
#include <emscripten/html5.h>
#include <emscripten/threading.h>
#include <pthread.h>

#include <chrono>
#include <cstdlib>
#include <stdexcept>
#include <thread>

namespace eka2l1::web {
    static void *graphics_thread_entry(void *userdata) {
        emulator &state = *reinterpret_cast<emulator *>(userdata);

        common::set_thread_name("Graphics thread");

        // The canvas was transferred to this thread as an OffscreenCanvas; the
        // context factory looks it up by selector.
        drivers::window_system_info wsi;
        wsi.type = drivers::window_system_type::headless;
        wsi.render_surface = const_cast<char *>(state.canvas_selector.c_str());

        state.graphics_driver = drivers::create_graphics_driver(drivers::graphic_api::opengl, wsi);
        state.symsys->set_graphics_driver(state.graphics_driver.get());

        int width = 0, height = 0;
        emscripten_get_canvas_element_size(state.canvas_selector.c_str(), &width, &height);
        state.surface_size = eka2l1::vec2(width, height);
        state.graphics_driver->update_surface_size(state.surface_size);

        state.graphics_driver->set_display_hook([&state]() {
            state.frames.fetch_add(1, std::memory_order_relaxed);

            // Resize requests from the page are applied here, on the thread
            // that owns the canvas, and take effect with the next frame.
            const int width = state.wanted_width.exchange(0);
            const int height = state.wanted_height.exchange(0);
            if (width > 0 && height > 0 && (width != state.surface_size.x || height != state.surface_size.y)) {
                emscripten_set_canvas_element_size(state.canvas_selector.c_str(), width, height);
                state.surface_size = eka2l1::vec2(width, height);
                state.graphics_driver->update_surface_size(state.surface_size);
            }

            if (state.wanted_shader_pending.exchange(false)) {
                std::string shader;
                {
                    const std::lock_guard<std::mutex> guard(state.wanted_shader_lock);
                    shader = state.wanted_shader;
                }
                // An empty name puts the driver's plain shader back: a
                // screen that locks its scale factor draws through the
                // upscale program even when the page chose none, and would
                // otherwise keep showing the last shader chosen.
                state.graphics_driver->set_upscale_shader(shader);
                state.use_upscale_shader = !shader.empty();
            }
        });

        state.has_surface = (width > 0) && (height > 0);
        LOG_INFO(FRONTEND_CMDLINE, "Graphics thread ready, surface {}x{}", width, height);

        state.graphics_init_done.set();

        // Runs until the driver is aborted.
        state.graphics_driver->run();
        return nullptr;
    }

    void emulator::start_graphics_thread() {
        if (canvas_selector.empty() || graphics_driver) {
            return;
        }

        graphics_init_done.reset();

        pthread_attr_t attr;
        pthread_attr_init(&attr);
        pthread_attr_setdetachstate(&attr, PTHREAD_CREATE_DETACHED);
        // Hand the page's canvas over to the graphics thread.
        emscripten_pthread_attr_settransferredcanvases(&attr, canvas_selector.c_str());

        pthread_t thread;
        const int result = pthread_create(&thread, &attr, graphics_thread_entry, this);
        pthread_attr_destroy(&attr);

        if (result != 0) {
            LOG_ERROR(FRONTEND_CMDLINE, "Unable to start the graphics thread ({})", result);
            return;
        }

        graphics_init_done.wait();
    }

    static void os_thread_entry(emulator &state) {
        common::set_thread_name("Symbian OS thread");

        while (!state.should_emu_quit) {
            // Nothing runs the guest after an exception here, so the page
            // is told: without that it would show a game that stands still.
            try {
                if (webdiag::exits.debug_stop.load(std::memory_order_relaxed) != 0) {
                    // A test asked for it (POST /v1/web/diag/stop).
                    const int how = webdiag::exits.debug_stop.exchange(0);
                    if (how == 2) {
                        std::abort();
                    }
                    while (how == 3) {
                        std::this_thread::sleep_for(std::chrono::seconds(1));
                    }
                    throw std::runtime_error("stopped by POST /v1/web/diag/stop");
                }

                state.symsys->loop();
            } catch (std::exception &exc) {
                LOG_ERROR(FRONTEND_CMDLINE, "Main loop exited with exception: {}", exc.what());
                state.should_emu_quit = true;
                exits_emulator_stopped(exc.what());
                break;
            } catch (...) {
                LOG_ERROR(FRONTEND_CMDLINE, "Main loop exited with an exception of an unknown kind");
                state.should_emu_quit = true;
                exits_emulator_stopped("an exception of an unknown kind");
                break;
            }

            webdiag::exits.loop_turns.fetch_add(1, std::memory_order_relaxed);

            if (state.should_emu_pause) {
                state.symsys->pause();
                state.pause_sema.wait();
                state.symsys->unpause();
            }
        }
    }

    void emulator::start_os_thread() {
        if (!os_thread) {
            os_thread = std::make_unique<std::thread>(os_thread_entry, std::ref(*this));
        }
    }

    bool emulator::boot_device(int index) {
        if (control_backend) {
            control_backend->reset_session();
        }

        if (!os_thread) {
            symsys->startup();
        }

        if (!symsys->set_device(static_cast<std::uint8_t>(index))) {
            return false;
        }

        conf.device = index;
        conf.serialize();

        if (!stage_two_inited) {
            symsys->mount_device_drives();
            on_system_reset(symsys.get());

            if (!stage_two()) {
                return false;
            }

            start_os_thread();
        }

        return true;
    }

    void emulator::close_session() {
        if (control_backend) {
            control_backend->reset_session();
        }

        if (symsys && stage_two_inited) {
            symsys->reset();
        }
    }
}
