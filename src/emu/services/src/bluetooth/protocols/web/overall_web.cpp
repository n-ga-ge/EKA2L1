// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later

#include <services/bluetooth/protocols/web/midman_web.h>
#include <services/bluetooth/protocols/web/overall_web.h>
#include <services/bluetooth/protocols/web/socket_web.h>
#include <services/socket/server.h>

#include <common/log.h>
#include <system/epoc.h>
#include <utils/err.h>
#include <vfs/vfs.h>

namespace eka2l1::epoc::bt::web {
    void switch_bluetooth_on(io_system *io) {
        static const char16_t *const FOLDER = u"C:\\System\\SharedData\\";
        static const char16_t *const SETTINGS = u"C:\\System\\SharedData\\10005952.ini";
        static const std::u16string KEY = u"PowerMode=";

        if (!io || !io->get_drive_entry(drive_c)) {
            return;
        }

        std::u16string text;

        if (io->exist(SETTINGS)) {
            // The file is rewritten whole below, so it has to be read whole
            // first: the Bluetooth engine keeps its other settings in it.
            std::unique_ptr<file> existing = io->open_file(SETTINGS, READ_MODE | BIN_MODE);
            if (!existing) {
                return;
            }

            const std::uint64_t size = existing->size();
            if (size > 64 * 1024) {
                existing->close();
                return;
            }

            text.resize(static_cast<std::size_t>(size / 2));
            const std::size_t got = existing->read_file(text.data(), 2, static_cast<std::uint32_t>(text.size()));
            existing->close();

            if (got != text.size() * 2) {
                return;
            }
        }

        // The key at the start of a line (the first may follow a byte order mark).
        std::size_t at = text.find(KEY);
        while ((at != std::u16string::npos) && (at > 0) && (text[at - 1] != u'\n') && (text[at - 1] != u'\xFEFF')) {
            at = text.find(KEY, at + 1);
        }

        if (at == std::u16string::npos) {
            if (!text.empty() && (text.back() != u'\n')) {
                text += u"\r\n";
            }

            text += KEY + u"1\r\n";
        } else {
            std::size_t end = text.find_first_of(u"\r\n", at);
            if (end == std::u16string::npos) {
                end = text.size();
            }

            if (text.compare(at + KEY.size(), end - at - KEY.size(), u"1") == 0) {
                return;
            }

            text.replace(at + KEY.size(), end - at - KEY.size(), u"1");
        }

        io->create_directories(FOLDER);

        std::unique_ptr<file> settings = io->open_file(SETTINGS, WRITE_MODE | BIN_MODE);
        if (!settings) {
            LOG_WARN(SERVICE_BLUETOOTH, "Can't write the Bluetooth settings; games may find Bluetooth switched off");
            return;
        }

        settings->write_file(text.data(), 2, static_cast<std::uint32_t>(text.size()));
        settings->close();
    }

    std::unique_ptr<midman> make_midman() {
        return std::make_unique<midman_web>();
    }

    void add_protocols(socket_server *sock, midman *mm, const bool oldarch) {
        midman_web *mid = static_cast<midman_web *>(mm);
        const std::shared_ptr<stack> stk = mid->get_stack();

        {
            const std::lock_guard<std::mutex> guard(stk->lock());
            stk->set_name(mm->device_name());
        }

        std::unique_ptr<epoc::socket::protocol> btlink_pr = std::make_unique<btlink_web_protocol>(mid, oldarch);
        std::unique_ptr<epoc::socket::protocol> l2cap_pr = std::make_unique<l2cap_web_protocol>(mid, oldarch);
        std::unique_ptr<epoc::socket::protocol> rfcomm_pr = std::make_unique<rfcomm_web_protocol>(mid, oldarch);
        std::unique_ptr<epoc::socket::protocol> sdp_pr = std::make_unique<sdp_web_protocol>(mid, oldarch);

        if (!sock->add_protocol(btlink_pr)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Failed to add BTLink protocol");
        }

        if (!sock->add_protocol(l2cap_pr)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Failed to add L2CAP protocol");
        }

        if (!sock->add_protocol(rfcomm_pr)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Failed to add RFCOMM protocol");
        }

        if (!sock->add_protocol(sdp_pr)) {
            LOG_ERROR(SERVICE_BLUETOOTH, "Failed to add SDP protocol");
        }

        stk->attach(sock->get_kernel_object_owner());
    }

    bool pick_peer(midman *mm, device_address &selected) {
        const std::shared_ptr<stack> stk = static_cast<midman_web *>(mm)->get_stack();
        const std::lock_guard<std::mutex> guard(stk->lock());

        stk->totals().selections++;

        // Sorted by id.
        const std::vector<peer_info> peers = stk->announced_peers();
        if (peers.empty()) {
            stk->note("select", BTLINK_MANAGER_PROTOCOL_ID, 0, 0, epoc::error_not_found);
            return false;
        }

        selected = peers.front().address;
        stk->note("select", BTLINK_MANAGER_PROTOCOL_ID, 0, peers.front().id, epoc::error_none);

        return true;
    }

    void diagnose(diagnostics &out) {
        link &lnk = link::get();

        // Only a stack ever attaches to the link.
        lnk.with_handler([&out](link_handler &handler) { static_cast<stack &>(handler).diagnose(out); });

        out.link = lnk.state();
        out.thread = lnk.thread_started();
        out.totals.frames_in = lnk.frames_in();
        out.totals.frames_out = lnk.frames_out();
        out.frames_dropped = lnk.frames_dropped();
    }
}
