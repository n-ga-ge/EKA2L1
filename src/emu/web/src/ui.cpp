// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <common/applauncher.h>
#include <drivers/ui/input_dialog.h>

#include <emscripten.h>
#include <emscripten/threading.h>

namespace eka2l1::common {
    // A guest asking for the phone's browser opens the link in a new tab. The
    // page may block it as a popup when no user gesture is active.
    bool launch_browser(const std::string &url) {
        MAIN_THREAD_ASYNC_EM_ASM({
            if (typeof window !== 'undefined') {
                window.open(UTF8ToString($0), '_blank', 'noopener');
            }
        }, url.c_str());
        return true;
    }
}

// The page has no native text or question dialogs wired up yet. Guests that ask
// for one get an immediate refusal instead of waiting forever.
namespace eka2l1::drivers::ui {
    bool open_input_view(const std::u16string &, const int, input_dialog_complete_callback) {
        return false;
    }

    void close_input_view() {
    }

    dialog_cancel_callback show_yes_no_dialog(const std::u16string &, const std::u16string &, const std::u16string &,
        yes_no_dialog_complete_callback complete_callback) {
        if (complete_callback) {
            complete_callback(0);
        }
        return {};
    }
}
