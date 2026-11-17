// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "engine.h"
#include "layer.h"

#include <common/algorithm.h>
#include <common/crypt.h>
#include <common/cvt.h>
#include <common/log.h>
#include <cpu/arm_interface.h>
#include <kernel/codeseg.h>
#include <kernel/kernel.h>
#include <kernel/process.h>
#include <kernel/thread.h>
#include <system/epoc.h>

#include <xxhash.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <map>

namespace eka2l1::enhance {
    using control::api_error;
    using control::json;

    // A frame with no end in sight (a profile without boundary hooks, or a
    // game that stopped presenting) must not grow without limit.
    static constexpr std::size_t MAX_FRAME_VERTICES = 300000;
    static constexpr int MAX_DRAW_VERTICES = 4096;
    static constexpr std::uint32_t MAX_TEXTURE_SIDE = 2048;
    static constexpr std::uint32_t MAX_PALETTE_STRIDE = 16;

    static std::uint32_t bytes_per_pixel(const texture_format format);

    static std::uint32_t to_u32(const double value) {
        return std::isfinite(value) ? static_cast<std::uint32_t>(static_cast<std::int64_t>(value)) : 0;
    }

    static bool read_guest(void *opaque, std::uint32_t addr, void *out, std::uint32_t size) {
        auto *pr = static_cast<kernel::process *>(opaque);
        auto *to = static_cast<std::uint8_t *>(out);

        while (size) {
            const std::uint32_t chunk = std::min<std::uint32_t>(size, 0x1000 - (addr & 0xFFF));
            const void *from = pr->get_ptr_on_addr_space(addr);
            if (!from) {
                return false;
            }

            std::memcpy(to, from, chunk);
            to += chunk;
            addr += chunk;
            size -= chunk;
        }

        return true;
    }

    static std::string base_name(const std::string &path) {
        const auto cut = path.find_last_of("\\/");
        return common::lowercase_string(cut == std::string::npos ? path : path.substr(cut + 1));
    }

    engine::engine(system *sys)
        : sys_(sys) {
    }

    engine &engine::of(system *sys) {
        static std::mutex guard_lock;
        static std::map<system *, std::unique_ptr<engine>> engines;

        const std::lock_guard<std::mutex> guard(guard_lock);
        auto &slot = engines[sys];
        if (!slot) {
            slot = std::make_unique<engine>(sys);
        }
        return *slot;
    }

    kernel_system *engine::kern() {
        return sys_->get_kernel_system();
    }

    void engine::set_sink(sink *target) {
        const std::lock_guard<std::mutex> guard(lock_);
        sink_ = target;
    }

    void engine::forget_frames() {
        current_.reset();
        last_.reset();

        if (sink_) {
            sink_->frame_complete(nullptr);
        }
    }

    void engine::complete_at_present() {
        const std::lock_guard<std::mutex> guard(lock_);
        if (current_ && !current_->draws.empty()) {
            publish();
        }
    }

    void engine::set_replace(const bool replace) {
        const std::lock_guard<std::mutex> guard(lock_);
        replace_ = replace;
    }

    std::shared_ptr<const frame> engine::last_frame() {
        const std::lock_guard<std::mutex> guard(lock_);
        return last_;
    }

    void engine::addresses_of(const std::string &image, const std::uint32_t hash, const std::uint32_t offset,
        std::vector<std::uint32_t> &addresses, std::vector<kernel::process *> &processes) {
        addresses.clear();
        processes.clear();

        if (image.empty()) {
            // An absolute address, in whichever process runs it.
            addresses.push_back(offset);
            processes.push_back(nullptr);
            return;
        }

        for (auto &object : kern()->get_codeseg_list()) {
            auto *seg = reinterpret_cast<kernel::codeseg *>(object.get());
            if (!seg) {
                continue;
            }

            if (base_name(seg->name()) != image && base_name(common::ucs2_to_utf8(seg->get_full_path())) != image) {
                continue;
            }

            if (hash && seg->get_hash() != hash) {
                continue;
            }

            if (offset >= seg->get_code_size()) {
                continue;
            }

            if (seg->is_rom()) {
                addresses.push_back(seg->get_code_run_addr(nullptr) + offset);
                processes.push_back(nullptr);
                continue;
            }

            for (kernel::process *pr : seg->attached_processes()) {
                const address base = pr ? seg->get_code_run_addr(pr) : 0;
                if (base) {
                    addresses.push_back(base + offset);
                    processes.push_back(pr);
                }
            }
        }
    }

    void engine::resolve() {
        targets_.clear();
        std::vector<kernel::process *> processes;

        for (std::size_t n = 0; n < debug_hooks_.size(); n++) {
            debug_hook &hook = debug_hooks_[n];
            addresses_of(hook.image, hook.hash, hook.offset, hook.addresses, processes);
            for (std::size_t a = 0; a < hook.addresses.size(); a++) {
                targets_[hook.addresses[a] & ~1U].push_back({ true, static_cast<std::uint32_t>(n), processes[a] });
            }
        }

        for (std::size_t n = 0; n < profile_hooks_.size(); n++) {
            profile_hook &hook = profile_hooks_[n];
            addresses_of(hook.image, hook.hash, hook.offset, hook.addresses, processes);
            for (std::size_t a = 0; a < hook.addresses.size(); a++) {
                targets_[hook.addresses[a] & ~1U].push_back({ false, static_cast<std::uint32_t>(n), processes[a] });
            }
        }

        kernel_system *k = kern();
        arm::core *cpu = k->get_cpu();
        if (!cpu) {
            return;
        }

        if (!callbacks_registered_) {
            callbacks_registered_ = true;

            // A game's code arrives after the profile was loaded, and goes
            // away with its process: look the addresses up again both times.
            k->register_codeseg_loaded_callback([this](const std::string &, kernel::process *, codeseg_ptr) {
                const std::lock_guard<std::mutex> guard(lock_);
                if (!debug_hooks_.empty() || !profile_hooks_.empty()) {
                    resolve();
                }
            });

            k->register_process_exit_callback([this](kernel::process *ended) {
                const std::lock_guard<std::mutex> guard(lock_);
                if (!debug_hooks_.empty() || !profile_hooks_.empty()) {
                    resolve();
                }

                // Its frames name memory that is gone.
                const std::uint32_t uid = ended ? ended->get_uid() : 0;
                if ((current_ && current_->process_uid == uid) || (last_ && !last_->injected && last_->process_uid == uid)) {
                    forget_frames();
                    has_target_ = false;
                }
            });
        }

        if (hooked_core_ != cpu) {
            hooked_core_ = cpu;
            cpu->hook_handler = [this](const std::uint32_t addr) {
                on_hook(addr);
            };
        }

        std::vector<address> all;
        all.reserve(targets_.size());
        for (const auto &[addr, list] : targets_) {
            all.push_back(addr);
        }

        if (!cpu->set_hooks(all) && !all.empty()) {
            LOG_WARN(KERNEL, "This CPU backend has no hooks; debug hooks and enhancement profiles need the interpreter (dyncom)");
        }
    }

