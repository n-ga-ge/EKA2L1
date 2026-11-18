// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include "layer.h"
#include "engine.h"

#include <common/log.h>
#include <config/config.h>
#include <drivers/graphics/graphics.h>
#include <drivers/itc.h>
#include <kernel/kernel.h>
#include <services/window/window.h>
#include <system/epoc.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <string>

namespace eka2l1::enhance {
    // Bytes of one vertex: a clip-space position, a texture coordinate, a
    // colour, a palette row.
    static constexpr std::size_t VERTEX_SIZE = 32;
    // The first six vertices of the buffer are the rectangle that covers the screen.
    static constexpr std::uint32_t QUAD_VERTICES = 6;

    static constexpr std::size_t MAX_CACHED_TEXTURES = 256;
    static constexpr std::size_t MAX_CACHED_BYTES = 64 * 1024 * 1024;
    // How much guest memory is hashed for one picture, to find textures whose
    // content changed. Those not reached wait for the next picture.
    static constexpr std::size_t HASH_BYTES_A_PICTURE = 768 * 1024;

    static constexpr float MAX_AUTOMATIC_SCALE = 8.0f;
    // The screen keeps the layer's scale for this many presents without a
    // pixel in the key colour, so that a picture without 3D now and then does
    // not resize the screen texture twice.
    static constexpr std::uint32_t PRESENTS_KEPT = 30;

    static const char *SHADER_HEADER_ES = "#version 300 es\n"
                                          "precision highp float;\n"
                                          "precision highp int;\n";
    static const char *SHADER_HEADER_DESKTOP = "#version 140\n"
                                               "#extension GL_ARB_explicit_attrib_location : require\n";

    static const char *VERTEX_SHADER = R"glsl(
layout (location = 0) in vec4 inPosition;
layout (location = 1) in vec2 inTexCoord;
layout (location = 2) in vec4 inColor;
layout (location = 3) in float inRow;

out vec2 vTexCoord;
out vec4 vColor;
out float vRow;

void main() {
    // The position comes multiplied by the triangle's own w, so that the
    // rasteriser interpolates the rest with perspective exactly when the
    // engine gave three different w.
    gl_Position = inPosition;
    vTexCoord = inTexCoord;
    vColor = inColor;
    vRow = inRow;
}
)glsl";

    static const char *TRIANGLE_SHADER = R"glsl(
uniform sampler2D uTexture;
// The guest's picture: triangles are drawn only on its pixels that have the
// key colour in them, so whatever else is on the screen stays as it is.
uniform sampler2D uScreen;
// A texture with palette rows: uTexture holds its texel indices (red, a
// byte), this its table, a row of colours for each palette.
uniform sampler2D uTable;
// x: one when texels without alpha are not drawn; y: one when there is a texture;
// z: one when it has palette rows; w: one to smooth such a texture.
uniform vec4 uMode;
// x, y: screen pixels to a pixel of the picture.
uniform vec4 uView;

in vec2 vTexCoord;
in vec4 vColor;
in float vRow;
out vec4 oColor;

// The colour of a texel of a texture with palette rows, the texture repeating.
vec4 tableTexel(ivec2 at, ivec2 size, int row) {
    at -= size * ivec2(floor(vec2(at) / vec2(size)));
    int index = int(texelFetch(uTexture, at, 0).r * 255.0 + 0.5);
    return texelFetch(uTable, ivec2(index, row), 0);
}

vec4 tableColor() {
    ivec2 size = textureSize(uTexture, 0);
    // Each pixel takes the palette its interpolated row names.
    int row = clamp(int(floor(vRow)), 0, textureSize(uTable, 0).y - 1);
    vec2 at = vTexCoord * vec2(size);
    if (uMode.w < 0.5) {
        return tableTexel(ivec2(floor(at)), size, row);
    }

    // Smoothed: the four colours around the point, not their indices.
    vec2 from = at - vec2(0.5);
    ivec2 base = ivec2(floor(from));
    vec2 part = from - vec2(base);
    vec4 top = mix(tableTexel(base, size, row), tableTexel(base + ivec2(1, 0), size, row), part.x);
    vec4 bottom = mix(tableTexel(base + ivec2(0, 1), size, row), tableTexel(base + ivec2(1, 1), size, row), part.x);
    return mix(top, bottom, part.y);
}

void main() {
    ivec2 last = textureSize(uScreen, 0) - ivec2(1);
    vec3 under = texelFetch(uScreen, clamp(ivec2(floor(gl_FragCoord.xy / uView.xy)), ivec2(0), last), 0).rgb;
    if (clamp(min(under.r, under.b) - under.g, 0.0, 1.0) < 0.2) {
        discard;
    }

    vec4 color = vColor;

    if (uMode.y > 0.5) {
        vec4 texel = (uMode.z > 0.5) ? tableColor() : texture(uTexture, vTexCoord);
        if (uMode.x > 0.5 && texel.a < 0.5) {
            discard;
        }
        color *= texel;
    }

    oColor = color;
}
)glsl";

    // The guest's picture around the triangles. `vTexCoord` is in guest pixels.
    static const char *COMPOSE_SHADER = R"glsl(
uniform sampler2D uScreen;
// x: the pass. Zero: under the triangles, where they may be drawn and where
// a smoothed pixel takes from such a pixel (everything else is the plain copy
// the screen made already). Two: the same, but everywhere (a test frame's own
// picture, which the screen did not copy). One: over the triangles.
// y: one to smooth the picture between its pixels; z, w: its size in pixels.
uniform vec4 uParams;

in vec2 vTexCoord;
in vec4 vColor;
in float vRow;
out vec4 oColor;

// How far a pixel in the key colour looks for one of the picture.
const int REACH = 3;
// How far from the key colour a pixel can be that the game mixed with it.
const int MIXED_REACH = 2;
// How much of the key colour makes a pixel one that may be mixed with it.
const float MIXED_FROM = 0.2;

bool isKey(vec3 c) {
    return c.r > 0.96 && c.g < 0.04 && c.b > 0.96;
}

// How much of a colour is the key colour, if the rest of it is grey: one for
// the key colour itself, zero for every grey, and for a grey drawn over the
// key colour with some transparency, that transparency.
float keyShare(vec3 c) {
    return clamp(min(c.r, c.b) - c.g, 0.0, 1.0);
}

ivec2 last;

