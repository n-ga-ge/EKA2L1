// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include <package/manager.h>
#include <package/ngage2.h>

#include <common/algorithm.h>
#include <common/crypt.h>
#include <common/cvt.h>
#include <common/log.h>
#include <common/path.h>

#include <loader/sis.h>
#include <vfs/vfs.h>

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <optional>

#include <zlib.h>

namespace fs = std::filesystem;

namespace eka2l1::package::ngage2 {
    static constexpr std::uint32_t SIS_UID1 = 0x10201A7A;
    static constexpr std::uint32_t SIS_FIELD_CONTENTS = 12;
    static constexpr std::uint32_t RSC_UID1 = 0x101F4A6B;
    static constexpr std::uint32_t REGISTRATION_UID2 = 0x101F8021;
    static constexpr std::uint32_t LOCALISABLE_INFO_ID = 2;
    static constexpr std::size_t HEADER_WINDOW = 64 * 1024;
    static constexpr std::size_t METADATA_LIMIT = 1024 * 1024;

    static std::string lower(std::string text) {
        std::transform(text.begin(), text.end(), text.begin(), [](unsigned char c) { return char(std::tolower(c)); });
        return text;
    }

    static std::string trim(const std::string &text) {
        const auto begin = text.find_first_not_of(" \t\r\n");
        if (begin == std::string::npos) {
            return {};
        }
        return text.substr(begin, text.find_last_not_of(" \t\r\n") - begin + 1);
    }

    static std::uint32_t le32(const std::string &bytes, const std::size_t at) {
        return std::uint32_t(std::uint8_t(bytes[at])) | (std::uint32_t(std::uint8_t(bytes[at + 1])) << 8)
            | (std::uint32_t(std::uint8_t(bytes[at + 2])) << 16) | (std::uint32_t(std::uint8_t(bytes[at + 3])) << 24);
    }

    struct reader {
        std::ifstream file;
        std::uint64_t size = 0;

        explicit reader(const std::string &path)
            : file(fs::u8path(path), std::ios::binary) {
            if (file) {
                file.seekg(0, std::ios::end);
                size = std::uint64_t(file.tellg());
            }
        }

        std::string read(const std::uint64_t offset, const std::uint64_t count) {
            if (offset >= size) {
                return {};
            }
            std::string bytes(std::size_t(std::min<std::uint64_t>(count, size - offset)), '\0');
            file.clear();
            file.seekg(std::streamoff(offset));
            file.read(bytes.data(), std::streamsize(bytes.size()));
            bytes.resize(std::size_t(file.gcount()));
            return bytes;
        }

        // The first occurrence of needle at or after from, read in chunks.
        std::optional<std::uint64_t> find(const std::string &needle, std::uint64_t from) {
            static constexpr std::uint64_t CHUNK = 1024 * 1024;
            while (from < size) {
                const std::string chunk = read(from, CHUNK + needle.size());
                const auto hit = chunk.find(needle);
                if (hit != std::string::npos) {
                    return from + hit;
                }
                if (chunk.size() < CHUNK + needle.size()) {
                    break;
                }
                from += CHUNK;
            }
            return std::nullopt;
        }
    };

    // Length of the SIS file that starts at offset, from its own header (UIDs,
    // checksum, then the SISContents field), or 0 when it is not a SIS file.
    static std::uint64_t sis_length(reader &in, const std::uint64_t offset) {
        const std::string head = in.read(offset, 28);
        if ((head.size() < 24) || (le32(head, 0) != SIS_UID1) || (le32(head, 16) != SIS_FIELD_CONTENTS)) {
            return 0;
        }
        std::uint64_t length = le32(head, 20);
        std::uint64_t header = 24;
        if (length & 0x80000000) {
            if (head.size() < 28) {
                return 0;
            }
            length = (length & 0x7FFFFFFF) | (std::uint64_t(le32(head, 24)) << 31);
            header = 28;
        }
        return header + length;
    }