    static void return_from_function(arm::core *cpu, const std::uint32_t lr) {
        std::uint32_t cpsr = cpu->get_cpsr();
        if (lr & 1) {
            cpsr |= 0x20;
        } else {
            cpsr &= ~0x20U;
        }

        cpu->set_cpsr(cpsr);
        cpu->set_pc(lr & ~1U);
    }

    void engine::on_hook(const std::uint32_t addr) {
        const std::lock_guard<std::mutex> guard(lock_);

        const auto found = targets_.find(addr & ~1U);
        if (found == targets_.end()) {
            return;
        }

        kernel_system *k = kern();
        kernel::process *pr = k->crr_process();
        arm::core *cpu = k->get_cpu();
        if (!pr || !cpu) {
            return;
        }

        eval_context ctx;
        bool filled = false;
        bool skip = false;
        bool has_ret = false;
        std::uint32_t ret = 0;

        for (const target &to : found->second) {
            if (to.process && to.process != pr) {
                continue;
            }

            if (!filled) {
                filled = true;
                for (int n = 0; n < 16; n++) {
                    ctx.regs[n] = cpu->get_reg(n);
                }
                ctx.regs[15] = addr;
                ctx.cpsr = cpu->get_cpsr();
                ctx.vars = &vars_;
                ctx.read = read_guest;
                ctx.opaque = pr;
            }

            ctx.fault = false;
            ctx.i = 0;
            ctx.p = 0;

            if (to.debug) {
                if (to.index < debug_hooks_.size()) {
                    run_debug(debug_hooks_[to.index], ctx, skip, ret, has_ret);
                }
            } else if (to.index < profile_hooks_.size()) {
                run_profile(profile_hooks_[to.index], static_cast<std::uint16_t>(to.index), ctx, pr, skip, ret, has_ret);
            }
        }

        if (skip) {
            if (has_ret) {
                cpu->set_reg(0, ret);
            }
            return_from_function(cpu, ctx.regs[14]);
        }
    }

    void engine::run_debug(debug_hook &hook, eval_context &ctx, bool &skip, std::uint32_t &ret, bool &has_ret) {
        hook.hits++;

        if (hook.captured.size() < hook.limit) {
            hit record;
            std::copy(std::begin(ctx.regs), std::end(ctx.regs), record.regs.begin());
            record.cpsr = ctx.cpsr;

            record.stack.resize(hook.stack_words);
            if (hook.stack_words && !read_guest(ctx.opaque, ctx.regs[13], record.stack.data(), hook.stack_words * 4)) {
                record.stack.clear();
            }

            for (const expr &watched : hook.watch) {
                ctx.fault = false;
                const double value = watched.eval(ctx);
                record.values.push_back(ctx.fault ? std::nan("") : value);
            }

            if (kernel::thread *thr = kern()->crr_thread()) {
                record.thread = thr->name();
            }

            hook.captured.push_back(std::move(record));
        }

        if (hook.skip) {
            skip = true;
            if (!hook.ret.empty()) {
                ctx.fault = false;
                ret = to_u32(hook.ret.eval(ctx));
                has_ret = true;
            }
        }
    }

    frame &engine::building(kernel::process *pr) {
        if (!current_) {
            current_ = std::make_unique<frame>();
            current_->number = ++frame_counter_;
            current_->process_uid = pr ? pr->get_uid() : 0;
            current_->width = viewport_width_;
            current_->height = viewport_height_;
            current_->has_target = has_target_;
            current_->target = target_;
            filled_ = 0;
            skipped_.clear();
        }

        return *current_;
    }

    void engine::publish() {
        if (!current_) {
            return;
        }

        std::shared_ptr<const frame> done(current_.release());
        last_ = done;

        if (sink_) {
            sink_->frame_complete(done);
        }
    }

