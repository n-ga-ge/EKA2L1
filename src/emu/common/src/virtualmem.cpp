/*
 * Copyright (c) 2018 EKA2L1 Team.
 * 
 * This file is part of EKA2L1 project 
 * (see bentokun.github.com/EKA2L1).
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#include <common/cvt.h>
#include <common/platform.h>
#include <common/virtualmem.h>

#include <cstdint>

#if EKA2L1_PLATFORM(WEB)
#include <algorithm>
#include <cstring>
#include <map>
#include <mutex>
#include <vector>
#endif

#if EKA2L1_PLATFORM(WIN32)
#include <Windows.h>
#elif EKA2L1_PLATFORM(UNIX) || EKA2L1_PLATFORM(DARWIN)
#include <sys/mman.h>
#include <sys/stat.h>

#include <fcntl.h>
#include <unistd.h>
#endif

namespace eka2l1::common {
#if !EKA2L1_PLATFORM(WIN32)
    // The Symbian memory model works in 4 KB pages, but a host page can be
    // larger: 16 KB on Apple Silicon, 16 or 64 KB on some aarch64 Linux
    // kernels. mprotect(2) rejects a range that is not a whole number of host
    // pages with EINVAL, which used to leave the page PROT_NONE and take the
    // next guest write out with SIGBUS. On a 4 KB host all of this is the
    // identity.
    static std::size_t host_page_size() {
        static const std::size_t size = static_cast<std::size_t>(sysconf(_SC_PAGESIZE));
        return size;
    }

    // Widen the range to the host pages containing it. Only ever touches pages
    // belonging to the same chunk, whose reservation is host-page aligned.
    static void grow_to_host_pages(void *&ptr, std::size_t &size) {
        const std::size_t mask = host_page_size() - 1;
        const std::uintptr_t addr = reinterpret_cast<std::uintptr_t>(ptr);
        const std::uintptr_t aligned = addr & ~static_cast<std::uintptr_t>(mask);
        const std::size_t head = addr - aligned;

        ptr = reinterpret_cast<void *>(aligned);
        size = (size + head + mask) & ~mask;
    }

    // Shrink the range to the host pages it fully covers, so taking one guest
    // page away never revokes a neighbour that is still live. Returns false if
    // nothing is left to act on.
    static bool shrink_to_host_pages(void *&ptr, std::size_t &size) {
        const std::size_t mask = host_page_size() - 1;
        const std::uintptr_t addr = reinterpret_cast<std::uintptr_t>(ptr);
        const std::uintptr_t aligned = (addr + mask) & ~static_cast<std::uintptr_t>(mask);
        const std::size_t head = aligned - addr;

        if (size <= head) {
            return false;
        }

        ptr = reinterpret_cast<void *>(aligned);
        size = (size - head) & ~mask;

        return size != 0;
    }
#endif

#if EKA2L1_PLATFORM(WEB)
    // Address-space reservations for the browser build.
    //
    // Emscripten's mmap() allocates and zero-fills the whole range at once, so
    // reserving a guest chunk's maximum size (tens of megabytes each, most of it
    // never used) would cost that much real memory. Reservations are carved
    // from the end of the wasm heap instead: memory obtained by growing the
    // heap is zero and is not backed by physical pages until first written, and
    // the allocator never gives heap back, so it stays that way. Committing a
    // page is then free, and only pages that were actually committed need
    // clearing before a range is handed out again.
    namespace web_reserve {
        constexpr std::size_t TRACK = 0x1000; // guest page: the unit chunks commit in
        constexpr std::size_t ALIGN = 0x10000;

        struct block {
            std::size_t size;
            std::vector<bool> used; // one flag per TRACK bytes
        };

        std::mutex lock;
        std::map<std::uintptr_t, block> live;
        std::multimap<std::size_t, std::uintptr_t> spare;

        std::map<std::uintptr_t, block>::iterator find(const std::uintptr_t addr) {
            auto it = live.upper_bound(addr);
            if (it == live.begin()) {
                return live.end();
            }
            --it;
            return (addr < it->first + it->second.size) ? it : live.end();
        }

        void *reserve(std::size_t size) {
            size = (size + ALIGN - 1) & ~(ALIGN - 1);

            const std::lock_guard<std::mutex> guard(lock);
            std::uintptr_t addr = 0;

            const auto reuse = spare.find(size);
            if (reuse != spare.end()) {
                addr = reuse->second;
                spare.erase(reuse);
            } else {
                void *raw = sbrk(static_cast<intptr_t>(size + ALIGN));
                if (raw == reinterpret_cast<void *>(-1)) {
                    return nullptr;
                }
                addr = (reinterpret_cast<std::uintptr_t>(raw) + ALIGN - 1) & ~static_cast<std::uintptr_t>(ALIGN - 1);
            }

            live.emplace(addr, block{ size, std::vector<bool>(size / TRACK, false) });
            return reinterpret_cast<void *>(addr);
        }

        // Clears [first, last) page flags, zeroing the pages that were in use.
        void scrub(const std::uintptr_t base, block &blk, std::size_t first, const std::size_t last) {
            while (first < last) {
                if (!blk.used[first]) {
                    first++;
                    continue;
                }
                std::size_t end = first;
                while (end < last && blk.used[end]) {
                    blk.used[end++] = false;
                }
                std::memset(reinterpret_cast<void *>(base + first * TRACK), 0, (end - first) * TRACK);
                first = end;
            }
        }

        bool release(void *ptr) {
            const std::lock_guard<std::mutex> guard(lock);
            const auto it = live.find(reinterpret_cast<std::uintptr_t>(ptr));
            if (it == live.end()) {
                return false;
            }

            scrub(it->first, it->second, 0, it->second.used.size());
            spare.emplace(it->second.size, it->first);
            live.erase(it);
            return true;
        }

        // Returns false when the range is not one of ours (a file mapping, say).
        bool touch(void *ptr, const std::size_t size, const bool in_use) {
            const std::lock_guard<std::mutex> guard(lock);
            const std::uintptr_t addr = reinterpret_cast<std::uintptr_t>(ptr);
            const auto it = find(addr);
            if (it == live.end()) {
                return false;
            }

            const std::size_t offset = addr - it->first;
            const std::size_t last = std::min((offset + size + TRACK - 1) / TRACK, it->second.used.size());

            if (in_use) {
                for (std::size_t page = offset / TRACK; page < last; page++) {
                    it->second.used[page] = true;
                }
            } else {
                // Only whole pages inside the range go away; a decommitted
                // page reads as zero when it is committed again.
                const std::size_t first = (offset + TRACK - 1) / TRACK;
                const std::size_t whole_last = std::min((offset + size) / TRACK, it->second.used.size());
                if (first < whole_last) {
                    scrub(it->first, it->second, first, whole_last);
                }
            }

            return true;
        }
    }
#endif

#if EKA2L1_PLATFORM(WEB)
    // Sizes of live file mappings, which munmap() needs back.
    static std::mutex web_file_maps_lock;
    static std::map<void *, std::size_t> web_file_maps;
#endif

    void *map_memory(const std::size_t size) {
#if EKA2L1_PLATFORM(WEB)
        return web_reserve::reserve(size);
#elif EKA2L1_PLATFORM(WIN32)
        return VirtualAlloc(nullptr, size,
            MEM_RESERVE, PAGE_NOACCESS);
#else
        return mmap(nullptr, size, PROT_NONE,
            MAP_ANONYMOUS | MAP_PRIVATE, 0, 0);
#endif
    }

    bool unmap_memory(void *ptr, const std::size_t size) {
#if EKA2L1_PLATFORM(WEB)
        if (web_reserve::release(ptr)) {
            return true;
        }
#endif
#if EKA2L1_PLATFORM(WIN32)
        const auto result = VirtualFree(ptr, 0, MEM_RELEASE);

        if (!result) {
#else
        const int result = munmap(ptr, size);

        if (result == -1) {
#endif
            return false;
        }

        return true;
    }

    bool commit(void *ptr, const std::size_t size, const prot commit_prot) {
#if EKA2L1_PLATFORM(WEB)
        // There is no page protection in wasm; just note what is in use.
        if (web_reserve::touch(ptr, size, true)) {
            return true;
        }
#endif
#if EKA2L1_PLATFORM(WIN32)
        DWORD oldprot = 0;

        const auto res = VirtualAlloc(ptr, size, MEM_COMMIT,
            translate_protection(commit_prot));

        if (!res) {
#else
        void *mp_ptr = ptr;
        std::size_t mp_size = size;
        grow_to_host_pages(mp_ptr, mp_size);

        const int result = mprotect(mp_ptr, mp_size, translate_protection(commit_prot));

        if (result == -1) {
#endif
            return false;
        }

        return true;
    }

    bool decommit(void *ptr, const std::size_t size) {
#if EKA2L1_PLATFORM(WEB)
        if (web_reserve::touch(ptr, size, false)) {
            return true;
        }
#endif
#if EKA2L1_PLATFORM(WIN32)
        const auto res = VirtualFree(ptr, size, MEM_DECOMMIT);

        if (!res) {
#else
        void *mp_ptr = ptr;
        std::size_t mp_size = size;
        if (!shrink_to_host_pages(mp_ptr, mp_size)) {
            return true;
        }

        const auto result = mprotect(mp_ptr, mp_size, PROT_NONE);

        if (result == -1) {
#endif
            return false;
        }

        return true;
    }

    bool change_protection(void *ptr, const std::size_t size,
        const prot new_prot) {
#if EKA2L1_PLATFORM(WIN32)
        DWORD oldprot = 0;
        const auto res = VirtualProtect(ptr, size,
            translate_protection(new_prot), &oldprot);

        if (!res) {
#else
        void *mp_ptr = ptr;
        std::size_t mp_size = size;
        grow_to_host_pages(mp_ptr, mp_size);

        const int result = mprotect(mp_ptr, mp_size, translate_protection(new_prot));

        if (result == -1) {
#endif
            return false;
        }

        return true;
    }

    bool is_memory_wx_exclusive() {
#if EKA2L1_PLATFORM(UWP) || EKA2L1_PLATFORM(IOS) || EKA2L1_PLATFORM(ANDROID)
        return true;
#else
        return false;
#endif
    }

    int get_host_page_size() {
#if EKA2L1_PLATFORM(WIN32)
        SYSTEM_INFO system_info = {};
        GetSystemInfo(&system_info);

        return system_info.dwPageSize;
#else
        return sysconf(_SC_PAGESIZE);
#endif
    }

    void *map_file(const std::string &file_name, const prot perm, const std::size_t size, const bool is_private) {
#if EKA2L1_PLATFORM(WIN32)
        DWORD desired_access = 0;
        DWORD share_mode = 0;
        DWORD page_type = 0;
        DWORD map_type = 0;
        DWORD open_type = 0;

        switch (perm) {
        case prot_read: {
            desired_access = GENERIC_READ;
            share_mode = FILE_SHARE_READ;
            page_type = PAGE_READONLY;
            open_type = OPEN_ALWAYS;
            map_type = FILE_MAP_READ;

            break;
        }

        case prot_write: {
            desired_access = GENERIC_WRITE;
            share_mode = FILE_SHARE_WRITE;
            page_type = PAGE_READWRITE;
            open_type = OPEN_ALWAYS;
            map_type = FILE_MAP_WRITE;

            break;
        }

        case prot_read_write: {
            desired_access = GENERIC_WRITE | GENERIC_READ;
            share_mode = FILE_SHARE_WRITE | FILE_SHARE_READ;
            page_type = PAGE_READWRITE;
            open_type = OPEN_ALWAYS;
            map_type = FILE_MAP_WRITE | FILE_MAP_READ;

            break;
        }

        default: {
            return nullptr;
        }
        }

        if (is_private) {
            map_type = FILE_MAP_COPY;
        }

        const std::wstring filename_w = common::utf8_to_wstr(file_name);
        HANDLE file_handle = CreateFileW(filename_w.c_str(), desired_access, share_mode,
            NULL, open_type, NULL, NULL);

        if (file_handle == INVALID_HANDLE_VALUE) {
            return nullptr;
        }

        std::size_t map_size = size;
        if (map_size == 0) {
            DWORD size_high = 0;
            DWORD size_low = GetFileSize(file_handle, &size_high);

            map_size = (static_cast<std::size_t>(size_high) << 32) | size_low;
        }

        HANDLE map_file_handle = CreateFileMappingW(file_handle, NULL, page_type,
            map_size >> 32, static_cast<DWORD>(map_size), NULL);

        if (!map_file_handle || map_file_handle == INVALID_HANDLE_VALUE) {
            return nullptr;
        }

        auto map_ptr = MapViewOfFile(map_file_handle, map_type, 0, 0, 0);
#else
        int open_mode = 0;
        const int prot_mode = translate_protection(perm);

        switch (perm) {
        case prot_read: {
            open_mode = O_RDONLY;
            break;
        }

        case prot_write: {
            open_mode = O_WRONLY | O_CREAT;
            break;
        }

        case prot_read_write: {
            open_mode = O_RDWR | O_CREAT;
            break;
        }

        default: {
            return nullptr;
        }
        }

        int file_handle = open(file_name.c_str(), open_mode, 0);

        if (file_handle == -1) {
            return nullptr;
        }

        std::size_t map_size = size;

        if (perm == prot_read || (perm == prot_read_write && size == 0)) {
            struct stat file_stat;
            stat(file_name.c_str(), &file_stat);

            map_size = file_stat.st_size;
        }

        auto map_ptr = mmap(nullptr, map_size, prot_mode, MAP_PRIVATE, file_handle, 0);

#if EKA2L1_PLATFORM(WEB)
        if (map_ptr != MAP_FAILED) {
            const std::lock_guard<std::mutex> guard(web_file_maps_lock);
            web_file_maps[map_ptr] = map_size;
        }
#endif
#endif

        return map_ptr;
    }

    bool unmap_file(void *ptr) {
#if EKA2L1_PLATFORM(WIN32)
        UnmapViewOfFile(ptr);
#elif EKA2L1_PLATFORM(WEB)
        // A file mapping is a heap copy of the file here, so leaving it mapped
        // is a real leak (the 18 MB ROM, once per emulator reset).
        std::size_t size = 0;
        {
            const std::lock_guard<std::mutex> guard(web_file_maps_lock);
            const auto it = web_file_maps.find(ptr);
            if (it == web_file_maps.end()) {
                return true;
            }
            size = it->second;
            web_file_maps.erase(it);
        }
        munmap(ptr, size);
#endif

        return true;
    }

    void *align_address_to_host_page(void *original) {
        return reinterpret_cast<void *>(reinterpret_cast<std::uint64_t>(original) & ~(get_host_page_size() - 1));
    }
}