    // The value of a header parameter, as in: boundary="KBoundary".
    static std::string header_parameter(const std::string &value, const std::string &name) {
        const auto at = lower(value).find(name + "=");
        if (at == std::string::npos) {
            return {};
        }
        std::string rest = value.substr(at + name.size() + 1);
        if (!rest.empty() && rest[0] == '"') {
            return rest.substr(1, rest.find('"', 1) - 1);
        }
        return trim(rest.substr(0, rest.find_first_of(";\r\n")));
    }

    std::vector<part> read_container(const std::string &path) {
        reader in(path);
        const std::string head = in.read(0, HEADER_WINDOW);

        // The file's own header lines, up to the first delimiter.
        std::string boundary;
        std::size_t line_start = 0;
        while (line_start < head.size() && head.compare(line_start, 2, "--") != 0) {
            const auto line_end = head.find('\n', line_start);
            const std::string line = head.substr(line_start, line_end == std::string::npos ? std::string::npos : line_end - line_start);
            const auto colon = line.find(':');
            if ((colon != std::string::npos) && (lower(trim(line.substr(0, colon))) == "content-type")) {
                const std::string value = line.substr(colon + 1);
                if (lower(value).find("multipart/") != std::string::npos) {
                    boundary = header_parameter(value, "boundary");
                }
            }
            if (line_end == std::string::npos) {
                break;
            }
            line_start = line_end + 1;
        }
        if (boundary.empty()) {
            return {};
        }

        const std::string delimiter = "--" + boundary;
        std::vector<part> parts;
        std::uint64_t at = line_start;

        while (true) {
            const std::string window = in.read(at, HEADER_WINDOW);
            if (window.compare(0, delimiter.size(), delimiter) != 0) {
                return {};
            }
            if (window.compare(delimiter.size(), 2, "--") == 0) {
                break;
            }

            // Part headers, up to the empty line.
            const auto first_line = window.find('\n');
            if (first_line == std::string::npos) {
                return {};
            }
            part current;
            std::size_t pos = first_line + 1;
            while (true) {
                const auto line_end = window.find('\n', pos);
                if (line_end == std::string::npos) {
                    return {};
                }
                const std::string line = trim(window.substr(pos, line_end - pos));
                pos = line_end + 1;
                if (line.empty()) {
                    break;
                }
                const auto colon = line.find(':');
                if (colon == std::string::npos) {
                    continue;
                }
                const std::string name = lower(trim(line.substr(0, colon)));
                const std::string value = trim(line.substr(colon + 1));
                if (name == "content-type") {
                    current.content_type = lower(trim(value.substr(0, value.find(';'))));
                } else if (name == "content-id") {
                    current.id = value;
                    if (current.id.size() >= 2 && current.id.front() == '<' && current.id.back() == '>') {
                        current.id = current.id.substr(1, current.id.size() - 2);
                    }
                }
            }
            current.offset = at + pos;

            // A SIS part ends where its own header says, and the delimiter follows
            // at once; the parts seen have no line break before it. Other parts end
            // at the next delimiter, less the line break in front of it.
            std::optional<std::uint64_t> next;
            if (const std::uint64_t length = sis_length(in, current.offset)) {
                std::uint64_t end = current.offset + length;
                for (const char *gap : { "", "\r\n", "\n" }) {
                    const std::string between = gap;
                    if (in.read(end, between.size() + delimiter.size()) == between + delimiter) {
                        current.size = length;
                        next = end + between.size();
                        break;
                    }
                }
            }
            if (!next) {
                const auto found = in.find("\n" + delimiter, current.offset);
                if (!found) {
                    return {};
                }
                std::uint64_t end = *found;
                if (end > current.offset && in.read(end - 1, 1) == "\r") {
                    --end;
                }
                current.size = end - current.offset;
                next = *found + 1;
            }

            parts.push_back(current);
            at = *next;
        }

        return parts;
    }

