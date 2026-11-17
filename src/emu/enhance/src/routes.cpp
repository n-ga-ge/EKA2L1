// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "engine.h"
#include "layer.h"

#include <common/algorithm.h>
#include <common/cvt.h>
#include <cpu/arm_interface.h>
#include <kernel/codeseg.h>
#include <kernel/kernel.h>
#include <kernel/process.h>
#include <kernel/thread.h>
#include <system/epoc.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstring>
#include <thread>

namespace eka2l1::enhance {
    using control::api_error;
    using control::hex;
    using control::json;
    using control::request;
    using control::response;

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

    static std::uint32_t query_number(const request &req, const std::string &key, const std::uint32_t fallback, const bool required = false) {
        const std::string text = req.param(key);
        if (text.empty()) {
            if (required) {
                throw api_error(400, "bad_request", "`" + key + "` query parameter is required");
            }
            return fallback;
        }
        return control::parse_uid(text);
    }

    static const char *format_name(const texture_format format) {
        static const char *names[] = { "none", "p8", "rgb444", "argb4444", "rgb565", "rgb555", "argb1555",
            "rgb888", "argb8888", "xrgb8888", "a8", "l8", "p4", "bgr555k" };
        return names[format];
    }

    static response pixels_response(const std::uint32_t width, const std::uint32_t height, const std::vector<std::uint32_t> &rgba) {
        // Two little-endian words, width and height, then R, G, B, A bytes.
        std::string body(8 + rgba.size() * 4, '\0');
        std::memcpy(body.data(), &width, 4);
        std::memcpy(body.data() + 4, &height, 4);
        std::memcpy(body.data() + 8, rgba.data(), rgba.size() * 4);
        return { 200, "application/octet-stream", std::move(body), {} };
    }

    kernel::process *engine::process_of(const request &req, const json &body) {
        kernel_system *k = kern();

        std::uint32_t uid = 0;
        if (!req.param("process").empty()) {
            uid = control::parse_uid(req.param("process"));
        } else if (!body["process"].is_null()) {
            uid = number_of(body["process"], "`process`");
        }

        kernel::process *found = nullptr;
        if (uid) {
            for (auto &object : k->get_process_list()) {
                auto *candidate = reinterpret_cast<kernel::process *>(object.get());
                if (candidate && candidate->get_uid() == uid && candidate->get_exit_type() == kernel::entity_exit_type::pending) {
                    found = candidate;
                }
            }
        } else {
            found = k->crr_process();
        }

        if (!found) {
            throw api_error(404, "no_process", uid ? "no running process with UID " + hex(uid)
                                                    : "no process is running; pass `process` (a UID)");
        }

        return found;
    }

    json engine::codesegs() {
        json::array list;

        for (auto &object : kern()->get_codeseg_list()) {
            auto *seg = reinterpret_cast<kernel::codeseg *>(object.get());
            if (!seg) {
                continue;
            }

            json::array attaches;
            for (kernel::process *pr : seg->attached_processes()) {
                if (!pr) {
                    continue;
                }
                attaches.push_back({ { "process", pr->name() }, { "uid", hex(pr->get_uid()) },
                    { "code", hex(seg->get_code_run_addr(pr)) }, { "data", hex(seg->get_data_run_addr(pr)) } });
            }

            list.push_back({ { "name", seg->name() }, { "path", common::ucs2_to_utf8(seg->get_full_path()) },
                { "uid3", hex(std::get<2>(seg->get_uids())) }, { "hash", hex(seg->get_hash()) },
                { "rom", seg->is_rom() }, { "codeBase", hex(seg->get_code_base()) },
                { "codeSize", static_cast<std::int64_t>(seg->get_code_size()) },
                { "dataBase", hex(seg->get_data_base()) }, { "dataSize", static_cast<std::int64_t>(seg->get_data_size()) },
                { "bssSize", static_cast<std::int64_t>(seg->get_bss_size()) },
                { "exports", static_cast<std::int64_t>(seg->export_count()) },
                { "romCode", seg->is_rom() ? json(hex(seg->get_code_run_addr(nullptr))) : json(nullptr) },
                { "attaches", attaches } });
        }

        return list;
    }