    void engine::run_profile(profile_hook &hook, const std::uint16_t index, eval_context &ctx, kernel::process *pr,
        bool &skip, std::uint32_t &ret, bool &has_ret) {
        if (!hook.when.empty() && hook.when.eval(ctx) == 0) {
            return;
        }

        hook.hits++;

        switch (hook.kind) {
        case KIND_BEGIN: {
            // Without an end hook the start of a frame is also the end of the
            // one before it.
            if (!has_end_) {
                publish();
            } else {
                current_.reset();
            }

            frame &f = building(pr);
            if (hook.target.present) {
                f.target.pixels = to_u32(hook.target.pixels.eval(ctx));
                f.target.width = to_u32(hook.target.width.eval(ctx));
                f.target.height = to_u32(hook.target.height.eval(ctx));
                f.target.pitch = hook.target.pitch.empty() ? 0 : to_u32(hook.target.pitch.eval(ctx));
                f.target.format = hook.target.format;
                f.has_target = !ctx.fault && f.target.pixels && f.target.width && f.target.height
                    && f.target.width <= MAX_TEXTURE_SIDE && f.target.height <= MAX_TEXTURE_SIDE;
                if (ctx.fault) {
                    hook.faults++;
                }

                has_target_ = f.has_target;
                target_ = f.target;
            }
            break;
        }

        case KIND_END: {
            frame &f = building(pr);

            // The key colour goes in now, not when each function returned:
            // an engine that rasterises into a buffer of its own and copies
            // that to the target at the end of the frame (Shadowkey, Call of
            // Duty) would copy over it.
            if (f.has_target) {
                for (const auto &[first, count] : skipped_) {
                    if (first + count <= f.vertices.size()) {
                        key_pixels_ += fill_key(pr, f.target, f.vertices.data() + first, count);
                    }
                }
            }
            skipped_.clear();
            publish();
            break;
        }

        case KIND_SET:
            for (const auto &[slot, value] : hook.sets) {
                if (slot >= vars_.size()) {
                    vars_.resize(slot + 1, 0);
                }

                ctx.fault = false;
                const double result = value.eval(ctx);
                if (ctx.fault) {
                    hook.faults++;
                } else {
                    vars_[slot] = result;
                }
            }
            break;

        case KIND_DRAW:
            building(pr);
            run_draw(hook, index, ctx);
            break;
        }

        // Skipping makes sense only while something shows the triangles the
        // guest no longer draws: not when the layer is on but cannot draw.
        const bool layered = layer_ && layer_->enabled();
        if (hook.skip && replace_ && !(layered && layer_->failed())) {
            skip = true;
            if (!hook.ret.empty()) {
                ctx.fault = false;
                ret = to_u32(hook.ret.eval(ctx));
                has_ret = true;
            }

            // The guest will not draw what was captured since the last hook
            // that skipped (this hook's own triangles, or those of a draw hook
            // further up when the function skipped is the one that fills
            // them). Mark where they belong in its picture, so that what it
            // draws around and over them can be told from them.
            if (current_ && layered) {
                frame &f = *current_;
                if (f.has_target && f.vertices.size() > filled_) {
                    if (has_end_) {
                        skipped_.emplace_back(filled_, f.vertices.size() - filled_);
                    } else {
                        key_pixels_ += fill_key(pr, f.target, f.vertices.data() + filled_, f.vertices.size() - filled_);
                    }
                }
                filled_ = f.vertices.size();
            }
        }
    }

    void engine::run_draw(profile_hook &hook, const std::uint16_t index, eval_context &ctx) {
        frame &f = *current_;

        const int count = hook.count.empty() ? 3 : static_cast<int>(hook.count.eval(ctx));
        if (ctx.fault || count < 3 || count > MAX_DRAW_VERTICES) {
            hook.faults++;
            return;
        }

        const vertex_spec &fields = hook.fields;
        const bool separate_color = !fields.r.empty() || !fields.g.empty() || !fields.b.empty() || !fields.a.empty();
        auto channel = [&](const expr &source) -> std::uint32_t {
            return source.empty() ? 255U : static_cast<std::uint32_t>(std::clamp(source.eval(ctx), 0.0, 255.0));
        };

        scratch_.clear();
        for (int n = 0; n < count; n++) {
            ctx.i = n;
            ctx.p = hook.pointer.empty() ? 0 : hook.pointer.eval(ctx);

            vertex v;
            v.x = static_cast<float>(fields.x.eval(ctx));
            v.y = static_cast<float>(fields.y.eval(ctx));
            if (!fields.z.empty()) {
                v.z = static_cast<float>(fields.z.eval(ctx));
            }
            if (!fields.w.empty()) {
                v.w = static_cast<float>(fields.w.eval(ctx));
            }
            if (!fields.u.empty()) {
                v.u = static_cast<float>(fields.u.eval(ctx));
            }
            if (!fields.v.empty()) {
                v.v = static_cast<float>(fields.v.eval(ctx));
            }
            if (!fields.color.empty()) {
                v.color = to_u32(fields.color.eval(ctx));
            } else if (separate_color) {
                v.color = (channel(fields.a) << 24) | (channel(fields.r) << 16) | (channel(fields.g) << 8) | channel(fields.b);
            }

            if (!std::isfinite(v.x) || !std::isfinite(v.y) || !std::isfinite(v.z) || !std::isfinite(v.w)
                || !std::isfinite(v.u) || !std::isfinite(v.v)) {
                ctx.fault = true;
            }

            scratch_.push_back(v);
        }

        std::int32_t texture = -1;
        if (hook.texture.present) {
            ctx.i = 0;
            ctx.p = 0;

            texture_ref ref;
            ref.pixels = to_u32(hook.texture.pixels.eval(ctx));
            ref.id = hook.texture.id.empty() ? ref.pixels : to_u32(hook.texture.id.eval(ctx));
            ref.width = to_u32(hook.texture.width.eval(ctx));
            ref.height = to_u32(hook.texture.height.eval(ctx));
            ref.pitch = hook.texture.pitch.empty() ? 0 : to_u32(hook.texture.pitch.eval(ctx));
            ref.palette = hook.texture.palette.empty() ? 0 : to_u32(hook.texture.palette.eval(ctx));
            ref.format = hook.texture.format;
            ref.palette_format = hook.texture.palette_format;
            // The stride the palette is read with, so that the frame reports it.
            ref.palette_stride = (ref.format != FORMAT_P8 && ref.format != FORMAT_P4) ? 0
                : (hook.texture.palette_stride ? hook.texture.palette_stride : bytes_per_pixel(ref.palette_format));
            if (!hook.texture.key.empty()) {
                ref.has_key = true;
                ref.key = to_u32(hook.texture.key.eval(ctx));
            }

            // A draw without a texture (pixels null) is a plain coloured one.
            if (ref.pixels && ref.width && ref.height && ref.width <= MAX_TEXTURE_SIDE && ref.height <= MAX_TEXTURE_SIDE) {
                const auto known = std::find(f.textures.begin(), f.textures.end(), ref);
                texture = static_cast<std::int32_t>(known - f.textures.begin());
                if (known == f.textures.end()) {
                    f.textures.push_back(ref);
                }
            }
        }

        if (ctx.fault) {
            hook.faults++;
            return;
        }

        const std::size_t triangles = (hook.mode == MODE_TRIANGLES) ? static_cast<std::size_t>(count / 3)
                                                                    : static_cast<std::size_t>(count - 2);
        if (f.vertices.size() + triangles * 3 > MAX_FRAME_VERTICES) {
            dropped_draws_++;
            return;
        }

        const std::uint32_t first = static_cast<std::uint32_t>(f.vertices.size());
        for (std::size_t n = 0; n < triangles; n++) {
            switch (hook.mode) {
            case MODE_TRIANGLES:
                f.vertices.insert(f.vertices.end(), { scratch_[n * 3], scratch_[n * 3 + 1], scratch_[n * 3 + 2] });
                break;
            case MODE_FAN:
                f.vertices.insert(f.vertices.end(), { scratch_[0], scratch_[n + 1], scratch_[n + 2] });
                break;
            case MODE_STRIP:
                if (n & 1) {
                    f.vertices.insert(f.vertices.end(), { scratch_[n + 1], scratch_[n], scratch_[n + 2] });
                } else {
                    f.vertices.insert(f.vertices.end(), { scratch_[n], scratch_[n + 1], scratch_[n + 2] });
                }
                break;
            }
        }

        const std::uint32_t added = static_cast<std::uint32_t>(triangles * 3);
        if (!f.draws.empty()) {
            draw &last = f.draws.back();
            if (last.hook == index && last.texture == texture && last.blend == hook.blend && last.depth == hook.depth
                && last.first_vertex + last.vertex_count == first) {
                last.vertex_count += added;
                return;
            }
        }

        draw next;
        next.first_vertex = first;
        next.vertex_count = added;
        next.texture = texture;
        next.blend = hook.blend;
        next.depth = hook.depth;
        next.hook = index;
        f.draws.push_back(next);
    }

