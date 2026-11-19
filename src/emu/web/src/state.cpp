// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <web/diag_exits.h>
#include <web/state.h>

#include <common/algorithm.h>
#include <common/fileutils.h>
#include <common/log.h>
#include <common/path.h>
#include <common/version.h>
#include <dispatch/libraries/register.h>
#include <drivers/audio/audio.h>
#include <drivers/graphics/graphics.h>
#include <drivers/itc.h>
#include <package/manager.h>

#include <system/devices.h>

#include <kernel/kernel.h>
#include <kernel/libmanager.h>

#include <services/bluetooth/protocols/web/overall_web.h>
#include <services/init.h>
#include <services/window/screen.h>
#include <services/window/window.h>

namespace eka2l1::web {
    void emulator::register_draw_callback() {
        if (!winserv) {
            return;
        }

        eka2l1::epoc::screen *screens = winserv->get_screens();
        while (screens) {
            std::size_t change_handle = screens->add_screen_redraw_callback(this, [](void *userdata, eka2l1::epoc::screen *scr, const bool is_dsa) {
                emulator *state_ptr = reinterpret_cast<emulator *>(userdata);
                if (!state_ptr->graphics_driver || !state_ptr->has_surface) {
                    return;
                }

                // Wait for the previous present, so frames are not queued
                // faster than the page can show them.
                state_ptr->graphics_driver->wait_for(&state_ptr->present_status);

                drivers::graphics_command_builder builder;
                state_ptr->draw(builder, scr);

                state_ptr->present_status = -100;
                builder.present(&state_ptr->present_status);

                drivers::command_list retrieved = builder.retrieve_command_list();
                state_ptr->graphics_driver->submit_command_list(retrieved);
            });

            screen_change_handles.push_back(change_handle);
            screens = screens->next;
        }
    }

