// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "engine.h"

#include <kernel/process.h>

#include <algorithm>
#include <cmath>
#include <cstring>

namespace eka2l1::enhance {
    // How far a triangle is grown before it is filled, in guest pixels. The
    // guest's corners are fixed point and the GPU's are floats: without it a
    // corner that lies on a pixel's border can fall on either side.
    static constexpr float GROW = 1.0f / 32.0f;

    // The key colour as a pixel of this format, and the pixel's size.
    static bool key_pixel(const texture_format format, std::uint32_t &raw, std::uint32_t &size) {
        switch (format) {
        case FORMAT_RGB444:
            raw = 0x0F0F;
            size = 2;
            return true;
        case FORMAT_ARGB4444:
            raw = 0xFF0F;
            size = 2;
            return true;
        case FORMAT_RGB565:
            raw = 0xF81F;
            size = 2;
            return true;
        case FORMAT_RGB555:
            raw = 0x7C1F;
            size = 2;
            return true;
        case FORMAT_ARGB1555:
            raw = 0xFC1F;
            size = 2;
            return true;
        case FORMAT_RGB888:
            raw = 0xFF00FF;
            size = 3;
            return true;
        case FORMAT_XRGB8888:
            raw = 0x00FF00FF;
            size = 4;
            return true;
        case FORMAT_ARGB8888:
            raw = 0xFFFF00FF;
            size = 4;
            return true;
        default:
            // Paletted and single-channel buffers have no such colour.
            return false;
        }
    }

    static bool write_guest(kernel::process *pr, std::uint32_t addr, const std::uint8_t *from, std::uint32_t size) {
        while (size) {
            const std::uint32_t chunk = std::min<std::uint32_t>(size, 0x1000 - (addr & 0xFFF));
            void *to = pr->get_ptr_on_addr_space(addr);
            if (!to) {
                return false;
            }

            std::memcpy(to, from, chunk);
            from += chunk;
            addr += chunk;
            size -= chunk;
        }

        return true;
    }

    std::uint64_t fill_key(kernel::process *pr, const target_ref &target, const vertex *corners, const std::size_t count) {
        std::uint32_t raw = 0, size = 0;
        if (!pr || !key_pixel(target.format, raw, size) || !target.width || !target.height) {
            return 0;
        }

        const std::uint32_t pitch = target.pitch ? target.pitch : target.width * size;
        if (pitch < target.width * size) {
            return 0;
        }

        // One row of key pixels, written from as far as a span needs.
        std::vector<std::uint8_t> row(std::size_t(target.width) * size);
        for (std::uint32_t x = 0; x < target.width; x++) {
            std::memcpy(row.data() + std::size_t(x) * size, &raw, size);
        }

        const float width = static_cast<float>(target.width);
        const float height = static_cast<float>(target.height);
        std::uint64_t written = 0;

        for (std::size_t first = 0; first + 3 <= count; first += 3) {
            const vertex *v = corners + first;

            // The GPU draws nothing for a triangle without area.
            const float area = (v[1].x - v[0].x) * (v[2].y - v[0].y) - (v[2].x - v[0].x) * (v[1].y - v[0].y);
            if (area == 0.0f) {
                continue;
            }

            const float top = std::min({ v[0].y, v[1].y, v[2].y }) - GROW;
            const float bottom = std::max({ v[0].y, v[1].y, v[2].y }) + GROW;
            if (!(bottom >= 0.0f) || !(top < height)) {
                continue;
            }

            const int first_row = static_cast<int>(std::floor(std::max(top, 0.0f)));
            const int last_row = static_cast<int>(std::floor(std::min(bottom, height - 1.0f)));

            for (int y = first_row; y <= last_row; y++) {
                // The part of the triangle inside this row of pixels is a
                // convex polygon: its corners are the triangle's corners that
                // lie in the row and the points where an edge crosses the
                // row's upper or lower border.
                const float band_top = static_cast<float>(y) - GROW;
                const float band_bottom = static_cast<float>(y + 1) + GROW;
                float left = INFINITY, right = -INFINITY;

                for (int n = 0; n < 3; n++) {
                    const vertex &a = v[n];
                    const vertex &b = v[(n + 1) % 3];

                    if (a.y >= band_top && a.y <= band_bottom) {
                        left = std::min(left, a.x);
                        right = std::max(right, a.x);
                    }

                    if (a.y == b.y) {
                        continue;
                    }

                    for (const float border : { band_top, band_bottom }) {
                        if ((border - a.y) * (border - b.y) <= 0.0f) {
                            const float x = a.x + (border - a.y) / (b.y - a.y) * (b.x - a.x);
                            left = std::min(left, x);
                            right = std::max(right, x);
                        }
                    }
                }

                left -= GROW;
                right += GROW;
                if (!(right >= 0.0f) || !(left < width)) {
                    continue;
                }

                const std::uint32_t from = static_cast<std::uint32_t>(std::floor(std::max(left, 0.0f)));
                const std::uint32_t to = static_cast<std::uint32_t>(std::floor(std::min(right, width - 1.0f)));
                const std::uint32_t pixels = to - from + 1;

                if (write_guest(pr, target.pixels + static_cast<std::uint32_t>(y) * pitch + from * size, row.data(), pixels * size)) {
                    written += pixels;
                }
            }
        }

        return written;
    }
}