vec3 pixel(ivec2 at) {
    return texelFetch(uScreen, clamp(at, ivec2(0), last), 0).rgb;
}

// The picture at this point: its pixel, or, smoothed, the four around it
// without those that have the key colour in them.
vec3 picture(vec3 here) {
    if (uParams.y < 0.5) {
        return here;
    }

    vec2 from = vTexCoord - vec2(0.5);
    ivec2 base = ivec2(floor(from));
    vec2 part = from - vec2(base);
    vec3 sum = vec3(0.0);
    float total = 0.0;

    for (int j = 0; j < 2; j++) {
        for (int i = 0; i < 2; i++) {
            vec3 c = pixel(base + ivec2(i, j));
            float weight = (i == 0 ? 1.0 - part.x : part.x) * (j == 0 ? 1.0 - part.y : part.y);
            if (keyShare(c) < MIXED_FROM) {
                sum += c * weight;
                total += weight;
            }
        }
    }

    return total > 0.0 ? sum / total : here;
}

void main() {
    last = ivec2(uParams.zw) - ivec2(1);
    ivec2 cell = clamp(ivec2(floor(vTexCoord)), ivec2(0), last);
    vec3 here = pixel(cell);
    bool key = isKey(here);
    float share = key ? 1.0 : keyShare(here);
    // Triangles are drawn on this pixel (see the triangle shader).
    bool open = share >= MIXED_FROM;

    // A pixel with a good part of the key colour in it, next to pixels in the
    // key colour: something the game drew over its 3D with transparency (the
    // soft edge of an overlay). The key colour's part of it is where the 3D
    // shows through.
    bool mixed = false;
    if (!key && open) {
        for (int dy = -MIXED_REACH; dy <= MIXED_REACH && !mixed; dy++) {
            for (int dx = -MIXED_REACH; dx <= MIXED_REACH; dx++) {
                ivec2 at = cell + ivec2(dx, dy);
                if (at.x >= 0 && at.y >= 0 && at.x <= last.x && at.y <= last.y && isKey(texelFetch(uScreen, at, 0).rgb)) {
                    mixed = true;
                    break;
                }
            }
        }
    }

    if (uParams.x > 0.5 && uParams.x < 1.5) {
        // Over the triangles, drawn with a blend that keeps `alpha` of what
        // is there and adds this colour. Only where triangles may have drawn.
        if (key || !open) {
            discard;
        }

        if (mixed) {
            oColor = vec4(max(here - share * vec3(1.0, 0.0, 1.0), vec3(0.0)), share);
        } else {
            oColor = vec4(picture(here), 0.0);
        }
        return;
    }

    if (!key && !mixed) {
        bool needed = uParams.x > 1.5 || open;
        if (!needed && uParams.y > 0.5) {
            // Smoothed, the plain copy mixes the key colour into the pixels
            // around it.
            ivec2 base = ivec2(floor(vTexCoord - vec2(0.5)));
            for (int j = 0; j < 2; j++) {
                for (int i = 0; i < 2; i++) {
                    needed = needed || keyShare(pixel(base + ivec2(i, j))) >= MIXED_FROM;
                }
            }
        }

        if (!needed) {
            discard;
        }

        oColor = vec4(picture(here), 1.0);
        return;
    }

    // Under the triangles: what the game had there before its 3D is not
    // known, so take the nearest pixel that has nothing of the key colour. It
    // shows only where a triangle touches this pixel without covering all of
    // it.
    float best = 1.0e9;
    vec3 found = vec3(0.0);

    for (int dy = -REACH; dy <= REACH; dy++) {
        for (int dx = -REACH; dx <= REACH; dx++) {
            ivec2 at = cell + ivec2(dx, dy);
            if (at.x < 0 || at.y < 0 || at.x > last.x || at.y > last.y) {
                continue;
            }

            vec3 c = texelFetch(uScreen, at, 0).rgb;
            if (keyShare(c) >= MIXED_FROM) {
                continue;
            }

            vec2 away = vec2(at) + vec2(0.5) - vTexCoord;
            float apart = dot(away, away);
            if (apart < best) {
                best = apart;
                found = c;
            }
        }
    }

    // Deep inside the 3D nothing is near: black, which shows only in a gap
    // between triangles.
    oColor = vec4(found, 1.0);
}
)glsl";

    static window_server *window_server_of(system *sys) {
        kernel_system *k = sys ? sys->get_kernel_system() : nullptr;
        if (!k) {
            return nullptr;
        }

        return reinterpret_cast<window_server *>(k->get_by_name<service::server>(
            get_winserv_name_by_epocver(sys->get_symbian_version_use())));
    }

    // Whether the picture the guest presented has a pixel in the key colour.
    static bool picture_has_key(epoc::screen *scr) {
        const std::uint8_t *pixels = scr->screen_buffer_ptr();
        if (!pixels) {
            return true;
        }

        const eka2l1::vec2 size = scr->current_mode().size;
        const std::uint32_t pitch = scr->screen_buffer_byte_width(scr->dsa_disp_mode);

        for (int y = 0; y < size.y; y++) {
            const std::uint8_t *row = pixels + std::size_t(y) * pitch;

            switch (scr->dsa_disp_mode) {
            case epoc::display_mode::color4k:
                for (int x = 0; x < size.x; x++) {
                    std::uint16_t pixel;
                    std::memcpy(&pixel, row + x * 2, 2);
                    if ((pixel & 0x0FFF) == 0x0F0F) {
                        return true;
                    }
                }
                break;

            case epoc::display_mode::color64k:
                for (int x = 0; x < size.x; x++) {
                    std::uint16_t pixel;
                    std::memcpy(&pixel, row + x * 2, 2);
                    if (pixel == 0xF81F) {
                        return true;
                    }
                }
                break;

            case epoc::display_mode::color16m:
                for (int x = 0; x < size.x; x++) {
                    if (row[x * 3] == 0xFF && row[x * 3 + 1] == 0 && row[x * 3 + 2] == 0xFF) {
                        return true;
                    }
                }
                break;

            case epoc::display_mode::color16mu:
            case epoc::display_mode::color16ma:
            case epoc::display_mode::color16map:
                for (int x = 0; x < size.x; x++) {
                    if (row[x * 4] == 0xFF && row[x * 4 + 1] == 0 && row[x * 4 + 2] == 0xFF) {
                        return true;
                    }
                }
                break;

            default:
                // A depth this does not read: let the shader decide.
                return true;
            }
        }

        return false;
    }

    layer::layer(system *sys, engine &owner)
        : sys_(sys)
        , engine_(owner) {
    }

    bool layer::wanted() {
        return scale_ != 0 || automatic_;
    }

    bool layer::failed() {
        return broken_;
    }

    bool layer::enabled() {
        const std::lock_guard<std::mutex> guard(lock_);
        return wanted();
    }

    bool layer::automatic() {
        const std::lock_guard<std::mutex> guard(lock_);
        return automatic_;
    }

    bool layer::linear() {
        const std::lock_guard<std::mutex> guard(lock_);
        return linear_;
    }

    float layer::scale_in_use() {
        const std::lock_guard<std::mutex> guard(lock_);
        return wanted() ? scale_in_use_ : 0.0f;
    }

    std::uint64_t layer::composed() {
        const std::lock_guard<std::mutex> guard(lock_);
        return composed_;
    }

    std::uint64_t layer::presents() {
        const std::lock_guard<std::mutex> guard(lock_);
        return presents_;
    }

    std::size_t layer::cached_textures() {
        const std::lock_guard<std::mutex> guard(lock_);
        return cache_size_;
    }

    std::uint64_t layer::uploads() {
        const std::lock_guard<std::mutex> guard(lock_);
        return uploads_;
    }

    void layer::set_linear(const bool linear) {
        const std::lock_guard<std::mutex> guard(lock_);
        linear_ = linear;
    }

    void layer::attach(const bool on) {
        window_server *server = window_server_of(sys_);
        if (!server) {
            return;
        }

        for (epoc::screen *scr = server->get_screens(); scr; scr = scr->next) {
            if (on) {
                scr->compositor = this;
            } else {
                epoc::screen_compositor *mine = this;
                scr->compositor.compare_exchange_strong(mine, nullptr);
            }
        }
    }

    void layer::configure(const std::uint32_t scale, const bool automatic) {
        bool on = false;
        {
            const std::lock_guard<std::mutex> guard(lock_);
            scale_ = automatic ? 0 : scale;
            automatic_ = automatic;
            on = wanted();

            if (!on) {
                shown_.reset();
                keep_ = 0;
                scale_in_use_ = 0;
            } else if (!automatic_) {
                scale_in_use_ = static_cast<float>(scale_);
            }
        }

        if (!reset_callback_added_) {
            reset_callback_added_ = true;

            // A reset makes new screens, which know nothing of the layer.
            sys_->add_system_reset_callback([this](system *) {
                attach(enabled());
            });
        }

        attach(on);

        if (automatic) {
            // What the screens are shown at now, until a picture says more.
            window_server *server = window_server_of(sys_);
            epoc::screen *scr = server ? server->get_screens() : nullptr;
            const float native = scr ? std::min(scr->logic_scale_factor_x, scr->logic_scale_factor_y) : 1.0f;

            const std::lock_guard<std::mutex> guard(lock_);
            scale_in_use_ = std::isfinite(native) ? std::clamp(native, 1.0f, MAX_AUTOMATIC_SCALE) : 1.0f;
        }

        if (!on && driver_ && driver_ == sys_->get_graphics_driver()) {
            drivers::graphics_command_builder builder;
            drop_textures(&builder);

            drivers::command_list list = builder.retrieve_command_list();
            driver_->submit_command_list(list);
        }
    }

    void layer::frame_complete(const std::shared_ptr<const frame> &completed) {
        const std::lock_guard<std::mutex> guard(lock_);
        if (!completed) {
            shown_.reset();
            keep_ = 0;
        } else if (wanted() && !completed->draws.empty()) {
            // A frame without triangles (a menu, or a pause over the last
            // picture) leaves the one before it in place: if the guest's
            // picture still has pixels in the key colour, they are of that
            // frame.
            shown_ = completed;
        }
    }

    float layer::screen_scale(epoc::screen *scr, const float usual) {
        const std::lock_guard<std::mutex> guard(lock_);
        if (!wanted() || !shown_ || !keep_) {
            return usual;
        }

        if (automatic_) {
            const float native = std::min(scr->logic_scale_factor_x, scr->logic_scale_factor_y);
            scale_in_use_ = std::isfinite(native) ? std::clamp(native, 1.0f, MAX_AUTOMATIC_SCALE) : 1.0f;
        } else {
            scale_in_use_ = static_cast<float>(scale_);
        }

        return scale_in_use_;
    }

    bool layer::compose(epoc::screen *scr, drivers::graphics_driver *driver, kernel_system *) {
        return compose_picture(scr, driver, false);
    }

    bool layer::compose_redrawn(epoc::screen *scr, drivers::graphics_driver *driver) {
        return compose_picture(scr, driver, true);
    }

    bool layer::compose_picture(epoc::screen *scr, drivers::graphics_driver *driver, const bool from_screen) {
        {
            const std::lock_guard<std::mutex> guard(lock_);
            presents_++;
            if (!wanted()) {
                return false;
            }
        }

        // The frame that is in the picture being presented is usually still
        // being captured: its end is the start of the next one.
        engine_.complete_at_present();

        std::shared_ptr<const frame> shown;
        bool linear = false;
        {
            const std::lock_guard<std::mutex> guard(lock_);
            shown = shown_;
            linear = linear_;
        }

        if (scr->is_framebuffer_upside_down()) {
            // Not handled: let the guest draw its 3D itself.
            broken_ = true;
            return false;
        }

        if (!shown) {
            return false;
        }

        // Without a pixel in the key colour nothing of the frame would show,
        // and the plain copy of the picture is right as it is.
        // Through the window server the guest's picture is a bitmap of its own,
        // not the screen's framebuffer, and is not looked for here: the
        // triangles go only where the screen texture has the key colour.
        const bool has_key = !shown->screen_pixels.empty() || from_screen || picture_has_key(scr);
        {
            const std::lock_guard<std::mutex> guard(lock_);
            if (has_key) {
                keep_ = PRESENTS_KEPT;
            } else if (keep_) {
                keep_--;
            }
        }

        return has_key && render(scr, driver, shown, linear, from_screen);
    }

    void layer::inject(const std::shared_ptr<const frame> &injected) {
        {
            const std::lock_guard<std::mutex> guard(lock_);
            if (!wanted()) {
                return;
            }

            shown_ = injected;
            keep_ = PRESENTS_KEPT;
        }

        window_server *server = window_server_of(sys_);
        drivers::graphics_driver *driver = sys_->get_graphics_driver();
        if (!server || !driver) {
            return;
        }

        bool linear = false;
        {
            const std::lock_guard<std::mutex> guard(lock_);
            linear = linear_;
        }

        // The guest may be paused or showing a still picture: draw now, with
        // the picture it presented last, and have the frontend show it.
        for (epoc::screen *scr = server->get_screens(); scr; scr = scr->next) {
            if (scr->compositor.load() != this || !scr->screen_texture) {
                continue;
            }

            scr->set_native_scale_factor(driver, scr->logic_scale_factor_x, scr->logic_scale_factor_y);
            if (render(scr, driver, injected, linear)) {
                scr->fire_screen_redraw_callbacks(true);
            }
        }
    }

    bool layer::ensure_resources(drivers::graphics_driver *driver) {
        if (driver != driver_) {
            // Another driver: what was made with the old one went with it.
            driver_ = driver;
            triangle_program_ = compose_program_ = vertex_buffer_ = input_layout_ = 0;
            screen_copy_ = 0;
            screen_texture_ = 0;
            cache_.clear();
            cache_bytes_ = 0;
            resources_failed_ = false;
            broken_ = false;
        }

        if (triangle_program_ && compose_program_ && vertex_buffer_ && input_layout_) {
            return true;
        }

        if (resources_failed_) {
            return false;
        }

        // Tried once: a shader that does not compile will not on the next
        // picture. Until it worked, the guest is not stopped from drawing.
        resources_failed_ = true;
        broken_ = true;

        if (driver->get_current_api() != drivers::graphic_api::opengl) {
            LOG_ERROR(SERVICE_WINDOW, "The enhancement layer needs the OpenGL graphics backend");
            return false;
        }

        const std::string header = driver->is_stricted() ? SHADER_HEADER_ES : SHADER_HEADER_DESKTOP;
        auto module_of = [&](const char *body, const drivers::shader_module_type type, const char *name) {
            const std::string source = header + body;
            std::string log;
            const drivers::handle made = drivers::create_shader_module(driver, source.data(), source.size(), type, &log);
            if (!made) {
                LOG_ERROR(SERVICE_WINDOW, "The enhancement layer's {} shader does not compile: {}", name, log);
            }
            return made;
        };

        const drivers::handle vertex = module_of(VERTEX_SHADER, drivers::shader_module_type::vertex, "vertex");
        const drivers::handle triangle = module_of(TRIANGLE_SHADER, drivers::shader_module_type::fragment, "triangle");
        const drivers::handle compose = module_of(COMPOSE_SHADER, drivers::shader_module_type::fragment, "compose");
        if (!vertex || !triangle || !compose) {
            return false;
        }

        drivers::shader_program_metadata triangle_meta(nullptr), compose_meta(nullptr);
        std::string log;
        triangle_program_ = drivers::create_shader_program(driver, vertex, triangle, &triangle_meta, &log);
        compose_program_ = drivers::create_shader_program(driver, vertex, compose, &compose_meta, &log);
        if (!triangle_program_ || !compose_program_ || !triangle_meta.is_available() || !compose_meta.is_available()) {
            LOG_ERROR(SERVICE_WINDOW, "The enhancement layer's shaders do not link: {}", log);
            triangle_program_ = compose_program_ = 0;
            return false;
        }

        texture_loc_ = triangle_meta.get_uniform_binding("uTexture");
        mode_loc_ = triangle_meta.get_uniform_binding("uMode");
        triangle_screen_loc_ = triangle_meta.get_uniform_binding("uScreen");
        view_loc_ = triangle_meta.get_uniform_binding("uView");
        table_loc_ = triangle_meta.get_uniform_binding("uTable");
        screen_loc_ = compose_meta.get_uniform_binding("uScreen");
        params_loc_ = compose_meta.get_uniform_binding("uParams");

        drivers::input_descriptor layout[4] = {};
        layout[0].location = 0;
        layout[0].offset = 0;
        layout[0].set_format(4, drivers::data_format::sfloat);
        layout[1].location = 1;
        layout[1].offset = 16;
        layout[1].set_format(2, drivers::data_format::sfloat);
        layout[2].location = 2;
        layout[2].offset = 24;
        layout[2].set_format(4, drivers::data_format::byte);
        layout[2].set_normalized(true);
        layout[3].location = 3;
        layout[3].offset = 28;
        layout[3].set_format(1, drivers::data_format::sfloat);
        for (drivers::input_descriptor &one : layout) {
            one.stride = static_cast<int>(VERTEX_SIZE);
            one.buffer_slot = 0;
        }

        input_layout_ = drivers::create_input_descriptors(driver, layout, 4);
        vertex_buffer_ = drivers::create_buffer(driver, nullptr, VERTEX_SIZE * QUAD_VERTICES,
            static_cast<drivers::buffer_upload_hint>(drivers::buffer_upload_dynamic | drivers::buffer_upload_draw));

        if (!input_layout_ || !vertex_buffer_) {
            return false;
        }

        resources_failed_ = false;
        broken_ = false;
        return true;
    }

    void layer::drop_textures(drivers::graphics_command_builder *builder) {
        if (builder) {
            for (const cached_texture &entry : cache_) {
                builder->destroy(entry.handle);
                if (entry.table) {
                    builder->destroy(entry.table);
                }
            }

            if (screen_texture_) {
                builder->destroy(screen_texture_);
            }

            if (screen_copy_) {
                builder->destroy_bitmap(screen_copy_);
            }
        }

        screen_copy_ = 0;
        cache_.clear();
        cache_bytes_ = 0;
        screen_texture_ = 0;

        const std::lock_guard<std::mutex> guard(lock_);
        cache_size_ = 0;
    }

    // Bytes a cached texture takes on the GPU.
    static std::size_t gpu_bytes(const texture_ref &ref) {
        const std::size_t texels = std::size_t(ref.width) * ref.height;
        if (!ref.palette_rows) {
            return texels * 4;
        }
        return texels + std::size_t((ref.format == FORMAT_P4) ? 16 : 256) * ref.palette_rows * 4;
    }

    void layer::prepare_textures(drivers::graphics_command_builder &builder, const frame &f, const bool linear,
        std::vector<drivers::handle> &handles, std::vector<drivers::handle> &tables) {
        handles.assign(f.textures.size(), 0);
        tables.assign(f.textures.size(), 0);

        auto release = [&builder](const cached_texture &entry) {
            builder.destroy(entry.handle);
            if (entry.table) {
                builder.destroy(entry.table);
            }
        };

        std::vector<bool> used(f.textures.size(), false);
        for (const draw &d : f.draws) {
            if (d.texture >= 0 && static_cast<std::size_t>(d.texture) < used.size()) {
                used[d.texture] = true;
            }
        }

        // Textures that came inline with another test frame are of no use again.
        for (auto entry = cache_.begin(); entry != cache_.end();) {
            if (entry->inline_frame && entry->inline_frame != f.number) {
                release(*entry);
                cache_bytes_ -= entry->bytes;
                entry = cache_.erase(entry);
            } else {
                ++entry;
            }
        }

        auto matches = [&f](const cached_texture &entry, const std::size_t index) {
            const bool is_inline = index < f.texture_pixels.size() && !f.texture_pixels[index].empty();
            if (is_inline) {
                return entry.inline_frame == f.number && entry.inline_index == index;
            }
            return entry.inline_frame == 0 && entry.process_uid == f.process_uid && entry.ref == f.textures[index];
        };

        const drivers::filter_option filter = linear ? drivers::filter_option::linear : drivers::filter_option::nearest;
        std::vector<std::uint32_t> pixels;
        std::vector<std::uint8_t> indices;
        std::vector<std::size_t> known;
        std::uint64_t uploaded = 0;

        auto upload = [&](cached_texture &entry, const std::vector<std::uint32_t> &rgba) {
            const eka2l1::vec3 size(static_cast<int>(entry.ref.width), static_cast<int>(entry.ref.height), 0);
            const std::size_t bytes = rgba.size() * 4;

            if (!entry.handle) {
                entry.handle = drivers::create_texture(driver_, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, rgba.data(), bytes, size);
            } else {
                builder.recreate_texture(entry.handle, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, rgba.data(), bytes, size);
            }

            if (entry.handle) {
                // Textures repeat. A texture made anew has the driver's
                // defaults again, so both are set after every upload.
                builder.set_texture_addressing_mode(entry.handle, drivers::addressing_direction::s, drivers::addressing_option::repeat);
                builder.set_texture_addressing_mode(entry.handle, drivers::addressing_direction::t, drivers::addressing_option::repeat);
                entry.filter_set = false;
            }

            uploaded++;
        };

        // A texture with palette rows: the indices, a byte a texel, and the
        // table, a row of colours for each palette. Both are read with
        // texelFetch, so their filter only has to make them complete; the
        // shader smooths by hand.
        auto upload_rows = [&](cached_texture &entry, const std::vector<std::uint8_t> &texels, const std::vector<std::uint32_t> &table) {
            const eka2l1::vec3 size(static_cast<int>(entry.ref.width), static_cast<int>(entry.ref.height), 0);
            const int rows = static_cast<int>(entry.ref.palette_rows);
            const eka2l1::vec3 table_size(static_cast<int>(table.size() / std::max(rows, 1)), rows, 0);

            if (!entry.handle) {
                entry.handle = drivers::create_texture(driver_, 2, 0, drivers::texture_format::r8, drivers::texture_format::r,
                    drivers::texture_data_type::ubyte, texels.data(), texels.size(), size, 0, 1);
            } else {
                builder.recreate_texture(entry.handle, 2, 0, drivers::texture_format::r8, drivers::texture_format::r,
                    drivers::texture_data_type::ubyte, texels.data(), texels.size(), size, 0, 1);
            }

            if (!entry.table) {
                entry.table = drivers::create_texture(driver_, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, table.data(), table.size() * 4, table_size);
            } else {
                builder.recreate_texture(entry.table, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, table.data(), table.size() * 4, table_size);
            }

            if (!entry.handle || !entry.table) {
                if (entry.handle) {
                    builder.destroy(entry.handle);
                }
                if (entry.table) {
                    builder.destroy(entry.table);
                }
                entry.handle = entry.table = 0;
                return;
            }

            for (const drivers::handle h : { entry.handle, entry.table }) {
                builder.set_texture_filter(h, true, drivers::filter_option::nearest);
                builder.set_texture_filter(h, false, drivers::filter_option::nearest);
            }

            uploaded++;
        };

        for (std::size_t index = 0; index < f.textures.size(); index++) {
            if (!used[index]) {
                continue;
            }

            const texture_ref &ref = f.textures[index];
            const bool is_inline = index < f.texture_pixels.size() && !f.texture_pixels[index].empty();

            auto found = std::find_if(cache_.begin(), cache_.end(), [&](const cached_texture &entry) {
                return matches(entry, index);
            });

            if (found != cache_.end()) {
                found->last_used = pass_;
                if (!is_inline) {
                    known.push_back(static_cast<std::size_t>(found - cache_.begin()));
                }
                continue;
            }

            cached_texture entry;
            entry.ref = ref;
            entry.process_uid = f.process_uid;
            entry.last_used = entry.last_checked = pass_;

            if (is_inline) {
                entry.inline_frame = f.number;
                entry.inline_index = static_cast<std::uint32_t>(index);
                if (index < f.texture_indices.size() && !f.texture_indices[index].empty()) {
                    upload_rows(entry, f.texture_indices[index], f.texture_pixels[index]);
                } else {
                    upload(entry, f.texture_pixels[index]);
                }
            } else if (ref.palette_rows) {
                if (engine_.decode_table_locked(f.process_uid, ref, indices, pixels)) {
                    engine_.hash_locked(f.process_uid, ref, entry.hash);
                    upload_rows(entry, indices, pixels);
                }
            } else if (engine_.decode_locked(f.process_uid, ref, pixels)) {
                engine_.hash_locked(f.process_uid, ref, entry.hash);
                upload(entry, pixels);
            }

            if (entry.handle) {
                entry.bytes = gpu_bytes(ref);
                cache_bytes_ += entry.bytes;
                cache_.push_back(entry);
            }
        }

        // Those seen before may have changed since: look at the ones not
        // looked at for the longest first, as far as the allowance goes.
        std::sort(known.begin(), known.end(), [&](const std::size_t a, const std::size_t b) {
            return cache_[a].last_checked < cache_[b].last_checked;
        });

        std::size_t hashed = 0;
        for (const std::size_t at : known) {
            cached_texture &entry = cache_[at];
            std::size_t cost = std::size_t(entry.ref.pitch ? entry.ref.pitch : entry.ref.width * pixel_size(entry.ref.format))
                * entry.ref.height;
            if (entry.ref.palette_rows) {
                // The whole table is hashed as well.
                cost += std::size_t(entry.ref.palette_rows) * ((entry.ref.format == FORMAT_P4) ? 16 : 256)
                    * std::max<std::uint32_t>(entry.ref.palette_stride, 1);
            }
            if (hashed && hashed + cost > HASH_BYTES_A_PICTURE) {
                break;
            }

            hashed += cost;
            entry.last_checked = pass_;

            std::uint64_t hash = 0;
            if (!engine_.hash_locked(entry.process_uid, entry.ref, hash) || hash == entry.hash) {
                continue;
            }

            if (entry.ref.palette_rows) {
                if (engine_.decode_table_locked(entry.process_uid, entry.ref, indices, pixels)) {
                    entry.hash = hash;
                    upload_rows(entry, indices, pixels);
                }
            } else if (engine_.decode_locked(entry.process_uid, entry.ref, pixels)) {
                entry.hash = hash;
                upload(entry, pixels);
            }
        }

        // Make room, oldest first; never what this picture uses.
        while (cache_.size() > MAX_CACHED_TEXTURES || cache_bytes_ > MAX_CACHED_BYTES) {
            auto oldest = std::min_element(cache_.begin(), cache_.end(), [](const cached_texture &a, const cached_texture &b) {
                return a.last_used < b.last_used;
            });

            if (oldest == cache_.end() || oldest->last_used == pass_) {
                break;
            }

            release(*oldest);
            cache_bytes_ -= oldest->bytes;
            cache_.erase(oldest);
        }

        for (std::size_t index = 0; index < f.textures.size(); index++) {
            if (!used[index]) {
                continue;
            }

            for (cached_texture &entry : cache_) {
                if (!matches(entry, index)) {
                    continue;
                }

                if (!entry.table && (!entry.filter_set || entry.linear != linear)) {
                    builder.set_texture_filter(entry.handle, true, filter);
                    builder.set_texture_filter(entry.handle, false, filter);
                    entry.filter_set = true;
                    entry.linear = linear;
                }

                handles[index] = entry.handle;
                tables[index] = entry.table;
                break;
            }
        }

        const std::lock_guard<std::mutex> guard(lock_);
        cache_size_ = cache_.size();
        uploads_ += uploaded;
    }

    bool layer::render(epoc::screen *scr, drivers::graphics_driver *driver, const std::shared_ptr<const frame> &shown, const bool linear,
        const bool from_screen) {
        if (!driver || !scr->screen_texture || !ensure_resources(driver)) {
            return false;
        }

        const frame &f = *shown;
        pass_++;

        drivers::graphics_command_builder builder;

        // The picture to put the triangles into: the guest's, or the one an
        // injected frame brought.
        drivers::handle picture = scr->dsa_texture;
        eka2l1::vec2 picture_size = scr->current_mode().size;

        if (from_screen && f.screen_pixels.empty()) {
            // The window server drew the guest's bitmap into the screen
            // texture at its scale; the picture pass below reads the texture it
            // draws into, so it reads a copy at 1x, a texel per guest pixel.
            if (!screen_copy_ || screen_copy_size_ != picture_size) {
                if (screen_copy_) {
                    builder.destroy_bitmap(screen_copy_);
                }
                screen_copy_ = drivers::create_bitmap(driver, picture_size, 32);
                screen_copy_size_ = picture_size;
            }

            if (!screen_copy_) {
                return false;
            }

            const float scale = scr->display_scale_factor;
            const eka2l1::vec2 scaled(static_cast<int>(picture_size.x * scale), static_cast<int>(picture_size.y * scale));
            builder.bind_bitmap(screen_copy_);
            builder.set_feature(drivers::graphics_feature::clipping, false);
            builder.set_feature(drivers::graphics_feature::blend, false);
            builder.set_feature(drivers::graphics_feature::depth_test, false);
            builder.set_texture_filter(scr->screen_texture, true, drivers::filter_option::nearest);
            builder.set_texture_filter(scr->screen_texture, false, drivers::filter_option::nearest);
            builder.draw_bitmap(scr->screen_texture, 0, eka2l1::rect(eka2l1::vec2(0, 0), picture_size),
                eka2l1::rect(eka2l1::vec2(0, 0), scaled), eka2l1::vec2(0, 0), 0.0f, 0);
            picture = screen_copy_;
        }

        if (!f.screen_pixels.empty()) {
            const eka2l1::vec3 size(static_cast<int>(f.screen_width), static_cast<int>(f.screen_height), 0);
            const std::size_t bytes = f.screen_pixels.size() * 4;

            if (!screen_texture_) {
                screen_texture_ = drivers::create_texture(driver, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, f.screen_pixels.data(), bytes, size);
            } else if (screen_texture_frame_ != f.number) {
                builder.recreate_texture(screen_texture_, 2, 0, drivers::texture_format::rgba, drivers::texture_format::rgba,
                    drivers::texture_data_type::ubyte, f.screen_pixels.data(), bytes, size);
            }

            if (screen_texture_ && screen_texture_frame_ != f.number) {
                // Without a filter that needs no smaller copies the texture
                // is incomplete and reads as black.
                builder.set_texture_filter(screen_texture_, true, drivers::filter_option::nearest);
                builder.set_texture_filter(screen_texture_, false, drivers::filter_option::nearest);
            }

            screen_texture_frame_ = f.number;
            picture = screen_texture_;
            picture_size = eka2l1::vec2(static_cast<int>(f.screen_width), static_cast<int>(f.screen_height));
        } else if (screen_texture_) {
            builder.destroy(screen_texture_);
            screen_texture_ = 0;
        }

        if (!picture || picture_size.x <= 0 || picture_size.y <= 0 || !f.width || !f.height) {
            return false;
        }

        std::vector<drivers::handle> textures, tables;
        prepare_textures(builder, f, linear, textures, tables);

        // Depth as the engine has it, brought into the depth buffer's range.
        // Only its order matters.
        bool depth_used = false;
        float nearest = INFINITY, farthest = -INFINITY;
        for (const draw &d : f.draws) {
            if (d.depth == DEPTH_NONE || std::size_t(d.first_vertex) + d.vertex_count > f.vertices.size()) {
                continue;
            }

            depth_used = true;
            for (std::uint32_t n = 0; n < d.vertex_count; n++) {
                const float z = f.vertices[d.first_vertex + n].z;
                nearest = std::min(nearest, z);
                farthest = std::max(farthest, z);
            }
        }

        const float depth_span = (depth_used && farthest > nearest) ? (farthest - nearest) : 1.0f;

        vertex_data_.resize((QUAD_VERTICES + f.vertices.size()) * VERTEX_SIZE);
        std::uint8_t *out = vertex_data_.data();

        auto put = [&out](const float x, const float y, const float z, const float w, const float u, const float v,
                       const std::uint32_t argb, const float row = 0.0f) {
            const float floats[6] = { x, y, z, w, u, v };
            const std::uint8_t color[4] = { static_cast<std::uint8_t>(argb >> 16), static_cast<std::uint8_t>(argb >> 8),
                static_cast<std::uint8_t>(argb), static_cast<std::uint8_t>(argb >> 24) };
            std::memcpy(out, floats, 24);
            std::memcpy(out + 24, color, 4);
            std::memcpy(out + 28, &row, 4);
            out += VERTEX_SIZE;
        };

        // A bitmap keeps its first row where uploads put it, at the low end
        // of clip space: the driver's own shaders for bitmaps turn their
        // projection over to get there.
        const float pw = static_cast<float>(picture_size.x), ph = static_cast<float>(picture_size.y);
        put(-1.0f, -1.0f, 0.0f, 1.0f, 0.0f, 0.0f, 0xFFFFFFFF);
        put(1.0f, -1.0f, 0.0f, 1.0f, pw, 0.0f, 0xFFFFFFFF);
        put(-1.0f, 1.0f, 0.0f, 1.0f, 0.0f, ph, 0xFFFFFFFF);
        put(1.0f, -1.0f, 0.0f, 1.0f, pw, 0.0f, 0xFFFFFFFF);
        put(1.0f, 1.0f, 0.0f, 1.0f, pw, ph, 0xFFFFFFFF);
        put(-1.0f, 1.0f, 0.0f, 1.0f, 0.0f, ph, 0xFFFFFFFF);

        // Vertices no draw names stay as they are written here: outside.
        const std::size_t first_triangle = QUAD_VERTICES * VERTEX_SIZE;
        std::memset(vertex_data_.data() + first_triangle, 0, vertex_data_.size() - first_triangle);

        const float fw = static_cast<float>(f.width), fh = static_cast<float>(f.height);
        for (const draw &d : f.draws) {
            if (std::size_t(d.first_vertex) + d.vertex_count > f.vertices.size()) {
                continue;
            }

            float tw = 1.0f, th = 1.0f;
            if (d.texture >= 0 && static_cast<std::size_t>(d.texture) < f.textures.size()) {
                tw = static_cast<float>(f.textures[d.texture].width);
                th = static_cast<float>(f.textures[d.texture].height);
            }

            for (std::uint32_t n = 0; n + 3 <= d.vertex_count; n += 3) {
                const vertex *v = &f.vertices[d.first_vertex + n];
                out = vertex_data_.data() + (QUAD_VERTICES + d.first_vertex + n) * VERTEX_SIZE;

                // Perspective only when the three w differ, as the reference
                // has it; the largest becomes one to keep the numbers small.
                const bool perspective = !(v[0].w == v[1].w && v[1].w == v[2].w) && v[0].w > 0 && v[1].w > 0 && v[2].w > 0;
                const float largest = perspective ? std::max({ v[0].w, v[1].w, v[2].w }) : 1.0f;

                for (int corner = 0; corner < 3; corner++) {
                    const vertex &c = v[corner];
                    const float w = perspective ? (c.w / largest) : 1.0f;
                    const float x = c.x / fw * 2.0f - 1.0f;
                    const float y = c.y / fh * 2.0f - 1.0f;
                    const float z = (d.depth == DEPTH_NONE) ? 0.0f
                                                             : std::clamp((c.z - nearest) / depth_span, 0.0f, 1.0f) * 2.0f - 1.0f;
                    put(x * w, y * w, z * w, w, c.u / tw, c.v / th, c.color, c.row);
                }
            }
        }

        builder.recreate_buffer(vertex_buffer_, vertex_data_.data(), vertex_data_.size(),
            static_cast<drivers::buffer_upload_hint>(drivers::buffer_upload_dynamic | drivers::buffer_upload_draw));

        builder.bind_bitmap(scr->screen_texture);
        builder.set_feature(drivers::graphics_feature::clipping, false);
        builder.set_feature(drivers::graphics_feature::cull, false);
        builder.set_feature(drivers::graphics_feature::stencil_test, false);
        builder.set_feature(drivers::graphics_feature::depth_test, false);
        builder.set_feature(drivers::graphics_feature::blend, false);
        builder.set_color_mask(0b1111);

        drivers::handle buffers[1] = { vertex_buffer_ };
        builder.set_vertex_buffers(buffers, 0, 1);
        builder.bind_input_descriptors(input_layout_);

        // The 2D picture is smoothed as the plain copy would be.
        const bool smooth = !sys_->get_config()->nearest_neighbor_filtering;
        const bool own_picture = !f.screen_pixels.empty();
        auto picture_pass = [&](const bool over) {
            const float params[4] = { over ? 1.0f : (own_picture ? 2.0f : 0.0f), smooth ? 1.0f : 0.0f, pw, ph };
            builder.use_program(compose_program_);
            builder.bind_texture(picture, 0);
            builder.set_texture_for_shader(0, screen_loc_, drivers::shader_module_type::fragment);
            builder.set_dynamic_uniform(params_loc_, drivers::shader_var_type::vec4, params, sizeof(params));
            builder.draw_arrays(drivers::graphics_primitive_mode::triangles, 0, QUAD_VERTICES, 0);
        };

        picture_pass(false);

        // The triangles. Alpha is left alone: the screen texture is opaque.
        const eka2l1::vec2 target_size = scr->current_mode().size * scr->display_scale_factor;
        const float view[4] = { static_cast<float>(target_size.x) / pw, static_cast<float>(target_size.y) / ph, 0.0f, 0.0f };
        builder.use_program(triangle_program_);
        builder.bind_texture(picture, 1);
        builder.set_texture_for_shader(0, texture_loc_, drivers::shader_module_type::fragment);
        builder.set_texture_for_shader(1, triangle_screen_loc_, drivers::shader_module_type::fragment);
        builder.set_texture_for_shader(2, table_loc_, drivers::shader_module_type::fragment);
        builder.set_dynamic_uniform(view_loc_, drivers::shader_var_type::vec4, view, sizeof(view));
        builder.set_color_mask(0b0111);

        if (depth_used) {
            // One depth buffer for the frame, started for the comparison of
            // the first draw that has one.
            depth_mode first = DEPTH_NONE;
            for (const draw &d : f.draws) {
                if (d.depth != DEPTH_NONE) {
                    first = d.depth;
                    break;
                }
            }

            const float start = (first == DEPTH_LESS || first == DEPTH_LEQUAL) ? 1.0f : 0.0f;
            builder.set_depth_mask(0xFFFFFFFF);
            builder.clear({ 0.0f, 0.0f, 0.0f, 0.0f, start, 0.0f }, drivers::draw_buffer_bit_depth_buffer);
        }

        int blend_now = -1, depth_now = -1;
        drivers::handle texture_now = ~drivers::handle(0), table_now = ~drivers::handle(0);
        float mode_now[4] = { -1.0f, -1.0f, -1.0f, -1.0f };

        for (const draw &d : f.draws) {
            if (!d.vertex_count || std::size_t(d.first_vertex) + d.vertex_count > f.vertices.size()) {
                continue;
            }

            if (blend_now != d.blend) {
                blend_now = d.blend;

                switch (d.blend) {
                case BLEND_ALPHA:
                    builder.set_feature(drivers::graphics_feature::blend, true);
                    builder.blend_formula(drivers::blend_equation::add, drivers::blend_equation::add,
                        drivers::blend_factor::frag_out_alpha, drivers::blend_factor::one_minus_frag_out_alpha,
                        drivers::blend_factor::zero, drivers::blend_factor::one);
                    break;

                case BLEND_ADD:
                    builder.set_feature(drivers::graphics_feature::blend, true);
                    builder.blend_formula(drivers::blend_equation::add, drivers::blend_equation::add,
                        drivers::blend_factor::one, drivers::blend_factor::one,
                        drivers::blend_factor::zero, drivers::blend_factor::one);
                    break;

                case BLEND_MULTIPLY:
                    builder.set_feature(drivers::graphics_feature::blend, true);
                    builder.blend_formula(drivers::blend_equation::add, drivers::blend_equation::add,
                        drivers::blend_factor::current_color, drivers::blend_factor::zero,
                        drivers::blend_factor::zero, drivers::blend_factor::one);
                    break;

                case BLEND_SUBTRACT:
                    // The pixel minus the triangle's colour, stopping at black.
                    builder.set_feature(drivers::graphics_feature::blend, true);
                    builder.blend_formula(drivers::blend_equation::isub, drivers::blend_equation::add,
                        drivers::blend_factor::one, drivers::blend_factor::one,
                        drivers::blend_factor::zero, drivers::blend_factor::one);
                    break;

                default:
                    builder.set_feature(drivers::graphics_feature::blend, false);
                    break;
                }
            }

            if (depth_now != d.depth) {
                depth_now = d.depth;
                builder.set_feature(drivers::graphics_feature::depth_test, d.depth != DEPTH_NONE);

                switch (d.depth) {
                case DEPTH_LESS:
                    builder.set_depth_pass_condition(drivers::condition_func::less);
                    break;
                case DEPTH_LEQUAL:
                    builder.set_depth_pass_condition(drivers::condition_func::less_or_equal);
                    break;
                case DEPTH_GREATER:
                    builder.set_depth_pass_condition(drivers::condition_func::greater);
                    break;
                case DEPTH_GEQUAL:
                    builder.set_depth_pass_condition(drivers::condition_func::greater_or_equal);
                    break;
                default:
                    break;
                }
            }

            const drivers::handle texture = (d.texture >= 0 && static_cast<std::size_t>(d.texture) < textures.size())
                ? textures[d.texture] : 0;
            if (texture && texture != texture_now) {
                texture_now = texture;
                builder.bind_texture(texture, 0);
            }

            const drivers::handle table = texture ? tables[d.texture] : 0;
            if (table && table != table_now) {
                table_now = table;
                builder.bind_texture(table, 2);
            }

            const float mode[4] = { d.blend == BLEND_KEY ? 1.0f : 0.0f, texture ? 1.0f : 0.0f, table ? 1.0f : 0.0f,
                (table && linear) ? 1.0f : 0.0f };
            if (std::memcmp(mode, mode_now, sizeof(mode)) != 0) {
                std::memcpy(mode_now, mode, sizeof(mode));
                builder.set_dynamic_uniform(mode_loc_, drivers::shader_var_type::vec4, mode, sizeof(mode));
            }

            builder.draw_arrays(drivers::graphics_primitive_mode::triangles, static_cast<std::int32_t>(QUAD_VERTICES + d.first_vertex),
                static_cast<std::int32_t>(d.vertex_count - d.vertex_count % 3), 0);
        }

        builder.set_feature(drivers::graphics_feature::depth_test, false);
        builder.set_depth_pass_condition(drivers::condition_func::less);

        // The picture over the triangles adds itself to as much of them as
        // its alpha says: none for a pixel of the picture, some for one the
        // game mixed with the key colour.
        builder.set_feature(drivers::graphics_feature::blend, true);
        builder.blend_formula(drivers::blend_equation::add, drivers::blend_equation::add,
            drivers::blend_factor::one, drivers::blend_factor::frag_out_alpha,
            drivers::blend_factor::zero, drivers::blend_factor::one);

        picture_pass(true);

        // Leave the blend as the window server sets it for its own drawing.
        builder.set_feature(drivers::graphics_feature::blend, false);
        builder.blend_formula(drivers::blend_equation::add, drivers::blend_equation::add,
            drivers::blend_factor::frag_out_alpha, drivers::blend_factor::one_minus_frag_out_alpha,
            drivers::blend_factor::one, drivers::blend_factor::one);
        builder.set_color_mask(0b1111);
        builder.bind_bitmap(0);

        drivers::command_list list = builder.retrieve_command_list();
        driver->submit_command_list(list);

        const std::lock_guard<std::mutex> guard(lock_);
        composed_++;
        return true;
    }

    engine::~engine() = default;

    layer &engine::the_layer() {
        if (!layer_) {
            layer_ = std::make_unique<layer>(sys_, *this);
            sink_ = layer_.get();
        }
        return *layer_;
    }
}