    static std::uint32_t bytes_per_pixel(const texture_format format) {
        switch (format) {
        case FORMAT_P8:
        case FORMAT_A8:
        case FORMAT_L8:
            return 1;
        case FORMAT_RGB444:
        case FORMAT_ARGB4444:
        case FORMAT_RGB565:
        case FORMAT_RGB555:
        case FORMAT_ARGB1555:
        case FORMAT_BGR555K:
            return 2;
        case FORMAT_RGB888:
            return 3;
        case FORMAT_ARGB8888:
        case FORMAT_XRGB8888:
            return 4;
        default:
            return 0;
        }
    }

    std::uint32_t pixel_size(const texture_format format) {
        return bytes_per_pixel(format);
    }

    // To 0xAABBGGRR, which is R, G, B, A in memory.
    static std::uint32_t to_rgba(const texture_format format, const std::uint32_t raw) {
        std::uint32_t r = 0, g = 0, b = 0, a = 255;

        switch (format) {
        case FORMAT_RGB444:
            r = ((raw >> 8) & 15) * 17;
            g = ((raw >> 4) & 15) * 17;
            b = (raw & 15) * 17;
            break;
        case FORMAT_ARGB4444:
            a = ((raw >> 12) & 15) * 17;
            r = ((raw >> 8) & 15) * 17;
            g = ((raw >> 4) & 15) * 17;
            b = (raw & 15) * 17;
            break;
        case FORMAT_RGB565:
            r = ((raw >> 11) & 31) * 255 / 31;
            g = ((raw >> 5) & 63) * 255 / 63;
            b = (raw & 31) * 255 / 31;
            break;
        case FORMAT_ARGB1555:
            a = (raw & 0x8000) ? 255 : 0;
            [[fallthrough]];
        case FORMAT_RGB555:
            r = ((raw >> 10) & 31) * 255 / 31;
            g = ((raw >> 5) & 31) * 255 / 31;
            b = (raw & 31) * 255 / 31;
            break;
        case FORMAT_ARGB8888:
            a = raw >> 24;
            [[fallthrough]];
        case FORMAT_RGB888:
        case FORMAT_XRGB8888:
            r = (raw >> 16) & 255;
            g = (raw >> 8) & 255;
            b = raw & 255;
            break;
        case FORMAT_BGR555K:
            a = (raw & 0xFFFF) ? 255 : 0;
            r = (raw & 31) * 255 / 31;
            g = ((raw >> 5) & 31) * 255 / 31;
            b = ((raw >> 10) & 31) * 255 / 31;
            break;
        case FORMAT_A8:
            r = g = b = 255;
            a = raw & 255;
            break;
        case FORMAT_L8:
            r = g = b = raw & 255;
            break;
        default:
            break;
        }

        return (a << 24) | (b << 16) | (g << 8) | r;
    }

    static std::uint32_t read_pixel(const std::uint8_t *from, const std::uint32_t size) {
        std::uint32_t raw = 0;
        std::memcpy(&raw, from, size);
        return raw;
    }

    static kernel::process *running_process(kernel_system *k, const std::uint32_t process_uid) {
        kernel::process *pr = nullptr;
        for (auto &object : k->get_process_list()) {
            auto *candidate = reinterpret_cast<kernel::process *>(object.get());
            if (candidate && candidate->get_uid() == process_uid
                && candidate->get_exit_type() == kernel::entity_exit_type::pending) {
                pr = candidate;
            }
        }

        return pr;
    }

