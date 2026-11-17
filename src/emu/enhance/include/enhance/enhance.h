// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace eka2l1 {
    class system;
}

namespace eka2l1::control {
    struct request;
    struct response;
}

namespace eka2l1::enhance {
    enum texture_format : std::uint8_t {
        FORMAT_NONE,
        FORMAT_P8,
        FORMAT_RGB444,
        FORMAT_ARGB4444,
        FORMAT_RGB565,
        FORMAT_RGB555,
        FORMAT_ARGB1555,
        FORMAT_RGB888,
        FORMAT_ARGB8888,
        FORMAT_XRGB8888,
        FORMAT_A8,
        FORMAT_L8
    };

    enum blend_mode : std::uint8_t {
        BLEND_NONE,
        BLEND_ALPHA,
        BLEND_ADD,
        BLEND_MULTIPLY,
        // Texels with alpha zero are not drawn; the rest replace the pixel.
        BLEND_KEY
    };

    enum depth_mode : std::uint8_t {
        DEPTH_NONE,
        DEPTH_LESS,
        DEPTH_LEQUAL,
        DEPTH_GREATER,
        DEPTH_GEQUAL
    };

    // One corner of a triangle, in the guest's own screen pixels.
    struct vertex {
        float x = 0, y = 0;
        // Depth as the engine has it; only its order matters.
        float z = 0;
        // The divisor of the perspective projection, or 1 when the engine
        // gives none (the texture is then mapped without perspective).
        float w = 1;
        // In texels of the draw's texture.
        float u = 0, v = 0;
        // 0xAARRGGBB, multiplied with the texture.
        std::uint32_t color = 0xFFFFFFFF;
    };

    // A texture as it lies in guest memory when it was drawn with.
    struct texture_ref {
        std::uint32_t id = 0;
        std::uint32_t pixels = 0;
        std::uint32_t width = 0, height = 0;
        std::uint32_t pitch = 0;
        std::uint32_t palette = 0;
        texture_format format = FORMAT_NONE;
        texture_format palette_format = FORMAT_NONE;
        bool has_key = false;
        std::uint32_t key = 0;

        bool operator==(const texture_ref &other) const {
            return id == other.id && pixels == other.pixels && width == other.width && height == other.height
                && pitch == other.pitch && palette == other.palette && format == other.format
                && palette_format == other.palette_format && has_key == other.has_key && key == other.key;
        }
    };

    // The buffer the guest's rasteriser draws into.
    struct target_ref {
        std::uint32_t pixels = 0;
        std::uint32_t width = 0, height = 0;
        std::uint32_t pitch = 0;
        texture_format format = FORMAT_NONE;
    };

    // Consecutive triangles drawn with the same texture and state.
    struct draw {
        std::uint32_t first_vertex = 0;
        // A multiple of three: the vertices are a plain triangle list.
        std::uint32_t vertex_count = 0;
        // Index into frame::textures, or -1.
        std::int32_t texture = -1;
        blend_mode blend = BLEND_NONE;
        depth_mode depth = DEPTH_NONE;
        // Index of the profile hook that produced it.
        std::uint16_t hook = 0;
    };

    // Everything the guest handed its rasteriser between two frame boundaries.
    struct frame {
        std::uint64_t number = 0;
        std::uint32_t process_uid = 0;
        std::uint32_t width = 176, height = 208;
        bool has_target = false;
        target_ref target;
        std::vector<vertex> vertices;
        std::vector<draw> draws;
        std::vector<texture_ref> textures;
    };

    /**
     * Receives every completed frame, on the thread that runs the guest. Set by
     * whatever draws the frames; without one they are only kept for
     * `GET /v1/enhance/frame`.
     */
    class sink {
    public:
        virtual ~sink() = default;
        virtual void frame_complete(const std::shared_ptr<const frame> &completed) = 0;
    };

    void set_sink(system *sys, sink *target);

    // The last completed frame, or null.
    std::shared_ptr<const frame> last_frame(system *sys);

    /**
     * Whether hooks marked `skip` return from the guest function instead of
     * letting it draw. Off by default: a profile is first proven by comparing
     * what it captures with what the guest drew itself.
     */
    void set_replace(system *sys, bool replace);

    /**
     * Read a texture or the target out of the memory of the process with this
     * UID as 0xAABBGGRR words (R in the first byte), row after row.
     *
     * \returns False when the memory is not mapped or the description is unusable.
     */
    bool decode_texture(system *sys, std::uint32_t process_uid, const texture_ref &texture, std::vector<std::uint32_t> &rgba);

    /**
     * Serve the `/v1/debug` and `/v1/enhance` routes of the control API.
     *
     * \returns False when the request is for neither.
     */
    bool handle_request(system *sys, const control::request &req, control::response &res);
}