    static bool extract(const std::string &path, const part &source, const std::string &target) {
        reader in(path);
        std::ofstream out(fs::u8path(target), std::ios::binary | std::ios::trunc);
        if (!out) {
            return false;
        }
        static constexpr std::uint64_t CHUNK = 4 * 1024 * 1024;
        for (std::uint64_t done = 0; done < source.size;) {
            const std::string bytes = in.read(source.offset + done, std::min(CHUNK, source.size - done));
            if (bytes.empty()) {
                return false;
            }
            out.write(bytes.data(), std::streamsize(bytes.size()));
            done += bytes.size();
        }
        return bool(out);
    }

    // The text of the first <child> inside the first <parent>, namespace
    // prefixes ignored, with the predefined and numeric entities decoded.
    static std::string xml_text(const std::string &xml, const std::string &parent, const std::string &child) {
        auto find_open = [&xml](const std::string &name, std::size_t from) -> std::size_t {
            for (auto at = xml.find('<', from); at != std::string::npos; at = xml.find('<', at + 1)) {
                const auto end = xml.find_first_of(" \t\r\n/>", at + 1);
                if (end == std::string::npos) {
                    break;
                }
                if (end == at + 1 || std::strchr("/?!", xml[at + 1])) {
                    continue; // a closing tag, declaration or comment
                }
                std::string tag = xml.substr(at + 1, end - at - 1);
                tag = tag.substr(tag.find(':') == std::string::npos ? 0 : tag.find(':') + 1);
                const auto close = xml.find('>', end);
                if (tag == name && close != std::string::npos && xml[close - 1] != '/') {
                    return close + 1;
                }
            }
            return std::string::npos;
        };
        const auto inside = find_open(parent, 0);
        const auto start = inside == std::string::npos ? inside : find_open(child, inside);
        if (start == std::string::npos) {
            return {};
        }
        const std::string raw = xml.substr(start, xml.find('<', start) - start);
        std::string text;
        for (std::size_t i = 0; i < raw.size(); ++i) {
            const auto semicolon = raw.find(';', i);
            if (raw[i] != '&' || semicolon == std::string::npos) {
                text += raw[i];
                continue;
            }
            const std::string entity = raw.substr(i + 1, semicolon - i - 1);
            std::uint32_t code = 0;
            if (entity == "amp")
                code = '&';
            else if (entity == "lt")
                code = '<';
            else if (entity == "gt")
                code = '>';
            else if (entity == "quot")
                code = '"';
            else if (entity == "apos")
                code = '\'';
            else if (entity.size() > 1 && entity[0] == '#')
                code = std::uint32_t(std::strtoul(entity.c_str() + 1 + (entity[1] == 'x'), nullptr, entity[1] == 'x' ? 16 : 10));
            if (code == 0 || code > 0xFFFF) {
                text += raw[i];
                continue;
            }
            text += common::ucs2_to_utf8(std::u16string(1, char16_t(code)));
            i = semicolon;
        }
        return trim(text);
    }

    // metadata.xml from the Metadata part, read straight from the SIS.
    static std::string read_metadata_xml(const std::string &sis_path) {
        const auto type = loader::identify_sis_type(sis_path);
        if (!type || (*type != loader::sis_type_new)) {
            return {};
        }
        loader::sis_contents contents = loader::parse_sis(sis_path, false);
        std::optional<std::uint32_t> index;
        for (const auto &field : contents.controller.install_block.files.fields) {
            const auto *file = reinterpret_cast<const loader::sis_file_des *>(field.get());
            const std::u16string target = common::lowercase_ucs2_string(file->target.unicode_string);
            if (eka2l1::filename(target, true) == u"metadata.xml") {
                index = file->idx;
                break;
            }
        }
        if (!index || contents.data.data_units.fields.empty()) {
            return {};
        }
        const auto *unit = reinterpret_cast<const loader::sis_data_unit *>(contents.data.data_units.fields[0].get());
        if (*index >= unit->data_unit.fields.size()) {
            return {};
        }
        const auto &blob = reinterpret_cast<const loader::sis_file_data *>(unit->data_unit.fields[*index].get())->raw_data;
        const std::uint64_t stored = ((std::uint64_t(blob.len_high) << 32) | blob.len_low) - 12;
        if (stored > METADATA_LIMIT || blob.uncompressed_size > METADATA_LIMIT) {
            return {};
        }
        reader in(sis_path);
        const std::string bytes = in.read(blob.offset, stored);
        if (bytes.size() != stored) {
            return {};
        }
        if (blob.algorithm == loader::sis_compressed_algorithm::none) {
            return bytes;
        }
        std::string text(std::size_t(blob.uncompressed_size), '\0');
        uLongf length = uLongf(text.size());
        if (uncompress(reinterpret_cast<Bytef *>(text.data()), &length, reinterpret_cast<const Bytef *>(bytes.data()), uLong(bytes.size())) != Z_OK) {
            return {};
        }
        text.resize(length);
        return text;
    }