    // Bytes a row of the texture takes; a four-bit texture packs two texels in a byte.
    static std::uint32_t row_bytes_of(const texture_ref &texture) {
        return (texture.format == FORMAT_P4) ? (texture.width + 1) / 2 : texture.width * bytes_per_pixel(texture.format);
    }

    static bool usable(const texture_ref &texture) {
        return (bytes_per_pixel(texture.format) || texture.format == FORMAT_P4) && texture.pixels && texture.width && texture.height
            && texture.width <= MAX_TEXTURE_SIDE && texture.height <= MAX_TEXTURE_SIDE;
    }

    bool engine::hash_locked(const std::uint32_t process_uid, const texture_ref &texture, std::uint64_t &hash) {
        kernel::process *pr = usable(texture) ? running_process(kern(), process_uid) : nullptr;
        if (!pr) {
            return false;
        }

        const std::uint32_t row = row_bytes_of(texture);
        const std::uint32_t pitch = texture.pitch ? texture.pitch : row;

        XXH64_state_t *state = XXH64_createState();
        XXH64_reset(state, 0);

        bool mapped = true;
        auto feed = [&](std::uint32_t addr, std::uint32_t length) {
            while (length && mapped) {
                const std::uint32_t chunk = std::min<std::uint32_t>(length, 0x1000 - (addr & 0xFFF));
                const void *from = pr->get_ptr_on_addr_space(addr);
                if (!from) {
                    mapped = false;
                    break;
                }

                XXH64_update(state, from, chunk);
                addr += chunk;
                length -= chunk;
            }
        };

        if (pitch == row) {
            feed(texture.pixels, row * texture.height);
        } else {
            for (std::uint32_t y = 0; y < texture.height && mapped; y++) {
                feed(texture.pixels + y * pitch, row);
            }
        }

        if ((texture.format == FORMAT_P8 || texture.format == FORMAT_P4) && texture.palette) {
            const std::uint32_t entry = bytes_per_pixel(texture.palette_format);
            const std::uint32_t stride = texture.palette_stride ? texture.palette_stride : entry;
            feed(texture.palette, ((texture.format == FORMAT_P4) ? 15 : 255) * stride + entry);
        }

        hash = XXH64_digest(state);
        XXH64_freeState(state);
        return mapped;
    }

    bool engine::decode(const std::uint32_t process_uid, const texture_ref &texture, std::vector<std::uint32_t> &rgba) {
        kernel_lock guard(kern());
        return decode_locked(process_uid, texture, rgba);
    }

    bool engine::decode_locked(const std::uint32_t process_uid, const texture_ref &texture, std::vector<std::uint32_t> &rgba) {
        // A four-bit texture is read a byte at a time and split below.
        const bool packed = (texture.format == FORMAT_P4);
        const bool paletted = packed || (texture.format == FORMAT_P8);
        const std::uint32_t size = packed ? 1 : bytes_per_pixel(texture.format);
        if (!usable(texture)) {
            return false;
        }

        kernel::process *pr = running_process(kern(), process_uid);
        if (!pr) {
            return false;
        }

        std::uint32_t palette[256] = {};
        if (paletted) {
            // An engine may keep its palette in wider entries than the
            // colour needs (12 bits in a 32-bit word): the stride says so.
            const std::uint32_t entry = bytes_per_pixel(texture.palette_format);
            const std::uint32_t stride = texture.palette_stride ? texture.palette_stride : entry;
            const std::uint32_t colours = packed ? 16 : 256;
            std::uint8_t raw[256 * MAX_PALETTE_STRIDE];
            if (!entry || texture.palette_format == FORMAT_P8 || texture.palette_format == FORMAT_P4 || !texture.palette
                || stride < entry || stride > MAX_PALETTE_STRIDE
                || !read_guest(pr, texture.palette, raw, (colours - 1) * stride + entry)) {
                return false;
            }

            for (std::uint32_t n = 0; n < colours; n++) {
                palette[n] = to_rgba(texture.palette_format, read_pixel(raw + n * stride, entry));
            }
        }

        const std::uint32_t row_bytes = packed ? (texture.width + 1) / 2 : texture.width * size;
        const std::uint32_t pitch = texture.pitch ? texture.pitch : row_bytes;
        if (pitch < row_bytes) {
            return false;
        }

        rgba.resize(std::size_t(texture.width) * texture.height);
        std::vector<std::uint8_t> row(row_bytes);

        for (std::uint32_t y = 0; y < texture.height; y++) {
            if (!read_guest(pr, texture.pixels + y * pitch, row.data(), static_cast<std::uint32_t>(row.size()))) {
                return false;
            }

            std::uint32_t *out = rgba.data() + std::size_t(y) * texture.width;
            for (std::uint32_t x = 0; x < texture.width; x++) {
                const std::uint32_t raw = packed ? ((row[x / 2] >> ((x & 1) * 4)) & 15U) : read_pixel(row.data() + x * size, size);
                std::uint32_t pixel = paletted ? palette[raw] : to_rgba(texture.format, raw);
                if (texture.has_key && raw == texture.key) {
                    pixel &= 0x00FFFFFF;
                }
                out[x] = pixel;
            }
        }

        return true;
    }

    static texture_format format_of(const json &value, const char *what, const bool required) {
        static const std::pair<const char *, texture_format> names[] = {
            { "p8", FORMAT_P8 }, { "rgb444", FORMAT_RGB444 }, { "argb4444", FORMAT_ARGB4444 },
            { "rgb565", FORMAT_RGB565 }, { "rgb555", FORMAT_RGB555 }, { "argb1555", FORMAT_ARGB1555 },
            { "rgb888", FORMAT_RGB888 }, { "argb8888", FORMAT_ARGB8888 }, { "xrgb8888", FORMAT_XRGB8888 },
            { "a8", FORMAT_A8 }, { "l8", FORMAT_L8 }, { "p4", FORMAT_P4 }, { "bgr555k", FORMAT_BGR555K }
        };

        if (value.is_null() && !required) {
            return FORMAT_NONE;
        }

        for (const auto &[name, format] : names) {
            if (value.string() == name) {
                return format;
            }
        }

        throw api_error(400, "bad_profile", std::string("unknown ") + what + " `" + value.string() + "`");
    }

