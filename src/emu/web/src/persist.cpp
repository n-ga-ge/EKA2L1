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

        // A pass is all-or-nothing, so a tab closed halfway never leaves a
        // device list pointing at a ROM that was not copied yet. Changed files
        // are first written next to their targets under STAGED_SUFFIX; the
        // journal, written last and in one piece, lists what to promote and
        // what to delete. Once the journal exists the pass is decided and is
        // finished on the next start if need be; without it, staged files are
        // leftovers and are thrown away.
        constexpr const char *JOURNAL = "/persist/commit";
        constexpr const char *JOURNAL_STAGING = "/persist/commit.new";
        constexpr const char *STAGED_SUFFIX = ".eka2l1-new";
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

        // Moves a staged file over its target.
        bool promote(const fs::path &target) {
            fs::path staged = target;
            staged += STAGED_SUFFIX;

            std::error_code ec;
            if (!fs::exists(staged, ec)) {
                return fs::exists(target, ec);
            }

            fs::rename(staged, target, ec);
            if (!ec) {
                return true;
            }

            // Storage without rename: copy, then drop the staged file.
            const bool copied = mirror_file(staged, target);
            fs::remove(staged, ec);
            return copied;
        }

        // Carries out a journal: promote every "W" entry, delete every "D".
        void apply_journal(const std::vector<std::pair<char, std::string>> &entries) {
            std::error_code ec;
            for (const auto &[kind, name] : entries) {
                const fs::path target = fs::path(STORE_ROOT) / name;
                if (kind == 'W') {
                    promote(target);
                } else {
                    fs::remove(target, ec);
                }
            }
            fs::remove(JOURNAL, ec);
        }

        bool write_journal(const std::vector<std::pair<char, std::string>> &entries) {
            std::FILE *out = std::fopen(JOURNAL_STAGING, "wb");
            if (!out) {
                return false;
            }

            bool ok = true;
            for (const auto &[kind, name] : entries) {
                ok = ok && (std::fprintf(out, "%c %s\n", kind, name.c_str()) > 0);
            }
            ok = (std::fclose(out) == 0) && ok;

            std::error_code ec;
            if (ok) {
                fs::rename(JOURNAL_STAGING, JOURNAL, ec);
                ok = !ec;
            }
            if (!ok) {
                fs::remove(JOURNAL_STAGING, ec);
            }
            return ok;
        }

        // Finishes a pass that was decided but cut short, or clears the
        // leftovers of one that was not.
        void recover() {
            std::error_code ec;
            fs::remove(JOURNAL_STAGING, ec);

            if (std::FILE *in = std::fopen(JOURNAL, "rb")) {
                std::vector<std::pair<char, std::string>> entries;
                char line[4096];
                while (std::fgets(line, sizeof(line), in)) {
                    std::string text(line);
                    while (!text.empty() && (text.back() == '\n' || text.back() == '\r')) {
                        text.pop_back();
                    }
                    if (text.size() > 2 && (text[0] == 'W' || text[0] == 'D') && text[1] == ' ') {
                        entries.emplace_back(text[0], text.substr(2));
                    }
                }
                std::fclose(in);
                apply_journal(entries);
                return;
            }

            if (!fs::exists(STORE_ROOT, ec)) {
                return;
            }

            std::vector<fs::path> stray;
            for (auto it = fs::recursive_directory_iterator(STORE_ROOT, ec); !ec && it != fs::recursive_directory_iterator(); it.increment(ec)) {
                const std::string name = it->path().filename().string();
                const std::string suffix = STAGED_SUFFIX;
                if (name.size() > suffix.size() && name.compare(name.size() - suffix.size(), suffix.size(), suffix) == 0) {
                    stray.push_back(it->path());
                }
            }
            for (const fs::path &path : stray) {
                fs::remove(path, ec);
            }
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

            // Stage every new or changed file.
            std::vector<std::pair<char, std::string>> entries;
            std::map<std::string, signature> staged;

            for (const auto &[name, sig] : current) {
                const auto known = saved.find(name);
                if (known != saved.end() && known->second == sig) {
                    continue;
                }

                fs::path target = fs::path(STORE_ROOT) / name;
                target += STAGED_SUFFIX;
                if (mirror_file(fs::path(live_root) / name, target)) {
                    entries.emplace_back('W', name);
                    staged[name] = sig;
                }
            }

            for (const auto &[name, sig] : saved) {
                if (!current.count(name)) {
                    entries.emplace_back('D', name);
                }
            }

            if (entries.empty()) {
                return 0;
            }

            // The journal is the commit point.
            if (!write_journal(entries)) {
                for (const auto &[kind, name] : entries) {
                    if (kind == 'W') {
                        fs::path target = fs::path(STORE_ROOT) / name;
                        target += STAGED_SUFFIX;
                        fs::remove(target, ec);
                    }
                }
                return 0;
            }

            apply_journal(entries);

            for (const auto &[kind, name] : entries) {
                if (kind == 'W') {
                    saved[name] = staged[name];
                } else {
                    saved.erase(name);
                }
            }

            return entries.size();
        }
    }

    bool restore(const std::string &live_root) {
        if (!mount()) {
            std::fprintf(stderr, "Persistent storage is unavailable; data will be lost on reload\n");
            return false;
        }

        recover();

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