    // An uncompressed resource file: UIDs, their checksum, flags, the size of the
    // largest resource, the (empty) compressed-Unicode bit array, the resources,
    // then the index of their offsets ending with the index's own offset.
    static std::vector<std::uint8_t> make_rsc(const std::uint32_t uid2, const std::uint32_t uid3, const std::vector<std::vector<std::uint8_t>> &resources) {
        std::vector<std::uint8_t> out;
        auto put16 = [&out](const std::uint32_t value) {
            out.push_back(std::uint8_t(value));
            out.push_back(std::uint8_t(value >> 8));
        };
        auto put32 = [&put16](const std::uint32_t value) {
            put16(value & 0xFFFF);
            put16(value >> 16);
        };
        const std::uint32_t uids[3] = { RSC_UID1, uid2, uid3 };
        for (const auto uid : uids) {
            put32(uid);
        }
        put32(crypt::calculate_checked_uid_checksum(uids));
        out.push_back(0);
        std::size_t largest = 0;
        for (const auto &resource : resources) {
            largest = std::max(largest, resource.size());
        }
        put16(std::uint32_t(largest));
        out.insert(out.end(), (resources.size() + 7) / 8, 0);
        std::vector<std::uint32_t> offsets;
        for (const auto &resource : resources) {
            offsets.push_back(std::uint32_t(out.size()));
            out.insert(out.end(), resource.begin(), resource.end());
        }
        offsets.push_back(std::uint32_t(out.size()));
        for (const auto offset : offsets) {
            put16(offset);
        }
        return out;
    }

    struct resource_writer {
        std::vector<std::uint8_t> bytes;

        void byte(const std::uint8_t value) {
            bytes.push_back(value);
        }
        void word(const std::uint16_t value) {
            byte(std::uint8_t(value));
            byte(std::uint8_t(value >> 8));
        }
        void dword(const std::uint32_t value) {
            word(std::uint16_t(value));
            word(std::uint16_t(value >> 16));
        }
        // LTEXT in a Unicode build: a length byte, a pad byte to an even offset, UTF-16.
        void ltext(const std::u16string &text) {
            const std::size_t length = std::min<std::size_t>(text.size(), 127);
            byte(std::uint8_t(length));
            if (length && (bytes.size() % 2)) {
                byte(0xAB);
            }
            for (std::size_t i = 0; i < length; ++i) {
                word(std::uint16_t(text[i]));
            }
        }
    };

    std::vector<std::uint8_t> make_registration(const std::uint32_t uid, const std::u16string &app_file,
        const std::u16string &localisable_file, const std::uint32_t localisable_id) {
        // APP_REGISTRATION_INFO (appinfo.rh)
        resource_writer info;
        info.dword(0); // reserved
        info.dword(0); // reserved_long
        info.ltext(app_file);
        info.dword(0); // attributes
        info.ltext(localisable_file);
        info.dword(localisable_file.empty() ? 0 : localisable_id);
        info.byte(0); // hidden
        info.byte(0); // embeddability: not embeddable
        info.byte(0); // newfile
        info.byte(0); // launch: foreground
        info.ltext(u""); // group_name
        info.byte(0); // default_screen_number
        info.word(0); // datatype_list
        info.word(0); // file_ownership_list
        info.word(0); // service_list
        info.dword(0); // opaque_data
        return make_rsc(REGISTRATION_UID2, uid, { info.bytes });
    }