    static expr compile_field(const json &value, name_table &names, const std::string &where) {
        if (value.is_null()) {
            return {};
        }

        const std::string text = value.is_string() ? value.string() : value.dump();
        try {
            return expr::compile(text, names);
        } catch (const std::exception &e) {
            throw api_error(400, "bad_profile", where + ": " + e.what());
        }
    }

    static expr required_field(const json &value, name_table &names, const std::string &where) {
        if (value.is_null()) {
            throw api_error(400, "bad_profile", where + " is required");
        }
        return compile_field(value, names, where);
    }

    static std::uint32_t number_of(const json &value, const std::string &where) {
        if (value.is_number() && value.number() >= 0 && value.number() <= 0xFFFFFFFFU) {
            return static_cast<std::uint32_t>(value.number());
        }

        if (value.is_string()) {
            try {
                return control::parse_uid(value.string());
            } catch (const api_error &) {
            }
        }

        throw api_error(400, "bad_request", where + " must be a number or a hexadecimal string");
    }

    void engine::clear_profile() {
        profile_name_.clear();
        profile_hooks_.clear();
        names_.names.clear();
        vars_.clear();
        has_begin_ = has_end_ = false;
        viewport_width_ = 176;
        viewport_height_ = 208;
        forget_frames();
        has_target_ = false;
        dropped_draws_ = 0;
        key_pixels_ = 0;
    }