    void emulator::draw(drivers::graphics_command_builder &builder, epoc::screen *scr) {
        const eka2l1::vec2 swapchain_size = surface_size;

        eka2l1::rect viewport;
        viewport.size = swapchain_size;

        builder.set_swapchain_size(swapchain_size);

        builder.backup_state();
        builder.bind_bitmap(0);

        builder.set_feature(drivers::graphics_feature::cull, false);
        builder.set_feature(drivers::graphics_feature::depth_test, false);
        builder.set_feature(drivers::graphics_feature::blend, false);
        builder.set_feature(drivers::graphics_feature::clipping, false);
        builder.set_feature(drivers::graphics_feature::stencil_test, false);
        builder.set_viewport(viewport);

        builder.clear({ 0.0f, 0.0f, 0.0f, 1.0f, 0.0f, 0.0f }, drivers::draw_buffer_bit_color_buffer);

        if (scr) {
            auto &crr_mode = scr->current_mode();

            eka2l1::rect src;
            eka2l1::rect dest;

            const eka2l1::vec2 size = crr_mode.size;
            src.size = size;

            // The page gives the canvas the shape of the guest screen and
            // lets CSS place it, so the guest picture fills the whole surface
            // while keeping its aspect ratio.
            float width = static_cast<float>(swapchain_size.x);
            float height = static_cast<float>(size.y) * width / static_cast<float>(size.x);

            if (height > static_cast<float>(swapchain_size.y)) {
                height = static_cast<float>(swapchain_size.y);
                width = static_cast<float>(size.x) * height / static_cast<float>(size.y);
            }

            // The page rounds the canvas to whole pixels, so one side of the
            // fitted picture can come out a fraction of a pixel short of the
            // canvas. The picture then takes the whole canvas: cut down to a
            // whole number it left a row or column of the canvas undrawn.
            if (static_cast<float>(swapchain_size.x) - width < 1.0f) {
                width = static_cast<float>(swapchain_size.x);
            }

            if (static_cast<float>(swapchain_size.y) - height < 1.0f) {
                height = static_cast<float>(swapchain_size.y);
            }

            const int x = static_cast<int>((swapchain_size.x - width) / 2);
            const int y = static_cast<int>((swapchain_size.y - height) / 2);

            const float scale_x = width / static_cast<float>(size.x);
            const float scale_y = height / static_cast<float>(size.y);

            if (use_upscale_shader) {
                // A scaling shader chosen on the page does all of the
                // enlarging, so the screen stays at the guest's own size.
                // Otherwise the window server keeps the screen at the size of
                // the canvas (see below) and a shader is handed a picture that
                // is enlarged already: it then runs at a scale of one, where
                // the pixel-art scalers find nothing to do. The factors still
                // say where a pointer position on the canvas is on the screen.
                scr->logic_scale_factor_x = scale_x;
                scr->logic_scale_factor_y = scale_y;
                // The 3D of an enhanced game is the exception: the GPU layer
                // draws it at its own scale, and the shader enlarges that.
                float own = 1.0f;
                if (epoc::screen_compositor *const composing = scr->compositor.load()) {
                    own = composing->screen_scale(scr, own);
                }
                scr->try_change_display_rescale(symsys->get_graphics_driver(), own);
            } else {
                // The window server draws the screen at the size it is shown
                // at: text and shapes at full detail, the bitmaps a game draws
                // enlarged with the texture filter. A game that writes to the
                // screen directly locks the factor to one by itself.
                scr->set_native_scale_factor(symsys->get_graphics_driver(), scale_x, scale_y);
            }

            scr->absolute_pos.x = x;
            scr->absolute_pos.y = y;

            dest.top = eka2l1::vec2(x, y);
            dest.size = eka2l1::vec2(static_cast<int>(width), static_cast<int>(height));

            drivers::advance_draw_pos_around_origin(dest, scr->ui_rotation);

            if (scr->ui_rotation % 180 != 0) {
                std::swap(dest.size.x, dest.size.y);
                std::swap(src.size.x, src.size.y);
            }

            src.size *= scr->display_scale_factor;

            std::uint32_t flags = 0;
            if (use_upscale_shader || (scr->flags_ & epoc::screen::FLAG_SCREEN_UPSCALE_FACTOR_LOCK)) {
                flags |= drivers::bitmap_draw_flag_use_upscale_shader;
            }

            const drivers::filter_option filter = conf.nearest_neighbor_filtering ? drivers::filter_option::nearest : drivers::filter_option::linear;

            builder.set_texture_filter(scr->screen_texture, true, filter);
            builder.set_texture_filter(scr->screen_texture, false, filter);
            // A texture repeats unless told otherwise. Enlarged with linear
            // filtering, or read by a shader that looks at the neighbours of
            // a pixel, the screen would then have the opposite edge blended
            // into its outermost rows and columns.
            builder.set_texture_addressing_mode(scr->screen_texture, drivers::addressing_direction::s, drivers::addressing_option::clamp_to_edge);
            builder.set_texture_addressing_mode(scr->screen_texture, drivers::addressing_direction::t, drivers::addressing_option::clamp_to_edge);
            builder.draw_bitmap(scr->screen_texture, 0, dest, src, eka2l1::vec2(0, 0),
                static_cast<float>(scr->ui_rotation), flags);
        }

        builder.load_backup_state();
    }

    void emulator::on_system_reset(system *the_sys) {
        winserv = reinterpret_cast<eka2l1::window_server *>(the_sys->get_kernel_system()->get_by_name<service::server>(
            eka2l1::get_winserv_name_by_epocver(symsys->get_symbian_version_use())));

        if (stage_two_inited) {
            register_draw_callback();
            the_sys->initialize_user_parties();
        }

        // Diagnostics: how the guest's threads end.
        exits_watch(the_sys);

        // Multiplayer: an N-Gage game looks at the phone's Bluetooth switch
        // before it hosts or joins.
        if (the_sys->get_kernel_system()->is_eka1()) {
            epoc::bt::web::switch_bluetooth_on(the_sys->get_io_system());
        }
    }

