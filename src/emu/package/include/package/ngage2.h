// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <common/types.h>

#include <cstdint>
#include <string>
#include <vector>

namespace eka2l1 {
    class io_system;

    namespace manager {
        class packages;
    }
}

/**
 * N-Gage 2.0 game files (".n-gage").
 *
 * A .n-gage file is a MIME multipart container ("Content-Type: multipart/mixed;
 * boundary=..."; "Content-Description: Ngage-Install-File; version=1.0") whose
 * parts are named by Content-ID:
 *
 * - RetailerInfo (text/xml): the shop that sold it.
 * - Metadata (application/sis): a SIS package with the game's package UID that
 *   only drops metadata.xml (title, description, game UID) and the banner PNGs
 *   into the N-Gage application's import folder (c:\private\20007b38\import).
 * - Game (application/sis): the game itself, with the same package UID. It
 *   carries no app registration resource: the N-Gage application starts the
 *   game itself.
 *
 * The N-Gage application installs both SIS parts after checking the file's
 * certificate. install_game() installs the Game part directly instead, and
 * writes the registration the device needs to start it from the app list.
 */
namespace eka2l1::package::ngage2 {
    struct part {
        std::string id; ///< Content-ID without the angle brackets.
        std::string content_type; ///< Content-Type without parameters, lowercased.
        std::uint64_t offset = 0; ///< Offset of the body in the file.
        std::uint64_t size = 0; ///< Size of the body.
    };

    /**
     * \brief Split a .n-gage file into its parts.
     * \returns The parts in file order; empty when the file is not such a container.
     */
    std::vector<part> read_container(const std::string &path);

    struct app {
        std::uint32_t uid = 0;
        std::u16string caption;
        std::u16string executable; ///< Guest path of the exe.
    };

    struct install_result {
        std::string error; ///< Empty on success.
        std::uint32_t package_uid = 0;
        std::u16string title; ///< From metadata.xml, when the file has one.
        std::u16string description;
        std::vector<app> apps; ///< The registered (launchable) apps.
    };

    /**
     * \brief Install the Game part of a .n-gage file and register its app.
     *
     * The Metadata part is read, not installed: it shares the package UID with the
     * game, so installing it as a package would replace one with the other.
     *
     * \param path        Host path of the .n-gage file.
     * \param drive       Drive to install to ("!:" in the package). The registration
     *                    goes to the same drive, next to the exe.
     * \param scratch_dir Host folder for the extracted SIS parts (removed again).
     */
    install_result install_game(manager::packages &packages, io_system *io, const std::string &path,
        const drive_number drive, const std::string &scratch_dir);

    /**
     * \brief Build an application registration resource (<name>_reg.rsc).
     *
     * \param app_file         The exe's name without extension.
     * \param localisable_file Path of the localisable resource without extension, or empty.
     * \param localisable_id   Resource ID of LOCALISABLE_APP_INFO in that file.
     */
    std::vector<std::uint8_t> make_registration(const std::uint32_t uid, const std::u16string &app_file,
        const std::u16string &localisable_file, const std::uint32_t localisable_id);

    /**
     * \brief Build a localisable registration resource (<name>_loc.rsc): resource 1 is
     * the signature, resource 2 the LOCALISABLE_APP_INFO with the captions.
     */
    std::vector<std::uint8_t> make_localisable_info(const std::u16string &short_caption, const std::u16string &caption);
}