    void engine::load_profile(const json &profile) {
        if (!profile["images"].is_array()) {
            throw api_error(400, "bad_profile", "`images` must be an array");
        }

        std::vector<profile_hook> hooks;
        name_table names;
        bool has_begin = false, has_end = false;

        for (const json &image : profile["images"].items()) {
            const std::string image_name = common::lowercase_string(control::required_string(image, "name"));
            const std::uint32_t hash = image["hash"].is_null() ? 0 : number_of(image["hash"], "image hash");
            if (!image["hooks"].is_array()) {
                throw api_error(400, "bad_profile", image_name + ": `hooks` must be an array");
            }

            for (const json &entry : image["hooks"].items()) {
                profile_hook hook;
                hook.image = image_name;
                hook.hash = hash;
                hook.offset = number_of(entry["at"], image_name + ": `at`");

                const std::string where = image_name + " at " + control::hex(hook.offset);
                const std::string kind = entry["do"].string();
                hook.when = compile_field(entry["when"], names, where + " when");
                hook.skip = entry["skip"].boolean();
                hook.ret = compile_field(entry["return"], names, where + " return");

                if (kind == "begin") {
                    hook.kind = KIND_BEGIN;
                    has_begin = true;

                    const json &target = entry["target"];
                    if (target.is_object()) {
                        hook.target.present = true;
                        hook.target.pixels = required_field(target["pixels"], names, where + " target.pixels");
                        hook.target.width = required_field(target["width"], names, where + " target.width");
                        hook.target.height = required_field(target["height"], names, where + " target.height");
                        hook.target.pitch = compile_field(target["pitch"], names, where + " target.pitch");
                        hook.target.format = format_of(target["format"], "target format", true);
                        if (hook.target.format == FORMAT_P8 || hook.target.format == FORMAT_P4) {
                            throw api_error(400, "bad_profile", where + ": a target cannot be paletted");
                        }
                    }
                } else if (kind == "end") {
                    hook.kind = KIND_END;
                    has_end = true;
                } else if (kind == "set") {
                    hook.kind = KIND_SET;
                    if (!entry["vars"].is_object()) {
                        throw api_error(400, "bad_profile", where + ": `vars` must be an object");
                    }
                    for (const auto &[name, value] : entry["vars"].members()) {
                        hook.sets.emplace_back(names.slot(name), required_field(value, names, where + " vars." + name));
                    }
                } else if (kind == "draw") {
                    hook.kind = KIND_DRAW;

                    const std::string mode = entry["mode"].string("triangles");
                    if (mode == "triangles") {
                        hook.mode = MODE_TRIANGLES;
                    } else if (mode == "fan") {
                        hook.mode = MODE_FAN;
                    } else if (mode == "strip") {
                        hook.mode = MODE_STRIP;
                    } else {
                        throw api_error(400, "bad_profile", where + ": unknown mode `" + mode + "`");
                    }

                    hook.count = compile_field(entry["count"], names, where + " count");
                    hook.pointer = compile_field(entry["vertex"], names, where + " vertex");

                    const json &fields = entry["fields"];
                    hook.fields.x = required_field(fields["x"], names, where + " fields.x");
                    hook.fields.y = required_field(fields["y"], names, where + " fields.y");
                    hook.fields.z = compile_field(fields["z"], names, where + " fields.z");
                    hook.fields.w = compile_field(fields["w"], names, where + " fields.w");
                    hook.fields.u = compile_field(fields["u"], names, where + " fields.u");
                    hook.fields.v = compile_field(fields["v"], names, where + " fields.v");
                    hook.fields.color = compile_field(fields["color"], names, where + " fields.color");
                    hook.fields.r = compile_field(fields["r"], names, where + " fields.r");
                    hook.fields.g = compile_field(fields["g"], names, where + " fields.g");
                    hook.fields.b = compile_field(fields["b"], names, where + " fields.b");
                    hook.fields.a = compile_field(fields["a"], names, where + " fields.a");

                    const json &texture = entry["texture"];
                    if (texture.is_object()) {
                        hook.texture.present = true;
                        hook.texture.pixels = required_field(texture["pixels"], names, where + " texture.pixels");
                        hook.texture.width = required_field(texture["width"], names, where + " texture.width");
                        hook.texture.height = required_field(texture["height"], names, where + " texture.height");
                        hook.texture.id = compile_field(texture["id"], names, where + " texture.id");
                        hook.texture.pitch = compile_field(texture["pitch"], names, where + " texture.pitch");
                        hook.texture.palette = compile_field(texture["palette"], names, where + " texture.palette");
                        hook.texture.key = compile_field(texture["key"], names, where + " texture.key");
                        hook.texture.format = format_of(texture["format"], "texture format", true);
                        const bool paletted = (hook.texture.format == FORMAT_P8) || (hook.texture.format == FORMAT_P4);
                        hook.texture.palette_format = format_of(texture["paletteFormat"], "palette format", paletted);
                        if (paletted && hook.texture.palette.empty()) {
                            throw api_error(400, "bad_profile", where + ": a paletted texture needs `palette`");
                        }

                        const json &stride = texture["paletteStride"];
                        if (!stride.is_null()) {
                            if (!paletted) {
                                throw api_error(400, "bad_profile", where + ": `paletteStride` belongs to a paletted texture");
                            }

                            const double value = stride.is_number() ? stride.number() : 0;
                            if (value != std::floor(value) || value < bytes_per_pixel(hook.texture.palette_format)
                                || value > MAX_PALETTE_STRIDE) {
                                throw api_error(400, "bad_profile", where + ": `paletteStride` must be a whole number from the size of a palette entry to 16");
                            }

                            hook.texture.palette_stride = static_cast<std::uint32_t>(value);
                        }
                    }

                    static const std::pair<const char *, blend_mode> blends[] = {
                        { "none", BLEND_NONE }, { "alpha", BLEND_ALPHA }, { "add", BLEND_ADD },
                        { "multiply", BLEND_MULTIPLY }, { "key", BLEND_KEY }, { "subtract", BLEND_SUBTRACT }
                    };
                    static const std::pair<const char *, depth_mode> depths[] = {
                        { "none", DEPTH_NONE }, { "less", DEPTH_LESS }, { "lequal", DEPTH_LEQUAL },
                        { "greater", DEPTH_GREATER }, { "gequal", DEPTH_GEQUAL }
                    };

                    const std::string blend = entry["blend"].string("none");
                    const auto blend_found = std::find_if(std::begin(blends), std::end(blends),
                        [&](const auto &pair) { return blend == pair.first; });
                    if (blend_found == std::end(blends)) {
                        throw api_error(400, "bad_profile", where + ": unknown blend `" + blend + "`");
                    }
                    hook.blend = blend_found->second;

                    const std::string depth = entry["depth"].string("none");
                    const auto depth_found = std::find_if(std::begin(depths), std::end(depths),
                        [&](const auto &pair) { return depth == pair.first; });
                    if (depth_found == std::end(depths)) {
                        throw api_error(400, "bad_profile", where + ": unknown depth `" + depth + "`");
                    }
                    hook.depth = depth_found->second;
                } else {
                    throw api_error(400, "bad_profile", where + ": `do` must be begin, end, draw or set");
                }

                hooks.push_back(std::move(hook));
            }
        }

        if (hooks.size() > 0xFFFF) {
            throw api_error(400, "bad_profile", "too many hooks");
        }

        clear_profile();
        profile_name_ = profile["engine"].string("unnamed");
        profile_hooks_ = std::move(hooks);
        names_ = std::move(names);
        vars_.assign(names_.names.size(), 0);
        has_begin_ = has_begin;
        has_end_ = has_end;

        const json &viewport = profile["viewport"];
        if (viewport.is_object()) {
            viewport_width_ = std::clamp<std::uint32_t>(number_of(viewport["width"], "viewport.width"), 1, MAX_TEXTURE_SIDE);
            viewport_height_ = std::clamp<std::uint32_t>(number_of(viewport["height"], "viewport.height"), 1, MAX_TEXTURE_SIDE);
        }
    }

    // Base64 to 0xAABBGGRR words (R, G, B, A bytes), which must be exactly `pixels` of them.
    static std::vector<std::uint32_t> pixels_of(const json &value, const std::size_t pixels, const std::string &where) {
        const std::size_t bytes = pixels * 4;
        const std::string text = value.is_string() ? value.string() : std::string();
        if (text.size() != (bytes + 2) / 3 * 4) {
            throw api_error(400, "bad_frame", where + ": `data` must be base64 of width times height times four bytes (R, G, B, A)");
        }

        std::vector<std::uint32_t> words(pixels);
        const std::size_t decoded = crypt::base64_decode(reinterpret_cast<const std::uint8_t *>(text.data()), text.size(),
            reinterpret_cast<char *>(words.data()), bytes);
        if (decoded != bytes) {
            throw api_error(400, "bad_frame", where + ": `data` is not base64");
        }

        return words;
    }

    static std::uint32_t side_of(const json &value, const std::string &where) {
        const std::uint32_t side = number_of(value, where);
        if (!side || side > MAX_TEXTURE_SIDE) {
            throw api_error(400, "bad_frame", where + " must be between 1 and " + std::to_string(MAX_TEXTURE_SIDE));
        }
        return side;
    }

