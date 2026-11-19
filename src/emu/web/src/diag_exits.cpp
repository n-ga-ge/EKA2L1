// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "exits" section of GET /v1/web/diag (web/diag.h): how the game and the
// guest's threads ended, calls the emulator has no function for, and whether
// the thread that runs the guest is still turning.
//
//   "exits": {
//     "loopTurns": <turns of the loop that runs the guest>,
//     "loopWoken": <whether this request woke that loop, see below>,
//     "loopPaused": <whether the emulator is paused: the loop then waits>,
//     "apps": <games the page launched that ended by themselves>,
//     "lastApps": [ <the last 8, oldest first> {
//         "at": <when, in milliseconds since 1970>,
//         "launched": "0x101FD3F6" <the application the page launched>,
//         "uid": "0x101FD3F6", "name": "<the process whose ending this is>",
//         "type": "kill" | "terminate" | "panic",
//         "category": "KERN-EXEC", "reason": 3,
//         "fault": <true when a processor fault ended it, see below>,
//         "description": "<what the panic means, when the emulator knows>" } ],
//     "threads": <threads that ended, not counting those ended with their program>,
//     "threadPanics": <of those, by a panic>,
//     "threadFaults": <of those, by a processor fault>,
//     "lastThreads": [ <the last 16 that did not end cleanly, oldest first> {
//         "at", "uid", "process", "thread", "type", "category", "reason",
//         "fault", "description" } ],
//     "unimplementedCalls": <system calls made that the emulator does not have>,
//     "unimplemented": [ { "call": "0x4D", "count": 12 }, ... ],
//     "stopped": { "at": <ms since 1970>, "message": "<the exception>" }
//   }
//
// The loop turns a few hundred times a second while a game plays and not at
// all while the guest has nothing to do: it then sleeps until a guest thread
// is ready. So that a sleeping loop can be told from one that is stuck or
// gone, every request wakes it (as pausing does), which costs one empty turn:
// a loop that is alive has turned by the next request. "loopWoken" is false
// when the emulator was busy with a boot, a launch or a close and was left
// alone, and a reading after that says nothing.
//
// "stopped" is only there once the thread that runs the guest has given up;
// the page is told at that moment with an "emulator-stopped" event.
//
// A processor fault (the guest read or wrote memory it does not have, or ran
// an instruction that does not exist) ends the thread with exit type
// "terminate", category KERN-EXEC and reason 3: kernel_system::
// cpu_exception_thread_handle does that, and nothing else in the emulator
// ends a thread that way. To the guest and to GET /v1/session it therefore
// looks like a program that closed. That exit type is what the guest sees and
// stays as it is; here the three values together are read as a fault.
//
// POST /v1/web/diag/stop?how=exception|abort|hang is for tests of what the
// page does when the emulator stops by itself, which nothing else can
// provoke: at its next turn the thread that runs the guest ends with a C++
// exception or with abort(), or stays in that turn for good. Like the rest it
// is answered without the control lock.
//
// Which process's ending is a game's ending needs care. The launch callback
// says when a launch is over, and it is not always called with the game: the
// application server follows a program that ends while programs it started
// still run, and reports one of those instead (applist_server::launch_app).
// That is right for an N-Gage application that only starts the real game,
// and wrong for an N-Gage 2.0 game that crashed: the phone's game services it
// had started close a moment later, without an error, and are what the
// callback names. So the process the page launched is watched for itself
// (the kernel's process-exit callback, by its UID): when it crashed, that is
// how the game ended, recorded at once and told to the page with the same
// "app-exited" event, without waiting for a callback that may never come;
// otherwise the callback's process is how it ended. One launch gives one
// entry, however many callbacks follow.
// Other processes of the phone come and go and are no game's ending.
//
// A program closed from outside (DELETE /v1/session, a restart) is not in
// "apps": the control backend drops the launch callback of a session it has
// closed, and the kernel is taken down without ending threads one by one.

#include <web/diag.h>
#include <web/diag_exits.h>
#include <web/state.h>

#include <common/cvt.h>
#include <common/webdiag/exits.h>

#include <kernel/kernel.h>
#include <kernel/process.h>
#include <kernel/thread.h>
#include <utils/panic.h>

