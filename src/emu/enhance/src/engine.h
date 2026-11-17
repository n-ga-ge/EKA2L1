// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <control/api.h>
#include <enhance/enhance.h>
#include <enhance/expr.h>

#include <array>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace eka2l1 {
    class kernel_system;

    namespace arm {
        class core;
    }

    namespace kernel {
        class process;
    }
}

namespace eka2l1::enhance {
    // What one hit of a debug hook recorded.
    struct hit {
        std::array<std::uint32_t, 16> regs;
        std::uint32_t cpsr;
        std::vector<std::uint32_t> stack;
        std::vector<double> values;
        std::string thread;
    };

    // A hook set by hand over the control API, to look at a function.
    struct debug_hook {
        std::uint32_t id = 0;
        std::string image;
        std::uint32_t hash = 0;
        std::uint32_t offset = 0;
        std::uint32_t limit = 16;
        std::uint32_t stack_words = 0;
        bool skip = false;
        expr ret;
        std::vector<expr> watch;

        std::uint64_t hits = 0;
        std::vector<hit> captured;
        std::vector<std::uint32_t> addresses;
    };

    struct vertex_spec {
        expr x, y, z, w, u, v, color, r, g, b, a;
    };

    struct texture_spec {
        bool present = false;
        expr id, pixels, width, height, pitch, palette, key;
        texture_format format = FORMAT_NONE;
        texture_format palette_format = FORMAT_NONE;
        std::uint32_t palette_stride = 0;
    };

    struct target_spec {
        bool present = false;
        expr pixels, width, height, pitch;
        texture_format format = FORMAT_NONE;
    };

    enum hook_kind : std::uint8_t {
        KIND_BEGIN,
        KIND_END,
        KIND_DRAW,
        KIND_SET
    };

    enum draw_mode : std::uint8_t {
        MODE_TRIANGLES,
        MODE_FAN,
        MODE_STRIP
    };

    // One hook of the loaded profile.
    struct profile_hook {
        std::string image;
        std::uint32_t hash = 0;
        std::uint32_t offset = 0;
        hook_kind kind = KIND_DRAW;
        expr when;

        draw_mode mode = MODE_TRIANGLES;
        expr count;
        expr pointer;
        vertex_spec fields;
        texture_spec texture;
        blend_mode blend = BLEND_NONE;
        depth_mode depth = DEPTH_NONE;
        bool skip = false;
        expr ret;

        std::vector<std::pair<std::uint32_t, expr>> sets;
        target_spec target;

        std::uint64_t hits = 0;
        std::uint64_t faults = 0;
        std::vector<std::uint32_t> addresses;
    };

    class engine {
    public:
        explicit engine(system *sys);

        static engine &of(system *sys);

        control::response route(const control::request &req);

        void set_sink(sink *target);
        void set_replace(bool replace);
        std::shared_ptr<const frame> last_frame();
        bool decode(std::uint32_t process_uid, const texture_ref &texture, std::vector<std::uint32_t> &rgba);

    private:
        // Where a hooked address leads: a debug hook or a profile hook, for
        // the process the code is loaded in.
        struct target {
            bool debug;
            std::uint32_t index;
            kernel::process *process;
        };

        system *sys_;
        std::mutex lock_;

        arm::core *hooked_core_ = nullptr;
        bool callbacks_registered_ = false;

        std::vector<debug_hook> debug_hooks_;
        std::uint32_t next_debug_id_ = 1;

        std::string profile_name_;
        std::vector<profile_hook> profile_hooks_;
        name_table names_;
        std::vector<double> vars_;
        std::uint32_t viewport_width_ = 176, viewport_height_ = 208;
        bool has_begin_ = false, has_end_ = false;

        std::unordered_map<std::uint32_t, std::vector<target>> targets_;

        std::unique_ptr<frame> current_;
        std::shared_ptr<const frame> last_;
        std::uint64_t frame_counter_ = 0;
        std::uint64_t dropped_draws_ = 0;
        std::vector<vertex> scratch_;

        bool replace_ = false;
        sink *sink_ = nullptr;

        kernel_system *kern();

        // Both need the kernel lock and lock_ held.
        void resolve();
        void addresses_of(const std::string &image, std::uint32_t hash, std::uint32_t offset,
            std::vector<std::uint32_t> &addresses, std::vector<kernel::process *> &processes);

        void on_hook(std::uint32_t addr);
        void run_debug(debug_hook &hook, eval_context &ctx, bool &skip, std::uint32_t &ret, bool &has_ret);
        void run_profile(profile_hook &hook, std::uint16_t index, eval_context &ctx, kernel::process *pr,
            bool &skip, std::uint32_t &ret, bool &has_ret);
        void run_draw(profile_hook &hook, std::uint16_t index, eval_context &ctx);
        frame &building(kernel::process *pr);
        void publish();

        void load_profile(const control::json &profile);
        void clear_profile();

        kernel::process *process_of(const control::request &req, const control::json &body);
        control::json codesegs();
        control::json threads();
        control::json sample(double milliseconds, std::size_t limit);
        control::json debug_hook_json(const debug_hook &hook, bool with_hits);
        control::json status();
        control::json frame_json(const frame &f);
    };
}