    void emulator::stage_one() {
        log::setup_log(nullptr);
        // There is no terminal; stdout goes to the browser console.
        if (!log::is_console_enabled()) {
            log::toggle_console();
        }

        const bool first_run = !common::exists("config.yml");
        conf.deserialize();

        if (first_run) {
            // Every log line is forwarded to the page's console, which is far
            // more expensive than a terminal. Keep the default quiet; the page
            // can raise it through PATCH /v1/config (logFilter).
            conf.log_filter = "*:warn";
        }

        if (log::filterings) {
            log::filterings->parse_filter_string(conf.log_filter);
        }

        LOG_INFO(FRONTEND_CMDLINE, "EKA2L1 web ({}-{})", GIT_BRANCH, GIT_COMMIT_HASH);

        app_settings = std::make_unique<config::app_settings>(&conf);

        system_create_components comp;
        comp.audio_ = nullptr;
        comp.graphics_ = nullptr;
        comp.conf_ = &conf;
        comp.settings_ = app_settings.get();

        symsys = std::make_unique<eka2l1::system>(comp);

        device_manager *dvcmngr = symsys->get_device_manager();

        if (dvcmngr->total() > 0) {
            symsys->startup();

            if (!symsys->set_device(conf.device)) {
                LOG_ERROR(FRONTEND_CMDLINE, "Device index {} in the config is out of range, using the first device", conf.device);

                conf.device = 0;
                symsys->rescan_devices(drive_z);
                symsys->set_device(0);
            }

            symsys->mount_device_drives();
            on_system_reset(symsys.get());
        }

        system_reset_cbh = symsys->add_system_reset_callback([this](system *the_sys) {
            on_system_reset(the_sys);
        });

        stage_two_inited = false;
    }

    bool emulator::stage_two() {
        if (stage_two_inited) {
            return true;
        }

        device_manager *dvcmngr = symsys->get_device_manager();
        device *dvc = dvcmngr->get_current();

        if (!dvc) {
            LOG_ERROR(FRONTEND_CMDLINE, "No current device is available. Stage two initialisation abort");
            return false;
        }

        LOG_INFO(FRONTEND_CMDLINE, "Device being used: {} ({})", dvc->model, dvc->firmware_code);

        symsys->mount(drive_z, drive_media::rom,
            eka2l1::add_path(conf.storage, "/drives/z/"), io_attrib_internal | io_attrib_write_protected);

        drivers::player_type player_be = drivers::player_type_tsf;
        if (conf.midi_backend == config::MIDI_BACKEND_MINIBAE) {
            player_be = drivers::player_type_minibae;
        }

        if (!audio_driver) {
            audio_driver = drivers::make_audio_driver(drivers::audio_driver_backend::cubeb, conf.audio_master_volume, player_be);
        }

        if (audio_driver) {
            audio_driver->set_bank_path(drivers::MIDI_BANK_TYPE_HSB, conf.hsb_bank_path);
            audio_driver->set_bank_path(drivers::MIDI_BANK_TYPE_SF2, conf.sf2_bank_path);
        }

        symsys->set_audio_driver(audio_driver.get());

        sensor_driver = drivers::sensor_driver::instantiate();
        symsys->set_sensor_driver(sensor_driver.get());

        symsys->initialize_user_parties();

        manager::packages *pkgmngr = symsys->get_packages();
        pkgmngr->load_registries();
        pkgmngr->migrate_legacy_registries();

        register_draw_callback();

        stage_two_inited = true;
        return true;
    }

    void emulator::press_key(int scancode, bool down) {
        if (!winserv) {
            return;
        }

        drivers::input_event evt;
        evt.type_ = drivers::input_event_type::key_raw;
        evt.key_.state_ = down ? drivers::key_state::pressed : drivers::key_state::released;
        evt.key_.code_ = scancode;
        winserv->queue_input_from_driver(evt);
    }

    void emulator::touch(int x, int y, int action, int pointer_id) {
        if (!winserv) {
            return;
        }

        drivers::input_event evt;
        evt.type_ = drivers::input_event_type::touch;
        evt.mouse_.pos_x_ = x;
        evt.mouse_.pos_y_ = y;
        evt.mouse_.pos_z_ = 0;
        evt.mouse_.mouse_id = static_cast<std::uint32_t>(pointer_id);
        evt.mouse_.button_ = drivers::mouse_button::mouse_button_left;
        evt.mouse_.action_ = static_cast<drivers::mouse_action>(action);
        evt.mouse_.raw_screen_pos_ = false;
        winserv->queue_input_from_driver(evt);
    }
}
