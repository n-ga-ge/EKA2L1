// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <enhance/enhance.h>

#include <drivers/graphics/common.h>
#include <services/window/screen.h>

#include <atomic>
#include <cstdint>
#include <memory>
#include <mutex>
#include <vector>

namespace eka2l1::drivers {
    class graphics_command_builder;
    class graphics_driver;
}

namespace eka2l1::enhance {
    class engine;

    /**
     * Draws captured frames with the graphics driver and puts them into the
     * picture a screen shows.
     *
     * It is the capture machine's sink, and the compositor of every screen
     * while it is switched on. When the guest presents its screen, the screen
     * texture is drawn again, at the layer's scale, in three steps:
     *
     *  1. where the guest's picture has the key colour, the nearest pixel
     *     that has not (the game's background under the 3D);
     *  2. the frame's triangles, only on pixels with the key colour in them;
     *  3. the guest's picture once more where triangles may have drawn but
     *     the pixel is not the key colour itself: a pixel the game mixed with
     *     the key colour, next to pixels in it, lets that much of the
     *     triangles through (the soft edge of an overlay).
     *
     * Every other pixel keeps what the screen's own copy put there, so the
     * window server's drawing over the game stays.
     *
     * Everything is issued as one command list through
     * `drivers::graphics_command_builder`, the same way the OpenGL ES
     * dispatch issues a guest's geometry.
     */
    class layer : public sink, public epoc::screen_compositor {
    public:
        layer(system *sys, engine &owner);

        /**
         * Switch the layer on at a whole multiple of the screen's size, or at
         * the frontend's own scale (`automatic`), or off (`scale` zero). With
         * the kernel lock held.
         */
        void configure(std::uint32_t scale, bool automatic);
        void set_linear(bool linear);

        bool enabled();
        // Whether it tried to draw and cannot (no OpenGL, a shader that does
        // not compile, a screen it does not handle).
        bool failed();
        bool automatic();
        bool linear();
        // The scale the screen texture has while the layer draws; zero when off.
        float scale_in_use();

        std::uint64_t composed();
        std::uint64_t presents();
        std::size_t cached_textures();
        std::uint64_t uploads();

        /**
         * Show a frame that was not captured, at once. With the kernel lock
         * held and the capture machine's not.
         */
        void inject(const std::shared_ptr<const frame> &injected);

        void frame_complete(const std::shared_ptr<const frame> &completed) override;

        float screen_scale(epoc::screen *scr, float usual) override;
        bool compose(epoc::screen *scr, drivers::graphics_driver *driver, kernel_system *kern) override;
        bool compose_redrawn(epoc::screen *scr, drivers::graphics_driver *driver) override;

    private:
        struct cached_texture {
            texture_ref ref;
            std::uint32_t process_uid = 0;
            // Zero for a guest texture; the frame's number for an inline one.
            std::uint64_t inline_frame = 0;
            std::uint32_t inline_index = 0;

            drivers::handle handle = 0;
            // A texture with palette rows: `handle` holds its texel indices,
            // this its table.
            drivers::handle table = 0;
            std::uint64_t hash = 0;
            std::uint64_t last_used = 0;
            std::uint64_t last_checked = 0;
            std::size_t bytes = 0;
            bool linear = false;
            bool filter_set = false;
        };

        system *sys_;
        engine &engine_;

        // Guards the settings and the frame. Taken after the capture
        // machine's lock, never before it.
        std::mutex lock_;
        std::uint32_t scale_ = 0;
        bool automatic_ = false;
        bool linear_ = false;
        std::shared_ptr<const frame> shown_;
        float scale_in_use_ = 0;
        // Presents left for which the screen keeps the layer's scale.
        std::uint32_t keep_ = 0;
        std::uint64_t composed_ = 0;
        std::uint64_t presents_ = 0;
        std::uint64_t uploads_ = 0;
        std::size_t cache_size_ = 0;

        bool reset_callback_added_ = false;

        // Everything below is only touched with the kernel lock held.
        drivers::graphics_driver *driver_ = nullptr;
        drivers::handle triangle_program_ = 0;
        drivers::handle compose_program_ = 0;
        drivers::handle vertex_buffer_ = 0;
        drivers::handle input_layout_ = 0;
        int texture_loc_ = -1, mode_loc_ = -1, triangle_screen_loc_ = -1, view_loc_ = -1, table_loc_ = -1;
        int screen_loc_ = -1, params_loc_ = -1;
        bool resources_failed_ = false;
        std::atomic<bool> broken_{ false };

        std::vector<cached_texture> cache_;
        std::size_t cache_bytes_ = 0;
        std::uint64_t pass_ = 0;

        // The picture of an injected frame that stands in for the guest's.
        drivers::handle screen_texture_ = 0;
        std::uint64_t screen_texture_frame_ = 0;

        std::vector<std::uint8_t> vertex_data_;

        bool wanted();
        void attach(bool on);
        bool ensure_resources(drivers::graphics_driver *driver);
        void drop_textures(drivers::graphics_command_builder *builder);
        void prepare_textures(drivers::graphics_command_builder &builder, const frame &f, bool linear,
            std::vector<drivers::handle> &handles, std::vector<drivers::handle> &tables);
        bool render(epoc::screen *scr, drivers::graphics_driver *driver, const std::shared_ptr<const frame> &shown, bool linear,
            bool from_screen = false);
        bool compose_picture(epoc::screen *scr, drivers::graphics_driver *driver, bool from_screen);

        // A 1x copy of the screen texture, the picture when the guest shows
        // its frames through the window server.
        drivers::handle screen_copy_ = 0;
        eka2l1::vec2 screen_copy_size_;
    };
}