#include <algorithm>
#include <chrono>
#include <cstdio>
#include <deque>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace eka2l1::web {
    namespace {
        constexpr std::size_t KEPT_APPS = 8;
        constexpr std::size_t KEPT_THREADS = 16;
        constexpr std::size_t TEXT_LENGTH = 120;

        struct ending {
            double at = 0;
            std::uint32_t launched = 0;
            std::uint32_t uid = 0;
            std::string process;
            std::string thread;
            kernel::entity_exit_type type = kernel::entity_exit_type::kill;
            std::string category;
            std::int32_t reason = 0;
            bool fault = false;
            std::string description;
        };

        // What is kept. The lock is held for a copy or a push, never across a
        // call into the emulator: the kernel's callbacks run on the thread
        // that runs the guest, the request on the dispatcher thread.
        std::mutex lock;
        std::deque<ending> apps;
        std::deque<ending> threads;
        std::uint64_t apps_total = 0;
        std::uint64_t threads_total = 0;
        std::uint64_t thread_panics = 0;
        std::uint64_t thread_faults = 0;
        std::optional<std::pair<double, std::string>> stopped;
        kernel_system *watched = nullptr;
        void (*notify_page)(const char *event) = nullptr;

        // The launch that is running: the application's UID, and whether
        // its ending is recorded.
        std::uint32_t launched_uid = 0;
        bool launch_recorded = true;

        double now_ms() {
            return static_cast<double>(std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::system_clock::now().time_since_epoch()).count());
        }

        // Names and categories come from the guest. Control characters are
        // taken out and the length is bounded, so that whatever a program
        // calls its threads, the answer stays one line of valid JSON.
        std::string plain(std::string text) {
            if (text.size() > TEXT_LENGTH) {
                text.resize(TEXT_LENGTH);
            }
            for (char &ch : text) {
                if (static_cast<unsigned char>(ch) < 0x20 || ch == 0x7F) {
                    ch = '?';
                }
            }
            return text;
        }

        const char *type_name(const kernel::entity_exit_type type) {
            switch (type) {
            case kernel::entity_exit_type::kill:
                return "kill";
            case kernel::entity_exit_type::terminate:
                return "terminate";
            case kernel::entity_exit_type::panic:
                return "panic";
            default:
                return "pending";
            }
        }

        ending describe(const kernel::entity_exit_type type, const std::string &category, const std::int32_t reason) {
            ending end;
            end.at = now_ms();
            end.type = type;
            end.category = plain(category);
            end.reason = reason;
            end.fault = (type == kernel::entity_exit_type::terminate) && (category == "KERN-EXEC") && (reason == 3);

            if (type == kernel::entity_exit_type::panic || end.fault) {
                if (const auto description = epoc::get_panic_description(category, reason)) {
                    end.description = plain(*description);
                }
            }

            return end;
        }

        bool crashed(const ending &end) {
            return end.fault || end.type == kernel::entity_exit_type::panic;
        }

        // When the list is full, an entry that is no crash goes first: on a
        // phone, threads that end with an error code are many, and must not
        // push out the one that says why a game stands still.
        void keep(std::deque<ending> &list, ending end, const std::size_t most) {
            list.push_back(std::move(end));
            while (list.size() > most) {
                auto oldest = std::find_if(list.begin(), list.end(), [](const ending &kept) { return !crashed(kept); });
                list.erase(oldest == list.end() ? list.begin() : oldest);
            }
        }

        control::json to_json(const ending &end, const bool is_thread) {
            control::json::object out{
                { "at", end.at },
                { "uid", control::hex(end.uid) },
                { is_thread ? "process" : "name", end.process },
                { "type", type_name(end.type) },
                { "category", end.category },
                { "reason", end.reason },
                { "fault", end.fault },
            };
            if (is_thread) {
                out["thread"] = end.thread;
            } else {
                out["launched"] = control::hex(end.launched);
            }
            if (!end.description.empty()) {
                out["description"] = end.description;
            }
            return control::json(std::move(out));
        }

        void thread_ended(kernel::thread *thread, const std::string &category, const std::int32_t reason) {
            // Threads that go down with their program say nothing new: the
            // program's own end is what is recorded.
            if (!thread || category == "Domino" || thread->get_kernel_object_owner()->wipeout_in_progress()) {
                return;
            }

            ending end = describe(thread->get_exit_type(), category, reason);
            end.thread = plain(thread->name());
            if (kernel::process *process = thread->owning_process()) {
                end.uid = process->get_uid();
                end.process = plain(process->name());
            }

            const std::lock_guard<std::mutex> guard(lock);
            threads_total++;
            if (end.type == kernel::entity_exit_type::panic) {
                thread_panics++;
            }
            if (end.fault) {
                thread_faults++;
            }
            if (end.type == kernel::entity_exit_type::panic || end.fault || end.reason != 0) {
                keep(threads, std::move(end), KEPT_THREADS);
            }
        }

        ending describe(kernel::process *process) {
            ending end = describe(process->get_exit_type(), common::ucs2_to_utf8(process->get_exit_category()), process->get_exit_reason());
            end.uid = process->get_uid();
            end.process = plain(process->name());
            return end;
        }

        // Every process that ends by itself: only the launched one matters.
        void process_ended(kernel::process *process) {
            if (!process) {
                return;
            }

            const std::uint32_t uid = process->get_uid();
            {
                const std::lock_guard<std::mutex> guard(lock);
                if (launch_recorded || uid != launched_uid) {
                    return;
                }
            }

            ending end = describe(process);
            if (!crashed(end)) {
                // It may have handed over to a program it started: the launch
                // callback says when the launch is over.
                return;
            }

            {
                const std::lock_guard<std::mutex> guard(lock);
                if (launch_recorded || uid != launched_uid) {
                    return;
                }

                end.launched = launched_uid;
                launch_recorded = true;
                apps_total++;
                keep(apps, std::move(end), KEPT_APPS);
            }

            if (notify_page) {
                notify_page("app-exited");
            }
        }
    }

    void exits_setup(void (*notify)(const char *event)) {
        notify_page = notify;
    }

    bool exits_route(const control::request &req, control::response &res) {
        if (req.path != std::vector<std::string>{ "v1", "web", "diag", "stop" }) {
            return false;
        }

        const std::string how = req.param("how");
        const int mode = (how == "exception") ? 1 : (how == "abort") ? 2 : (how == "hang") ? 3 : 0;
        if (req.method != "POST" || mode == 0) {
            res = control::response::error(400, "bad_request", "POST with how=exception, how=abort or how=hang");
            return true;
        }

        webdiag::exits.debug_stop.store(mode);
        res = control::response::from_json({ { "how", how } });
        return true;
    }

    void exits_watch(system *sys) {
        kernel_system *kern = sys ? sys->get_kernel_system() : nullptr;

        {
            const std::lock_guard<std::mutex> guard(lock);
            if (!kern || kern == watched) {
                return;
            }

            // The kernel object lives through a reset and keeps its callbacks.
            watched = kern;
        }

        kern->register_thread_kill_callback(thread_ended);
        kern->register_process_exit_callback(process_ended);
    }

    void exits_app_launched(const std::uint32_t uid) {
        const std::lock_guard<std::mutex> guard(lock);
        launched_uid = uid;
        launch_recorded = false;
    }

    void exits_app_ended(kernel::process *process) {
        if (!process) {
            return;
        }

        ending end = describe(process);

        const std::lock_guard<std::mutex> guard(lock);
        if (launch_recorded) {
            return;
        }

        end.launched = launched_uid;

        launch_recorded = true;
        apps_total++;
        keep(apps, std::move(end), KEPT_APPS);
    }

    void exits_emulator_stopped(const char *message) {
        {
            const std::lock_guard<std::mutex> guard(lock);
            if (!stopped) {
                stopped = std::make_pair(now_ms(), plain(message ? message : ""));
            }
        }

        // The page reads the message from the request.
        if (notify_page) {
            notify_page("emulator-stopped");
        }
    }

    control::json diag_exits(emulator &state) {
        const std::uint64_t turns = webdiag::exits.loop_turns.load(std::memory_order_relaxed);
        bool woken = false;
        {
            system_access access(state);
            if (access && access.sys->get_kernel_system()) {
                access.sys->get_kernel_system()->stop_cores_idling();
                woken = true;
            }
        }

        control::json::array calls;
        for (int i = 0; i < webdiag::exits_counters::CALL_SLOTS; i++) {
            const std::uint32_t tag = webdiag::exits.call_number[i].load(std::memory_order_relaxed);
            if (tag == 0) {
                break;
            }

            char number[11];
            std::snprintf(number, sizeof(number), "0x%X", tag - 1);
            calls.push_back(control::json({ { "call", std::string(number) },
                { "count", webdiag::exits.call_count[i].load(std::memory_order_relaxed) } }));
        }

        control::json::object out{
            { "loopTurns", turns },
            { "loopWoken", woken },
            { "loopPaused", state.should_emu_pause.load() },
            { "unimplementedCalls", webdiag::exits.unimplemented_calls.load(std::memory_order_relaxed) },
            { "unimplemented", std::move(calls) },
        };

        control::json::array last_apps;
        control::json::array last_threads;
        {
            const std::lock_guard<std::mutex> guard(lock);
            for (const ending &end : apps) {
                last_apps.push_back(to_json(end, false));
            }
            for (const ending &end : threads) {
                last_threads.push_back(to_json(end, true));
            }

            out["apps"] = apps_total;
            out["threads"] = threads_total;
            out["threadPanics"] = thread_panics;
            out["threadFaults"] = thread_faults;
            if (stopped) {
                out["stopped"] = control::json({ { "at", stopped->first }, { "message", stopped->second } });
            }
        }
        out["lastApps"] = std::move(last_apps);
        out["lastThreads"] = std::move(last_threads);

        return control::json(std::move(out));
    }
}