    json engine::threads() {
        json::array list;
        kernel_system *k = kern();
        arm::core *cpu = k->get_cpu();
        kernel::thread *running = k->crr_thread();

        for (auto &object : k->get_thread_list()) {
            auto *thr = reinterpret_cast<kernel::thread *>(object.get());
            if (!thr) {
                continue;
            }

            json::array regs;
            std::uint32_t cpsr = 0;
            if (thr == running && cpu) {
                // The running thread's registers are in the core, not saved yet.
                for (int n = 0; n < 16; n++) {
                    regs.push_back(hex(cpu->get_reg(n)));
                }
                cpsr = cpu->get_cpsr();
            } else {
                const auto &ctx = thr->get_thread_context();
                for (int n = 0; n < 16; n++) {
                    regs.push_back(hex(ctx.cpu_registers[n]));
                }
                cpsr = ctx.cpsr;
            }

            kernel::process *owner = thr->owning_process();
            list.push_back({ { "name", thr->name() }, { "id", static_cast<std::int64_t>(thr->unique_id()) },
                { "process", owner ? json(owner->name()) : json(nullptr) },
                { "processUid", owner ? json(hex(owner->get_uid())) : json(nullptr) },
                { "state", static_cast<std::int64_t>(thr->current_state()) }, { "running", thr == running },
                { "regs", regs }, { "cpsr", hex(cpsr) } });
        }

        return list;
    }

    json engine::sample(const double milliseconds, const std::size_t limit) {
        arm::core *cpu = kern()->get_cpu();
        if (!cpu) {
            throw api_error(409, "no_device", "no device is booted");
        }

        // Read the program counter and the link register as fast as this
        // thread can, while the guest runs on its own. The reads race with the
        // interpreter, which is fine for a histogram.
        std::unordered_map<std::uint64_t, std::uint32_t> counts;
        std::uint64_t samples = 0;
        const auto until = std::chrono::steady_clock::now() + std::chrono::duration<double, std::milli>(milliseconds);

        while (std::chrono::steady_clock::now() < until) {
            for (int n = 0; n < 512; n++) {
                const std::uint64_t pc = cpu->get_pc();
                const std::uint64_t lr = cpu->get_lr();
                counts[(pc << 32) | lr]++;
                samples++;
            }
            std::this_thread::yield();
        }

        std::vector<std::pair<std::uint64_t, std::uint32_t>> sorted(counts.begin(), counts.end());
        std::sort(sorted.begin(), sorted.end(), [](const auto &a, const auto &b) { return a.second > b.second; });

        json::array top;
        for (std::size_t n = 0; n < sorted.size() && n < limit; n++) {
            top.push_back(json::array{ hex(static_cast<std::uint32_t>(sorted[n].first >> 32)),
                hex(static_cast<std::uint32_t>(sorted[n].first)), static_cast<std::int64_t>(sorted[n].second) });
        }

        return { { "samples", static_cast<std::int64_t>(samples) }, { "distinct", static_cast<std::int64_t>(sorted.size()) },
            { "columns", json::array{ "pc", "lr", "count" } }, { "top", top } };
    }

    json engine::debug_hook_json(const debug_hook &hook, const bool with_hits) {
        json::array addresses;
        for (const std::uint32_t addr : hook.addresses) {
            addresses.push_back(hex(addr));
        }

        json::array watch;
        for (const expr &watched : hook.watch) {
            watch.push_back(watched.text());
        }

        json value{ { "id", static_cast<std::int64_t>(hook.id) }, { "image", hook.image.empty() ? json(nullptr) : json(hook.image) },
            { "at", hex(hook.offset) }, { "addresses", addresses }, { "hits", static_cast<std::int64_t>(hook.hits) },
            { "limit", static_cast<std::int64_t>(hook.limit) }, { "skip", hook.skip }, { "watch", watch } };

        if (with_hits) {
            json::array hits;
            for (const hit &record : hook.captured) {
                json::array regs, stack, values;
                for (const std::uint32_t reg : record.regs) {
                    regs.push_back(hex(reg));
                }
                for (const std::uint32_t word : record.stack) {
                    stack.push_back(hex(word));
                }
                for (const double v : record.values) {
                    values.push_back(std::isfinite(v) ? json(v) : json(nullptr));
                }
                hits.push_back({ { "regs", regs }, { "cpsr", hex(record.cpsr) }, { "stack", stack },
                    { "values", values }, { "thread", record.thread } });
            }
            value["captured"] = hits;
        }

        return value;
    }

