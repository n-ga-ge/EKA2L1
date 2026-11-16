// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Entry point and page bridge of the browser frontend.
//
// The emulator runs entirely off the browser's main thread (PROXY_TO_PTHREAD):
// main() below executes on a worker, brings the emulator up, and then serves as
// the control dispatcher. The page talks to it through the same control API the
// other frontends expose over loopback HTTP, here carried by direct calls:
//
//   page  -> eka2l1_web_request(id, method, target, body, len)
//   page <-  Module.eka2l1OnResponse(id, status, contentType, bodyBytes)
//
// Input has its own direct entry points so key presses are not queued behind a
// long-running request.

#include <web/persist.h>
#include <web/state.h>

#include <common/fileutils.h>
#include <common/log.h>
#include <control/api.h>
#include <drivers/audio/audio.h>
#include <drivers/audio/backend/web/audio_web.h>
#include <drivers/graphics/graphics.h>
#include <system/devices.h>

#include <emscripten.h>
#include <emscripten/threading.h>

#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <filesystem>

using namespace eka2l1;

namespace {
    struct pending_request {
        int id;
        control::request request;
    };

    web::emulator state;

    std::mutex queue_mutex;
    std::condition_variable queue_signal;
    std::deque<pending_request> queue;

    std::string url_decode(const std::string &text) {
        std::string out;
        out.reserve(text.size());

        for (std::size_t i = 0; i < text.size(); i++) {
            if (text[i] == '%' && i + 2 < text.size() && std::isxdigit(static_cast<unsigned char>(text[i + 1]))
                && std::isxdigit(static_cast<unsigned char>(text[i + 2]))) {
                out.push_back(static_cast<char>(std::strtol(text.substr(i + 1, 2).c_str(), nullptr, 16)));
                i += 2;
            } else if (text[i] == '+') {
                out.push_back(' ');
            } else {
                out.push_back(text[i]);
            }
        }

        return out;
    }

    // "/v1/files?path=docs:/a" -> path segments and query map.
    void parse_target(const std::string &target, control::request &req) {
        const std::size_t question = target.find('?');
        const std::string path = target.substr(0, question);

        std::size_t start = 0;
        while (start < path.size()) {
            std::size_t end = path.find('/', start);
            if (end == std::string::npos) {
                end = path.size();
            }
            if (end > start) {
                req.path.push_back(url_decode(path.substr(start, end - start)));
            }
            start = end + 1;
        }

        if (question == std::string::npos) {
            return;
        }

        const std::string query = target.substr(question + 1);
        start = 0;
        while (start < query.size()) {
            std::size_t end = query.find('&', start);
            if (end == std::string::npos) {
                end = query.size();
            }
            const std::string pair = query.substr(start, end - start);
            const std::size_t equals = pair.find('=');
            if (equals == std::string::npos) {
                req.query[url_decode(pair)] = "";
            } else {
                req.query[url_decode(pair.substr(0, equals))] = url_decode(pair.substr(equals + 1));
            }
            start = end + 1;
        }
    }

    void deliver(const int id, const control::response &res) {
        // The page frees both buffers once it has copied them out.
        char *content_type = static_cast<char *>(std::malloc(res.content_type.size() + 1));
        std::memcpy(content_type, res.content_type.c_str(), res.content_type.size() + 1);

        char *body = static_cast<char *>(std::malloc(res.body.size() ? res.body.size() : 1));
        std::memcpy(body, res.body.data(), res.body.size());

        MAIN_THREAD_ASYNC_EM_ASM({
            const body = new Uint8Array(wasmMemory.buffer, $3, $4).slice();
            const type = UTF8ToString($2);
            _free($2);
            _free($3);
            if (Module['eka2l1OnResponse']) {
                Module['eka2l1OnResponse']($0, $1, type, body);
            }
        }, id, res.status, content_type, body, static_cast<int>(res.body.size()));
    }

    void notify_page(const char *event) {
        MAIN_THREAD_ASYNC_EM_ASM({
            if (Module['eka2l1OnEvent']) {
                Module['eka2l1OnEvent'](UTF8ToString($0));
            }
        }, event);
    }

    void setup_control() {
        control::native_frontend frontend;
        frontend.platform = "web";
        frontend.documents = std::filesystem::current_path().string();
        frontend.log = (std::filesystem::current_path() / "EKA2L1.log").string();
        frontend.get_system = [] { return state.symsys.get(); };
        frontend.frames = [] { return state.frames.load(); };
        frontend.can_capture = [] { return state.has_surface.load(); };
        frontend.launch = [](std::uint32_t uid) {
            return state.control_backend->launch_app(uid, [](kernel::process *) { notify_page("app-exited"); });
        };
        frontend.close = [] { state.close_session(); };
        frontend.boot = [](int index) { return state.boot_device(index); };
        frontend.pause = [](bool paused) {
            state.should_emu_pause = paused;
            if (!paused) {
                state.pause_sema.notify();
            }
        };
        frontend.changed = [](control::native_change) { notify_page("changed"); };

        state.control_backend = std::make_shared<control::native_backend>(std::move(frontend));
        state.control_service = std::make_unique<control::service>([](control::request req, control::completion done) {
            std::lock_guard<std::recursive_mutex> guard(state.control_mutex);
            done(state.control_backend->handle(req));
        });
    }
}