    std::shared_ptr<frame> engine::parse_frame(const json &body) {
        static const std::pair<const char *, blend_mode> blends[] = {
            { "none", BLEND_NONE }, { "alpha", BLEND_ALPHA }, { "add", BLEND_ADD },
            { "multiply", BLEND_MULTIPLY }, { "key", BLEND_KEY }, { "subtract", BLEND_SUBTRACT }
        };
        static const std::pair<const char *, depth_mode> depths[] = {
            { "none", DEPTH_NONE }, { "less", DEPTH_LESS }, { "lequal", DEPTH_LEQUAL },
            { "greater", DEPTH_GREATER }, { "gequal", DEPTH_GEQUAL }
        };

        auto made = std::make_shared<frame>();
        frame &f = *made;
        f.injected = true;
        f.width = body["width"].is_null() ? 176 : side_of(body["width"], "`width`");
        f.height = body["height"].is_null() ? 208 : side_of(body["height"], "`height`");
        f.process_uid = body["process"].is_null() ? 0 : number_of(body["process"], "`process`");

        if (!body["vertices"].is_array() || body["vertices"].items().size() % 7
            || body["vertices"].items().size() / 7 > MAX_FRAME_VERTICES) {
            throw api_error(400, "bad_frame", "`vertices` must be an array of seven numbers a vertex: x, y, z, w, u, v, colour");
        }

        const json::array &numbers = body["vertices"].items();
        f.vertices.resize(numbers.size() / 7);
        for (std::size_t n = 0; n < f.vertices.size(); n++) {
            const json *at = numbers.data() + n * 7;
            for (int k = 0; k < 7; k++) {
                if (!at[k].is_number() || !std::isfinite(at[k].number())) {
                    throw api_error(400, "bad_frame", "`vertices` must hold finite numbers only");
                }
            }

            vertex &v = f.vertices[n];
            v.x = static_cast<float>(at[0].number());
            v.y = static_cast<float>(at[1].number());
            v.z = static_cast<float>(at[2].number());
            v.w = static_cast<float>(at[3].number());
            v.u = static_cast<float>(at[4].number());
            v.v = static_cast<float>(at[5].number());
            v.color = to_u32(at[6].number());
        }

        if (body["textures"].is_array()) {
            if (body["textures"].items().size() > 256) {
                throw api_error(400, "bad_frame", "at most 256 textures");
            }

            std::size_t n = 0;
            for (const json &entry : body["textures"].items()) {
                const std::string where = "texture " + std::to_string(n++);

                texture_ref ref;
                ref.width = side_of(entry["width"], where + ": `width`");
                ref.height = side_of(entry["height"], where + ": `height`");

                if (!entry["data"].is_null()) {
                    f.texture_pixels.push_back(pixels_of(entry["data"], std::size_t(ref.width) * ref.height, where));
                    ref.format = FORMAT_ARGB8888;
                } else {
                    // As GET /v1/enhance/frame gives it: in guest memory.
                    f.texture_pixels.emplace_back();
                    ref.pixels = number_of(entry["pixels"], where + ": `pixels`");
                    ref.id = entry["id"].is_null() ? ref.pixels : number_of(entry["id"], where + ": `id`");
                    ref.pitch = entry["pitch"].is_null() ? 0 : number_of(entry["pitch"], where + ": `pitch`");
                    ref.palette = entry["palette"].is_null() ? 0 : number_of(entry["palette"], where + ": `palette`");
                    ref.format = format_of(entry["format"], "texture format", true);
                    ref.palette_format = (entry["paletteFormat"].is_null() || entry["paletteFormat"].string() == "none")
                        ? FORMAT_NONE : format_of(entry["paletteFormat"], "palette format", false);
                    if (!entry["key"].is_null()) {
                        ref.has_key = true;
                        ref.key = number_of(entry["key"], where + ": `key`");
                    }
                }

                f.textures.push_back(ref);
            }
        }

        if (!body["draws"].is_array()) {
            throw api_error(400, "bad_frame", "`draws` must be an array");
        }

        for (const json &entry : body["draws"].items()) {
            draw d;
            d.first_vertex = number_of(entry["first"], "draw: `first`");
            d.vertex_count = number_of(entry["count"], "draw: `count`");
            if (d.vertex_count % 3 || std::uint64_t(d.first_vertex) + d.vertex_count > f.vertices.size()) {
                throw api_error(400, "bad_frame", "a draw's `count` must be a multiple of three and lie inside `vertices`");
            }

            const double texture = entry["texture"].number(-1);
            if (texture >= 0) {
                if (texture >= static_cast<double>(f.textures.size())) {
                    throw api_error(400, "bad_frame", "a draw names a texture the frame does not have");
                }
                d.texture = static_cast<std::int32_t>(texture);
            }

            const std::string blend = entry["blend"].string("none");
            const auto blend_found = std::find_if(std::begin(blends), std::end(blends),
                [&](const auto &pair) { return blend == pair.first; });
            const std::string depth = entry["depth"].string("none");
            const auto depth_found = std::find_if(std::begin(depths), std::end(depths),
                [&](const auto &pair) { return depth == pair.first; });
            if (blend_found == std::end(blends) || depth_found == std::end(depths)) {
                throw api_error(400, "bad_frame", "a draw has an unknown `blend` or `depth`");
            }

            d.blend = blend_found->second;
            d.depth = depth_found->second;
            f.draws.push_back(d);
        }

        const json &screen = body["screen"];
        if (screen.is_object()) {
            f.screen_width = side_of(screen["width"], "screen: `width`");
            f.screen_height = side_of(screen["height"], "screen: `height`");
            f.screen_pixels = pixels_of(screen["data"], std::size_t(f.screen_width) * f.screen_height, "screen");
        }

        return made;
    }

    void set_sink(system *sys, sink *target) {
        engine::of(sys).set_sink(target);
    }

    std::shared_ptr<const frame> last_frame(system *sys) {
        return engine::of(sys).last_frame();
    }

    void set_replace(system *sys, const bool replace) {
        engine::of(sys).set_replace(replace);
    }

    bool decode_texture(system *sys, const std::uint32_t process_uid, const texture_ref &texture, std::vector<std::uint32_t> &rgba) {
        return engine::of(sys).decode(process_uid, texture, rgba);
    }
}