    json engine::status() {
        json::array hooks;
        for (const profile_hook &hook : profile_hooks_) {
            static const char *kinds[] = { "begin", "end", "draw", "set" };
            json::array addresses;
            for (const std::uint32_t addr : hook.addresses) {
                addresses.push_back(hex(addr));
            }
            hooks.push_back({ { "image", hook.image }, { "at", hex(hook.offset) }, { "do", kinds[hook.kind] },
                { "addresses", addresses }, { "hits", static_cast<std::int64_t>(hook.hits) },
                { "faults", static_cast<std::int64_t>(hook.faults) } });
        }

        bool active = false;
        for (const profile_hook &hook : profile_hooks_) {
            active = active || !hook.addresses.empty();
        }

        // The factor the layer draws at: a whole number unless it follows the
        // frontend's own scale.
        const double scale = layer_ ? static_cast<double>(layer_->scale_in_use()) : 0.0;
        const json scale_json = (scale == std::floor(scale)) ? json(static_cast<std::int64_t>(scale)) : json(scale);

        return { { "available", !profile_hooks_.empty() },
            { "engine", profile_hooks_.empty() ? json(nullptr) : json(profile_name_) },
            { "active", active }, { "replace", replace_ },
            { "scale", scale_json }, { "auto", layer_ && layer_->automatic() },
            { "filter", (layer_ && layer_->linear()) ? "linear" : "nearest" },
            { "composed", static_cast<std::int64_t>(layer_ ? layer_->composed() : 0) },
            { "presents", static_cast<std::int64_t>(layer_ ? layer_->presents() : 0) },
            { "cachedTextures", static_cast<std::int64_t>(layer_ ? layer_->cached_textures() : 0) },
            { "textureUploads", static_cast<std::int64_t>(layer_ ? layer_->uploads() : 0) },
            { "keyPixels", static_cast<std::int64_t>(key_pixels_) },
            { "layerFailed", layer_ && layer_->failed() },
            { "frames", static_cast<std::int64_t>(frame_counter_) },
            { "triangles", static_cast<std::int64_t>(last_ ? last_->vertices.size() / 3 : 0) },
            { "textures", static_cast<std::int64_t>(last_ ? last_->textures.size() : 0) },
            { "droppedDraws", static_cast<std::int64_t>(dropped_draws_) }, { "hooks", hooks } };
    }

    json engine::frame_json(const frame &f) {
        static const char *blends[] = { "none", "alpha", "add", "multiply", "key", "subtract" };
        static const char *depths[] = { "none", "less", "lequal", "greater", "gequal" };

        json::array vertices;
        vertices.reserve(f.vertices.size() * 7);
        for (const vertex &v : f.vertices) {
            vertices.push_back(static_cast<double>(v.x));
            vertices.push_back(static_cast<double>(v.y));
            vertices.push_back(static_cast<double>(v.z));
            vertices.push_back(static_cast<double>(v.w));
            vertices.push_back(static_cast<double>(v.u));
            vertices.push_back(static_cast<double>(v.v));
            vertices.push_back(static_cast<std::int64_t>(v.color));
        }

        json::array draws;
        for (const draw &d : f.draws) {
            draws.push_back({ { "first", static_cast<std::int64_t>(d.first_vertex) },
                { "count", static_cast<std::int64_t>(d.vertex_count) }, { "texture", static_cast<std::int64_t>(d.texture) },
                { "blend", blends[d.blend] }, { "depth", depths[d.depth] }, { "hook", static_cast<std::int64_t>(d.hook) } });
        }

        json::array textures;
        for (const texture_ref &t : f.textures) {
            textures.push_back({ { "id", hex(t.id) }, { "pixels", hex(t.pixels) },
                { "width", static_cast<std::int64_t>(t.width) }, { "height", static_cast<std::int64_t>(t.height) },
                { "pitch", static_cast<std::int64_t>(t.pitch) }, { "format", format_name(t.format) },
                { "palette", hex(t.palette) }, { "paletteFormat", format_name(t.palette_format) },
                { "paletteStride", static_cast<std::int64_t>(t.palette_stride) },
                { "key", t.has_key ? json(hex(t.key)) : json(nullptr) } });
        }

        json target = nullptr;
        if (f.has_target) {
            target = { { "pixels", hex(f.target.pixels) }, { "width", static_cast<std::int64_t>(f.target.width) },
                { "height", static_cast<std::int64_t>(f.target.height) }, { "pitch", static_cast<std::int64_t>(f.target.pitch) },
                { "format", format_name(f.target.format) } };
        }

        return { { "frame", static_cast<std::int64_t>(f.number) }, { "process", hex(f.process_uid) },
            { "width", static_cast<std::int64_t>(f.width) }, { "height", static_cast<std::int64_t>(f.height) },
            { "vertexLayout", json::array{ "x", "y", "z", "w", "u", "v", "color" } },
            { "vertices", vertices }, { "draws", draws }, { "textures", textures }, { "target", target } };
    }