    std::vector<std::uint8_t> make_localisable_info(const std::u16string &short_caption, const std::u16string &caption) {
        // RSS_SIGNATURE, then LOCALISABLE_APP_INFO with its CAPTION_AND_ICON_INFO.
        resource_writer signature;
        signature.dword(0);
        signature.dword(0);
        resource_writer info;
        info.dword(0); // reserved
        info.dword(0); // reserved_long
        info.ltext(short_caption);
        info.dword(0); // caption_and_icon: reserved
        info.dword(0); // caption_and_icon: reserved_long
        info.ltext(caption);
        info.word(0); // number_of_icons
        info.ltext(u""); // icon_file
        info.word(0); // view_list
        info.ltext(u""); // group_name
        return make_rsc(0, 0, { signature.bytes, info.bytes });
    }

    static bool write_guest_file(io_system *io, const std::u16string &path, const std::vector<std::uint8_t> &bytes) {
        io->create_directories(eka2l1::file_directory(path, true));
        symfile file = io->open_file(path, WRITE_MODE | BIN_MODE);
        if (!file) {
            return false;
        }
        const bool written = file->write_file(bytes.data(), 1, std::uint32_t(bytes.size())) == bytes.size();
        file->close();
        return written;
    }

    static std::uint32_t executable_uid(io_system *io, const std::u16string &path) {
        symfile file = io->open_file(path, READ_MODE | BIN_MODE);
        std::uint32_t uids[3] = {};
        if (!file) {
            return 0;
        }
        const bool read = file->read_file(uids, 1, sizeof(uids)) == sizeof(uids);
        file->close();
        return read ? uids[2] : 0;
    }

