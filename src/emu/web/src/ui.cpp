// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <common/applauncher.h>
#include <drivers/ui/input_dialog.h>

#include <emscripten.h>

#include <cstdlib>
#include <cstring>
#include <emscripten/threading.h>
#include <system_error>
#include <thread>
#include <utility>

namespace eka2l1::common {
    // A guest asking for the phone's browser opens the link in a new tab. The
    // page may block it as a popup when no user gesture is active.
    bool launch_browser(const std::string &url) {
        // The call is asynchronous, so the page gets its own copy to free.
        char *copy = static_cast<char *>(std::malloc(url.size() + 1));
        std::memcpy(copy, url.c_str(), url.size() + 1);

        MAIN_THREAD_ASYNC_EM_ASM({
            const target = UTF8ToString($0);
            _free($0);
            if (typeof window !== 'undefined') {
                window.open(target, '_blank', 'noopener');
            }
        }, copy);
        return true;
    }
}

// The page has no native text or question dialogs wired up yet. Guests that ask
// for one get an immediate refusal instead of waiting forever.
//
// The refusal of a question comes from a thread of its own. The notifier asks
// while it holds the kernel lock and its completion takes that lock again, as
// it may when a frontend answers from its UI thread; answering on the caller's
// thread would lock a plain mutex twice and stop the emulator for good. Like
// an answer from a UI thread, it relies on the completion's own check that
// the request still exists. A global message query is refused by the empty
// return value before the thread runs, which then finds nothing to complete.
namespace eka2l1::drivers::ui {
    bool open_input_view(const std::u16string &, const int, input_dialog_complete_callback) {
        return false;
    }

    void close_input_view() {
    }

    dialog_cancel_callback show_yes_no_dialog(const std::u16string &, const std::u16string &, const std::u16string &,
        yes_no_dialog_complete_callback complete_callback) {
        if (complete_callback) {
            try {
                std::thread([complete = std::move(complete_callback)] { complete(0); }).detach();
            } catch (const std::system_error &) {
                // No thread to answer from: the guest's request stays open, the emulator goes on.
            }
        }
        return {};
    }
}