    response engine::route(const request &req) {
        const auto &p = req.path;
        const std::string &method = req.method;
        const bool debug = p[1] == "debug";
        const std::string what = p.size() > 2 ? p[2] : std::string();

        if (debug && what == "codesegs" && method == "GET") {
            kernel_lock guard(kern());
            return response::from_json({ { "codesegs", codesegs() } });
        }

        if (debug && what == "threads" && method == "GET") {
            kernel_lock guard(kern());
            return response::from_json({ { "threads", threads() } });
        }

        if (debug && what == "mem" && method == "GET") {
            const std::uint32_t addr = query_number(req, "addr", 0, true);
            const std::uint32_t length = query_number(req, "len", 256);
            if (length > 16 * 1024 * 1024) {
                throw api_error(413, "too_large", "at most 16 MB at a time");
            }

            kernel_lock guard(kern());
            kernel::process *pr = process_of(req, json());

            // Unmapped pages read as zero; the header says how much was there.
            std::string body(length, '\0');
            std::uint32_t mapped = 0;
            for (std::uint32_t done = 0; done < length;) {
                const std::uint32_t chunk = std::min<std::uint32_t>(length - done, 0x1000 - ((addr + done) & 0xFFF));
                if (const void *from = pr->get_ptr_on_addr_space(addr + done)) {
                    std::memcpy(body.data() + done, from, chunk);
                    mapped += chunk;
                }
                done += chunk;
            }

            response res{ 200, "application/octet-stream", std::move(body), {} };
            res.headers["X-Mapped-Bytes"] = std::to_string(mapped);
            return res;
        }

        if (debug && what == "mem" && method == "PUT") {
            const json body = req.data();
            const std::uint32_t addr = number_of(body["addr"], "`addr`");
            const std::string text = control::required_string(body, "hex");
            if (text.size() % 2 || text.size() > 2 * 1024 * 1024) {
                throw api_error(400, "bad_request", "`hex` must be an even number of hexadecimal digits, at most 1 MB");
            }

            std::string bytes(text.size() / 2, '\0');
            for (std::size_t n = 0; n < bytes.size(); n++) {
                const std::string pair = text.substr(n * 2, 2);
                char *end = nullptr;
                bytes[n] = static_cast<char>(std::strtoul(pair.c_str(), &end, 16));
                if (end != pair.c_str() + 2) {
                    throw api_error(400, "bad_request", "`hex` has a character that is not a hexadecimal digit");
                }
            }

            kernel_lock guard(kern());
            kernel::process *pr = process_of(req, body);

            for (std::size_t done = 0; done < bytes.size();) {
                const std::uint32_t at = addr + static_cast<std::uint32_t>(done);
                const std::size_t chunk = std::min<std::size_t>(bytes.size() - done, 0x1000 - (at & 0xFFF));
                void *to = pr->get_ptr_on_addr_space(at);
                if (!to) {
                    throw api_error(422, "unmapped", "nothing is mapped at " + hex(at));
                }
                std::memcpy(to, bytes.data() + done, chunk);
                done += chunk;
            }

            return response::from_json({ { "written", static_cast<std::int64_t>(bytes.size()) } });
        }

        if (debug && what == "profile" && method == "POST") {
            const json body = req.data();
            const double milliseconds = body["ms"].number(1000);
            if (!std::isfinite(milliseconds) || milliseconds < 1 || milliseconds > 30000) {
                throw api_error(400, "bad_request", "`ms` must be between 1 and 30000");
            }
            return response::from_json(sample(milliseconds, static_cast<std::size_t>(std::clamp(body["limit"].number(400), 1.0, 20000.0))));
        }

        if (debug && what == "hooks") {
            if (method == "POST" && p.size() == 3) {
                const json body = req.data();

                debug_hook hook;
                hook.image = common::lowercase_string(body["image"].string());
                hook.hash = body["hash"].is_null() ? 0 : number_of(body["hash"], "`hash`");
                hook.offset = number_of(body["at"], "`at`");
                hook.limit = static_cast<std::uint32_t>(std::clamp(body["limit"].number(16), 0.0, 4096.0));
                hook.stack_words = static_cast<std::uint32_t>(std::clamp(body["stack"].number(0), 0.0, 256.0));
                hook.skip = body["skip"].boolean();

                name_table scratch_names;
                try {
                    if (!body["return"].is_null()) {
                        hook.ret = expr::compile(body["return"].is_string() ? body["return"].string() : body["return"].dump(), scratch_names);
                    }
                    if (body["watch"].is_array()) {
                        for (const json &watched : body["watch"].items()) {
                            hook.watch.push_back(expr::compile(watched.is_string() ? watched.string() : watched.dump(), scratch_names));
                        }
                    }
                } catch (const std::exception &e) {
                    throw api_error(400, "bad_request", e.what());
                }

                if (!scratch_names.names.empty()) {
                    throw api_error(400, "bad_request", "a debug hook cannot use profile variables ($name)");
                }

                kernel_lock guard(kern());
                const std::lock_guard<std::mutex> hooks(lock_);
                hook.id = next_debug_id_++;
                debug_hooks_.push_back(std::move(hook));
                resolve();
                return response::from_json(debug_hook_json(debug_hooks_.back(), false), 201);
            }

            if (method == "GET" && p.size() == 3) {
                const std::lock_guard<std::mutex> hooks(lock_);
                json::array list;
                for (const debug_hook &hook : debug_hooks_) {
                    list.push_back(debug_hook_json(hook, false));
                }
                return response::from_json({ { "hooks", list } });
            }

            if (method == "DELETE" && p.size() == 3) {
                kernel_lock guard(kern());
                const std::lock_guard<std::mutex> hooks(lock_);
                debug_hooks_.clear();
                resolve();
                return response::from_json({ { "hooks", json::array{} } });
            }

            if (p.size() == 4 && (method == "GET" || method == "DELETE")) {
                const std::uint32_t id = control::parse_uid(p[3]);

                if (method == "DELETE") {
                    kern()->lock();
                }

                struct unlock_kernel {
                    kernel_system *k;
                    ~unlock_kernel() {
                        if (k) {
                            k->unlock();
                        }
                    }
                } release{ method == "DELETE" ? kern() : nullptr };

                const std::lock_guard<std::mutex> hooks(lock_);
                const auto found = std::find_if(debug_hooks_.begin(), debug_hooks_.end(),
                    [id](const debug_hook &hook) { return hook.id == id; });
                if (found == debug_hooks_.end()) {
                    throw api_error(404, "not_found", "no such hook");
                }

                const json value = debug_hook_json(*found, true);
                if (method == "DELETE") {
                    debug_hooks_.erase(found);
                    resolve();
                }
                return response::from_json(value);
            }
        }

        if (!debug && p.size() == 2 && method == "GET") {
            const std::lock_guard<std::mutex> hooks(lock_);
            return response::from_json(status());
        }

        if (!debug && p.size() == 2 && method == "PATCH") {
            const json body = req.data();

            if (!body["replace"].is_null() && !body["replace"].is_boolean()) {
                throw api_error(400, "bad_request", "`replace` must be boolean");
            }

            const json &wanted = body["scale"];
            bool automatic = false;
            std::uint32_t scale = 0;
            if (wanted.is_string() && wanted.string() == "auto") {
                automatic = true;
            } else if (wanted.is_number() && wanted.number() >= 0 && wanted.number() <= 8 && wanted.number() == std::floor(wanted.number())) {
                scale = static_cast<std::uint32_t>(wanted.number());
            } else if (!wanted.is_null()) {
                throw api_error(400, "bad_request", "`scale` must be a whole number from 0 to 8, or \"auto\"");
            }

            const std::string filter = body["filter"].string();
            if (!body["filter"].is_null() && filter != "nearest" && filter != "linear") {
                throw api_error(400, "bad_request", "`filter` must be \"nearest\" or \"linear\"");
            }

            kernel_lock guard(kern());

            layer *drawing = nullptr;
            {
                const std::lock_guard<std::mutex> hooks(lock_);
                if (!wanted.is_null()) {
                    // The layer shows what the guest no longer draws itself.
                    replace_ = automatic || scale != 0;
                }
                if (!body["replace"].is_null()) {
                    replace_ = body["replace"].boolean();
                }
                if (!wanted.is_null() || !body["filter"].is_null()) {
                    drawing = &the_layer();
                }
            }

            // Not under the lock above: the layer takes its own, and a present
            // on the guest's thread takes them in the other order.
            if (drawing && !body["filter"].is_null()) {
                drawing->set_linear(filter == "linear");
            }
            if (drawing && !wanted.is_null()) {
                drawing->configure(scale, automatic);
            }

            const std::lock_guard<std::mutex> hooks(lock_);
            return response::from_json(status());
        }

        if (!debug && what == "test-frame" && (method == "POST" || method == "DELETE")) {
            std::shared_ptr<frame> injected = (method == "POST") ? parse_frame(req.data()) : nullptr;

            kernel_lock guard(kern());

            layer *drawing = nullptr;
            {
                const std::lock_guard<std::mutex> hooks(lock_);
                if (!injected) {
                    // Only the injected frame goes; one being captured stays.
                    if (last_ && last_->injected) {
                        last_.reset();
                        if (sink_) {
                            sink_->frame_complete(nullptr);
                        }
                    }
                    return response::from_json(status());
                }

                drawing = &the_layer();
                if (!drawing->enabled()) {
                    throw api_error(409, "layer_off", "the layer is off; switch it on first with PATCH /v1/enhance { \"scale\": 4 }");
                }

                injected->number = ++frame_counter_;
                last_ = injected;
            }

            drawing->inject(injected);

            const std::lock_guard<std::mutex> hooks(lock_);
            return response::from_json(status(), 201);
        }

        if (!debug && what == "profile" && (method == "PUT" || method == "DELETE")) {
            const json body = (method == "PUT") ? req.data() : json(json::object{});

            kernel_lock guard(kern());
            const std::lock_guard<std::mutex> hooks(lock_);
            if (method == "PUT") {
                load_profile(body);
            } else {
                clear_profile();
            }
            resolve();
            return response::from_json(status());
        }

        if (!debug && what == "frame" && method == "GET") {
            std::shared_ptr<const frame> shown;
            {
                const std::lock_guard<std::mutex> hooks(lock_);
                // A profile without boundary hooks never completes a frame by
                // itself: hand out what gathered since the last request.
                if (!has_begin_ && !has_end_ && current_ && !current_->draws.empty()) {
                    publish();
                }
                shown = last_;
            }

            if (!shown) {
                throw api_error(404, "no_frame", "no frame was captured yet");
            }
            return response::from_json(frame_json(*shown));
        }

        if (!debug && (what == "texture" || what == "target") && method == "GET") {
            std::shared_ptr<const frame> shown;
            {
                const std::lock_guard<std::mutex> hooks(lock_);
                shown = last_;
            }

            if (!shown) {
                throw api_error(404, "no_frame", "no frame was captured yet");
            }

            texture_ref wanted;
            if (what == "texture") {
                const std::uint32_t index = query_number(req, "index", 0, true);
                if (index >= shown->textures.size()) {
                    throw api_error(404, "not_found", "the frame has no such texture");
                }
                wanted = shown->textures[index];
            } else {
                if (!shown->has_target) {
                    throw api_error(404, "not_found", "the profile describes no target");
                }
                wanted.pixels = shown->target.pixels;
                wanted.width = shown->target.width;
                wanted.height = shown->target.height;
                wanted.pitch = shown->target.pitch;
                wanted.format = shown->target.format;
            }

            std::vector<std::uint32_t> rgba;
            if (!decode(shown->process_uid, wanted, rgba)) {
                throw api_error(422, "unreadable", "the pixels could not be read from guest memory");
            }
            return pixels_response(wanted.width, wanted.height, rgba);
        }

        throw api_error(404, "not_found", "unknown endpoint; see GET /v1");
    }

    bool handle_request(system *sys, const request &req, response &res) {
        const auto &p = req.path;
        if (p.size() < 2 || p[0] != "v1" || (p[1] != "debug" && p[1] != "enhance")) {
            return false;
        }

        if (!sys || !sys->get_kernel_system()) {
            throw api_error(503, "not_ready", "emulator has not started");
        }

        res = engine::of(sys).route(req);
        return true;
    }
}
