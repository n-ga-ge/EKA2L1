// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <web/persist.h>

#include <emscripten/wasmfs.h>

#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <filesystem>
#include <map>
#include <mutex>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace eka2l1::web::persist {
    namespace {
        constexpr const char *STORE_MOUNT = "/persist";
        constexpr const char *STORE_ROOT = "/persist/data";
        constexpr auto PASS_INTERVAL = std::chrono::seconds(10);

        struct signature {
            std::uintmax_t size;
            fs::file_time_type modified;

            bool operator==(const signature &other) const {
                return size == other.size && modified == other.modified;
            }
        };

        std::mutex lock;
        std::condition_variable wake;
        // Requests are numbered so a caller can tell when a pass that started
        // after its request has finished.
        std::uint64_t requested = 0;
        std::uint64_t completed = 0;
        bool mounted = false;

        // What the store currently holds, keyed by path relative to the root.
        std::map<std::string, signature> saved;

        bool mount() {
            if (!mounted) {
                const backend_t opfs = wasmfs_create_opfs_backend();
                mounted = (wasmfs_create_directory(STORE_MOUNT, 0777, opfs) == 0);
            }
            return mounted;
        }

        bool mirror_file(const fs::path &from, const fs::path &to) {
            std::error_code ec;
            fs::create_directories(to.parent_path(), ec);

            std::FILE *in = std::fopen(from.c_str(), "rb");
            if (!in) {
                return false;
            }

            std::FILE *out = std::fopen(to.c_str(), "wb");
            if (!out) {
                std::fclose(in);
                return false;
            }

            std::vector<char> buffer(1 << 20);
            bool ok = true;
            for (;;) {
                const std::size_t got = std::fread(buffer.data(), 1, buffer.size(), in);
                if (got == 0) {
                    break;
                }
                if (std::fwrite(buffer.data(), 1, got, out) != got) {
                    ok = false;
                    break;
                }
            }

            std::fclose(in);
            return (std::fclose(out) == 0) && ok;
        }

        std::size_t pass(const std::string &live_root) {
            std::error_code ec;
            std::map<std::string, signature> current;

            if (fs::exists(live_root, ec)) {
                for (auto it = fs::recursive_directory_iterator(live_root, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
                    if (!it->is_regular_file(ec)) {
                        continue;
                    }
                    signature sig{ it->file_size(ec), it->last_write_time(ec) };
                    current.emplace(fs::relative(it->path(), live_root, ec).generic_string(), sig);
                }
            }

            std::size_t written = 0;

            for (const auto &[name, sig] : current) {
                const auto known = saved.find(name);
                if (known != saved.end() && known->second == sig) {
                    continue;
                }
                if (mirror_file(fs::path(live_root) / name, fs::path(STORE_ROOT) / name)) {
                    saved[name] = sig;
                    written++;
                }
            }

            for (auto it = saved.begin(); it != saved.end();) {
                if (current.count(it->first)) {
                    ++it;
                    continue;
                }
                fs::remove(fs::path(STORE_ROOT) / it->first, ec);
                it = saved.erase(it);
                written++;
            }

            return written;
        }
    }

    bool restore(const std::string &live_root) {
        if (!mount()) {
            std::fprintf(stderr, "Persistent storage is unavailable; data will be lost on reload\n");
            return false;
        }

        std::error_code ec;
        if (!fs::exists(STORE_ROOT, ec)) {
            return false;
        }

        std::size_t restored = 0;
        for (auto it = fs::recursive_directory_iterator(STORE_ROOT, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
            if (!it->is_regular_file(ec)) {
                continue;
            }

            const std::string name = fs::relative(it->path(), STORE_ROOT, ec).generic_string();
            const fs::path target = fs::path(live_root) / name;

            if (mirror_file(it->path(), target)) {
                // Record the live copy's signature so the first pass does not
                // write everything straight back.
                saved[name] = signature{ fs::file_size(target, ec), fs::last_write_time(target, ec) };
                restored++;
            }
        }

        return restored > 0;
    }

    void start(const std::string &live_root, std::function<void(std::uint64_t)> on_pass) {
        if (!mounted) {
            return;
        }

        std::thread([live_root, on_pass = std::move(on_pass)] {
            for (;;) {
                std::uint64_t covers = 0;
                {
                    std::unique_lock<std::mutex> guard(lock);
                    wake.wait_for(guard, PASS_INTERVAL, [] { return requested > completed; });
                    covers = requested;
                }

                pass(live_root);

                {
                    std::lock_guard<std::mutex> guard(lock);
                    completed = covers;
                }

                if (on_pass) {
                    on_pass(covers);
                }
            }
        }).detach();
    }

    std::uint64_t request_save() {
        std::uint64_t ticket = 0;
        {
            std::lock_guard<std::mutex> guard(lock);
            ticket = ++requested;
        }
        wake.notify_one();
        return ticket;
    }
}