    install_result install_game(manager::packages &packages, io_system *io, const std::string &path,
        const drive_number drive, const std::string &scratch_dir) {
        install_result result;
        const auto parts = read_container(path);
        const part *game = nullptr;
        const part *metadata = nullptr;
        for (const auto &candidate : parts) {
            if (candidate.content_type != "application/sis") {
                continue;
            }
            if (lower(candidate.id) == "game") {
                game = &candidate;
            } else if (lower(candidate.id) == "metadata") {
                metadata = &candidate;
            }
        }
        if (!game) {
            result.error = parts.empty() ? "not an N-Gage 2.0 game file" : "the file has no Game part";
            return result;
        }

        std::error_code ignored;
        fs::create_directories(fs::u8path(scratch_dir), ignored);
        // Names of their own, so two emulators sharing a temporary folder do not meet.
        const std::string stem = "ngage2-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()) + "-"
            + std::to_string(reinterpret_cast<std::uintptr_t>(&result));
        const std::string metadata_sis = (fs::u8path(scratch_dir) / (stem + "-metadata.sis")).string();
        const std::string game_sis = (fs::u8path(scratch_dir) / (stem + "-game.sis")).string();

        if (metadata && extract(path, *metadata, metadata_sis)) {
            const std::string xml = read_metadata_xml(metadata_sis);
            result.title = common::utf8_to_ucs2(xml_text(xml, "Game", "Title"));
            result.description = common::utf8_to_ucs2(xml_text(xml, "Game", "Description"));
        }
        fs::remove(fs::u8path(metadata_sis), ignored);

        {
            reader in(path);
            const std::string head = in.read(game->offset, 12);
            result.package_uid = head.size() == 12 ? le32(head, 8) : 0;
        }
        const bool extracted = extract(path, *game, game_sis);
        const auto installed = extracted ? packages.install_package(common::utf8_to_ucs2(game_sis), drive, nullptr, nullptr, true) : installation_result_invalid;
        fs::remove(fs::u8path(game_sis), ignored);
        if (!extracted) {
            result.error = "could not extract the Game part";
            return result;
        }
        if (installed != installation_result_success) {
            result.error = "installing the Game part failed";
            return result;
        }

        object *pkg = packages.package(result.package_uid);
        if (!pkg) {
            result.error = "the Game part installed no package";
            return result;
        }

        // A game that cannot be registered is taken out again rather than left
        // installed with nothing to start it by.
        std::vector<std::u16string> written;
        auto fail = [&](const char *error) {
            for (const auto &file : written) {
                io->delete_entry(file);
            }
            packages.uninstall_package(*pkg);
            result.error = error;
            return result;
        };

        // The game's executables, and whether it registers itself after all.
        const char16_t drive_letter = drive_to_char16(drive);
        std::vector<std::u16string> executables;
        bool registers_itself = false;
        for (const auto &desc : pkg->file_descriptions) {
            if ((desc.operation != static_cast<std::uint32_t>(loader::ss_op::install)) || desc.target.size() < 3) {
                continue;
            }
            std::u16string target = desc.target;
            if (target[0] == u'!') {
                target[0] = drive_letter;
            }
            const std::u16string low = common::lowercase_ucs2_string(target);
            if (low.find(u"\\private\\10003a3f\\import\\apps\\") != std::u16string::npos) {
                registers_itself = true;
            }
            if (low.compare(1, 10, u":\\sys\\bin\\") == 0 && eka2l1::path_extension(low) == u".exe") {
                executables.push_back(target);
            }
        }
        if (executables.empty()) {
            return fail("the game has no executable");
        }

        // The game's own exe has the package UID as its UID3. Others are helpers
        // (ONE has one); with several and none of them the game's, it is unclear
        // which to start.
        std::u16string executable = executables.front();
        std::uint32_t uid = executables.size() == 1 ? executable_uid(io, executable) : 0;
        for (const auto &candidate : executables) {
            if (executable_uid(io, candidate) == result.package_uid) {
                executable = candidate;
                uid = result.package_uid;
                break;
            }
        }
        if (uid == 0) {
            return fail(executables.size() == 1 ? "could not read the game's executable" : "none of the game's executables has its UID");
        }

        app entry;
        entry.uid = uid;
        entry.executable = executable;
        // The registration holds at most 127 characters; report what it holds.
        entry.caption = (result.title.empty() ? pkg->package_name : result.title).substr(0, 127);
        if (!registers_itself) {
            std::u16string name = eka2l1::filename(executable, true);
            name = name.substr(0, name.size() - 4);
            const std::u16string root = std::u16string(1, executable[0]) + u":";
            const std::u16string registration = root + u"\\private\\10003a3f\\import\\apps\\" + name + u"_reg.rsc";
            const std::u16string localisable = root + u"\\resource\\apps\\" + name + u"_loc.rsc";
            written = { localisable, registration };
            if (!write_guest_file(io, localisable, make_localisable_info(entry.caption, entry.caption))
                || !write_guest_file(io, registration, make_registration(uid, name, u"\\resource\\apps\\" + name + u"_loc", LOCALISABLE_INFO_ID))) {
                return fail("could not write the app registration");
            }

            // Recorded with the package as files to delete on uninstall (FILENULL),
            // so removing the game removes its registration too.
            for (const auto &target : { registration, localisable }) {
                const bool known = std::any_of(pkg->file_descriptions.begin(), pkg->file_descriptions.end(),
                    [&target](const file_description &desc) { return common::compare_ignore_case(desc.target, target) == 0; });
                if (!known) {
                    file_description desc{};
                    desc.target = target;
                    desc.operation = static_cast<std::uint32_t>(loader::ss_op::null);
                    pkg->file_descriptions.push_back(desc);
                }
            }
            packages.save_package(*pkg);
        }
        result.apps.push_back(entry);

        LOG_INFO(PACKAGE, "N-Gage 2.0 game 0x{:X} installed: {}", uid, common::ucs2_to_utf8(entry.caption));
        return result;
    }
}
