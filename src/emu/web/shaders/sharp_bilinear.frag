// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sharp bilinear: the picture enlarged by the largest whole multiple that fits
// (as blocks), and that enlarged picture then scaled the rest of the way with
// linear blending. Every game pixel keeps its full size and only the output
// pixels on the border between two game pixels are a mix, so a scale that is
// not a whole number looks even instead of having rows and columns of two
// widths. At a whole-number scale the result is the same as sharp pixels.
//
// Written for this emulator. The technique is the common "integer prescale,
// then bilinear" one (known from the public-domain sharp-bilinear shaders of
// Themaister and rsn8887 in the libretro collections); it is done here in one
// pass by narrowing the blend between two texels to 1 / prescale of a texel.
// The four texels are read with texelFetch, so the texture's own filter does
// not matter.

precision highp float;
precision highp int;

uniform sampler2D u_tex;
uniform vec2 u_texelDelta; // 1 / source size in texels
uniform vec2 u_pixelDelta; // 1 / output size in pixels
in vec2 r_texcoord;
out vec4 o_color;

void main() {
    ivec2 size = textureSize(u_tex, 0);
    ivec2 last = min(size, ivec2(1.0 / u_texelDelta + 0.5)) - 1;

    // Output pixels per texel, and its whole part: the prescale.
    vec2 scale = u_texelDelta / u_pixelDelta;
    vec2 prescale = max(floor(scale + 0.001), 1.0);

    // Position between the centres of four texels: `first` is the upper left
    // one, `between` runs from 0 at its centre to 1 at the centre of the next.
    vec2 position = r_texcoord * vec2(size) - 0.5;
    vec2 first = floor(position);
    vec2 between = position - first;

    // Plain bilinear would use `between` as the weight. Stretching it around
    // the border (0.5) by the prescale leaves a blend 1 / prescale of a texel
    // wide and the texel's own colour everywhere else.
    vec2 weight = clamp((between - 0.5) * prescale + 0.5, 0.0, 1.0);

    ivec2 a = clamp(ivec2(first), ivec2(0), last);
    ivec2 b = clamp(ivec2(first) + 1, ivec2(0), last);

    vec3 upper = mix(texelFetch(u_tex, a, 0).rgb, texelFetch(u_tex, ivec2(b.x, a.y), 0).rgb, weight.x);
    vec3 lower = mix(texelFetch(u_tex, ivec2(a.x, b.y), 0).rgb, texelFetch(u_tex, b, 0).rgb, weight.x);

    o_color = vec4(mix(upper, lower, weight.y), 1.0);
}