extern "C" {
// Queue a control API request. Safe to call from the page's main thread: it only
// copies its arguments and returns.
EMSCRIPTEN_KEEPALIVE void eka2l1_web_request(int id, const char *method, const char *target, const char *body, int body_len) {
    pending_request pending;
    pending.id = id;
    pending.request.method = method ? method : "GET";
    parse_target(target ? target : "", pending.request);
    if (body && body_len > 0) {
        pending.request.body.assign(body, static_cast<std::size_t>(body_len));
    }

    {
        std::lock_guard<std::mutex> guard(queue_mutex);
        queue.push_back(std::move(pending));
    }
    queue_signal.notify_one();
}

EMSCRIPTEN_KEEPALIVE void eka2l1_web_key(int scancode, int down) {
    state.press_key(scancode, down != 0);
}

EMSCRIPTEN_KEEPALIVE void eka2l1_web_touch(int x, int y, int action, int pointer_id) {
    state.touch(x, y, action, pointer_id);
}

// Mirror the data tree to persistent storage now instead of at the next
// periodic pass. The page reports completion as a "saved" event.
EMSCRIPTEN_KEEPALIVE void eka2l1_web_save() {
    web::persist::request_save();
}

EMSCRIPTEN_KEEPALIVE double eka2l1_web_frames() {
    return static_cast<double>(state.frames.load());
}

// Audio: the page reads the ring straight out of wasm memory from its worklet.
EMSCRIPTEN_KEEPALIVE void *eka2l1_web_audio_ring() {
    auto *driver = static_cast<drivers::web_audio_driver *>(state.audio_driver.get());
    return driver ? driver->ring() : nullptr;
}

EMSCRIPTEN_KEEPALIVE void eka2l1_web_audio_set_rate(int rate) {
    auto *driver = static_cast<drivers::web_audio_driver *>(state.audio_driver.get());
    if (driver) {
        driver->set_output_sample_rate(static_cast<std::uint32_t>(rate));
    }
}
}

int main(int argc, char **argv) {
    bool persist = true;
    for (int i = 1; i < argc; i++) {
        if (std::strcmp(argv[i], "--no-persist") == 0) {
            persist = false;
        }
    }

    // Everything the emulator reads at startup (patches, shaders, compat
    // settings) was preloaded under /eka2l1, and its data tree lives there too.
    std::filesystem::create_directories("/eka2l1");
    // Preloaded directories come in read-only; the data tree is written here.
    std::error_code ignored;
    std::filesystem::permissions("/eka2l1", std::filesystem::perms::all, ignored);
    for (const auto &entry : std::filesystem::recursive_directory_iterator("/eka2l1", ignored)) {
        if (entry.is_directory(ignored)) {
            std::filesystem::permissions(entry.path(), std::filesystem::perms::all, ignored);
        }
    }
    std::filesystem::current_path("/eka2l1");

    if (persist) {
        // Bring back what a previous visit installed and saved.
        if (web::persist::restore("/eka2l1/data")) {
            std::printf("Restored saved data\n");
        }
    }

    state.stage_one();

    // The audio driver exists from the start so the page can attach its
    // worklet before any device is booted.
    state.audio_driver = drivers::make_audio_driver(drivers::audio_driver_backend::cubeb, state.conf.audio_master_volume);

    const bool has_canvas = MAIN_THREAD_EM_ASM_INT({
        return (typeof document !== 'undefined' && Module['canvas']) ? 1 : 0;
    }) != 0;

    if (has_canvas) {
        state.canvas_selector = "#canvas";
        state.start_graphics_thread();
    } else {
        LOG_WARN(FRONTEND_CMDLINE, "No canvas on the page; running without a graphics driver");
    }

    setup_control();

    if (state.symsys->get_device_manager()->total() > 0) {
        if (state.stage_two()) {
            state.start_os_thread();
        }
    }

    if (persist) {
        web::persist::start("/eka2l1/data", [](std::size_t) { notify_page("saved"); });
    }

    notify_page("ready");

    // This thread now serves control requests for the lifetime of the page.
    for (;;) {
        pending_request pending;
        {
            std::unique_lock<std::mutex> lock(queue_mutex);
            queue_signal.wait(lock, [] { return !queue.empty(); });
            pending = std::move(queue.front());
            queue.pop_front();
        }

        const int id = pending.id;
        state.control_service->handle(std::move(pending.request), [id](control::response res) {
            deliver(id, res);
        });
    }

    return 0;
}
