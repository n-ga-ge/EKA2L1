// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
#include <services/fs/factory.h>

#include <common/cvt.h>
#include <common/fileutils.h>
#include <common/log.h>
#include <vfs/vfs.h>

#include <cstdio>
#include <optional>
#include <string>
#include <string_view>

namespace eka2l1::epoc::fs {
    // The profile engine of Series 60 1.x (Symbian OS 6.1) leaves unless the general settings in shared data,
    // UID 0x100058EC, say whether the phone has an Offline profile: it does LeaveIfError on the read of
    // "R-Offline". An app that uses the engine then ends with "System error" before it draws. The shared data
    // server takes "R-" (read-only) keys from Z:\System\SharedData alone. The N-Gage firmware carries the
    // factory text of that file, "R-Offline=0" in it, but its ROM directory does not list it, so it is never
    // on Z:.
    //
    // Only that one key is supplied, and only for the firmware family the fault was seen on. Lower-case names
    // are those the device installation gives the files it takes out of a ROM.
    void supply_factory_settings(io_system *io, const epocver version) {
        static constexpr const char16_t *SHARED_DATA_SERVER = u"Z:\\system\\programs\\shareddataserver.exe";
        static constexpr const char16_t *SHARED_DATA_FOLDER = u"Z:\\system\\shareddata";
        static constexpr const char16_t *GENERAL_SETTINGS = u"Z:\\system\\shareddata\\100058ec.ini";

        if ((version != epocver::epoc6) || !io->get_drive_entry(drive_z) || !io->exist(SHARED_DATA_SERVER)
            || !io->exist(SHARED_DATA_FOLDER) || io->exist(GENERAL_SETTINGS)) {
            return;
        }

        const std::optional<std::u16string> host_path = io->get_raw_path(GENERAL_SETTINGS);
        if (!host_path || host_path->empty()) {
            return;
        }

        // UTF-16LE behind a byte order mark, like the files a ROM does list. 0: no Offline profile.
        std::string content;
        for (const char16_t unit : std::u16string_view(u"\uFEFFR-Offline=0\r\n")) {
            content += static_cast<char>(unit & 0xFF);
            content += static_cast<char>(unit >> 8);
        }

        const std::string host_path_u8 = common::ucs2_to_utf8(*host_path);
        FILE *ini = common::open_c_file(host_path_u8, "wb");
        const bool written = ini && (fwrite(content.data(), 1, content.size(), ini) == content.size());

        // A file cut short would be taken for the real one at every later start.
        if ((ini && (fclose(ini) != 0)) || !written) {
            common::remove(host_path_u8);
            LOG_WARN(SERVICE_EFSRV, "Can not write the default general settings to {}", host_path_u8);
        }
    }
}
