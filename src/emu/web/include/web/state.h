// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#pragma once

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <common/sync.h>
#include <common/vecx.h>
#include <config/app_settings.h>
#include <config/config.h>
#include <control/native.h>
#include <control/service.h>
#include <drivers/sensor/sensor.h>
#include <system/epoc.h>

namespace eka2l1 {
    class window_server;

    namespace drivers {
        class graphics_driver;
        class audio_driver;
        class graphics_command_builder;
    }

    namespace epoc {
        struct screen;
    }
}

namespace eka2l1::web {
    // State of the emulator in the browser. Same shape as the Android frontend:
    // a graphics thread owning the WebGL context and an OS thread running the
    // guest, with the page driving both through the control API.
    struct emulator {
        std::unique_ptr<system> symsys;
        std::unique_ptr<drivers::graphics_driver> graphics_driver;
        std::unique_ptr<drivers::audio_driver> audio_driver;
        std::unique_ptr<drivers::sensor_driver> sensor_driver;
        std::unique_ptr<config::app_settings> app_settings;

        config::state conf;
        window_server *winserv = nullptr;

        std::atomic<bool> should_emu_quit{ false };
        std::atomic<bool> should_emu_pause{ false };
        std::atomic<bool> stage_two_inited{ false };
        std::atomic<bool> has_surface{ false };
        std::atomic<std::uint64_t> frames{ 0 };

        common::semaphore pause_sema;
        common::event graphics_init_done;

        std::vector<std::size_t> screen_change_handles;
        std::size_t system_reset_cbh = 0;
        int present_status = 0;

        // Canvas the graphics thread renders to, and its backing size in pixels.
        std::string canvas_selector;
        eka2l1::vec2 surface_size{ 0, 0 };

        // Size the page asked for; the graphics thread, which owns the canvas,
        // applies it before the next present. Zero means no request.
        std::atomic<int> wanted_width{ 0 };
        std::atomic<int> wanted_height{ 0 };

        // Draw the guest screen through the driver's upscale shader instead of
        // plain nearest/linear filtering. The page's choice is handed to the
        // graphics thread the same way as the size.
        std::atomic<bool> use_upscale_shader{ false };
        std::mutex wanted_shader_lock;
        std::string wanted_shader;
        std::atomic<bool> wanted_shader_pending{ false };

        std::unique_ptr<std::thread> os_thread;

        // Serializes control requests with boot/launch/close.
        std::recursive_mutex control_mutex;
        std::shared_ptr<control::native_backend> control_backend;
        std::unique_ptr<control::service> control_service;

        void stage_one();
        bool stage_two();

        void on_system_reset(system *the_sys);
        void register_draw_callback();
        void draw(drivers::graphics_command_builder &builder, epoc::screen *scr);

        void start_graphics_thread();
        void start_os_thread();
        bool boot_device(int index);
        void close_session();

        void press_key(int scancode, bool down);
        void touch(int x, int y, int action, int pointer_id);
    };
}
