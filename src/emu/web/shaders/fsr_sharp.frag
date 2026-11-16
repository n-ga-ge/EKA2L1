// FidelityFX Super Resolution 1.0, edge-adaptive spatial upsampling (EASU) and
// robust contrast-adaptive sharpening (RCAS), written for GLSL ES 3.00 from
// AMD's reference implementation (ffx_fsr1.h).
//
// Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved.
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.
//
// FSR 2 is a temporal upscaler that needs per-pixel depth and motion vectors
// from the renderer. The emulator only has the guest's finished 2D frame, so
// the spatial FSR 1 passes are what can be applied to it.

precision highp float;

uniform sampler2D u_tex;
uniform vec2 u_texelDelta; // 1 / source size in texels
uniform vec2 u_pixelDelta; // 1 / output size in pixels
in vec2 r_texcoord;
out vec4 o_color;

float fsrLuma(vec3 c) {
    return c.b * 0.5 + (c.r * 0.5 + c.g);
}

vec3 fsrTexel(vec2 base, vec2 offset) {
    return texture(u_tex, (base + offset) * u_texelDelta).rgb;
}

// Direction and length of the edge through one bilinear quadrant, from a
// '+' of lumas: a above, b left, c centre, d right, e below.
void fsrEasuSet(inout vec2 dir, inout float len, float w, float lA, float lB, float lC, float lD, float lE) {
    float dc = lD - lC;
    float cb = lC - lB;
    float lenX = max(abs(dc), abs(cb));
    lenX = 1.0 / max(lenX, 1.0e-6);
    float dirX = lD - lB;
    dir.x += dirX * w;
    lenX = clamp(abs(dirX) * lenX, 0.0, 1.0);
    lenX *= lenX;
    len += lenX * w;

    float ec = lE - lC;
    float ca = lC - lA;
    float lenY = max(abs(ec), abs(ca));
    lenY = 1.0 / max(lenY, 1.0e-6);
    float dirY = lE - lA;
    dir.y += dirY * w;
    lenY = clamp(abs(dirY) * lenY, 0.0, 1.0);
    lenY *= lenY;
    len += lenY * w;
}

// One filter tap: a Lanczos-like window rotated and stretched along the edge.
void fsrEasuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len, float lob, float clp, vec3 c) {
    vec2 v = vec2(dot(off, dir), dot(off, vec2(-dir.y, dir.x)));
    v *= len;
    float d2 = min(dot(v, v), clp);
    float wB = 0.4 * d2 - 1.0;
    float wA = lob * d2 - 1.0;
    wB *= wB;
    wA *= wA;
    wB = 1.5625 * wB - 0.5625;
    float w = wB * wA;
    aC += c * w;
    aW += w;
}

// EASU for the output position `coord` (0..1 across the source).
vec3 fsrEasu(vec2 coord) {
    vec2 pp = coord / u_texelDelta - 0.5;
    vec2 fp = floor(pp);
    pp -= fp;

    // 12 taps around the 2x2 block f g / j k nearest the output pixel:
    //      b c
    //    e f g h
    //    i j k l
    //      n o
    vec2 base = fp + 0.5;
    vec3 b = fsrTexel(base, vec2(0.0, -1.0));
    vec3 c = fsrTexel(base, vec2(1.0, -1.0));
    vec3 e = fsrTexel(base, vec2(-1.0, 0.0));
    vec3 f = fsrTexel(base, vec2(0.0, 0.0));
    vec3 g = fsrTexel(base, vec2(1.0, 0.0));
    vec3 h = fsrTexel(base, vec2(2.0, 0.0));
    vec3 i = fsrTexel(base, vec2(-1.0, 1.0));
    vec3 j = fsrTexel(base, vec2(0.0, 1.0));
    vec3 k = fsrTexel(base, vec2(1.0, 1.0));
    vec3 l = fsrTexel(base, vec2(2.0, 1.0));
    vec3 n = fsrTexel(base, vec2(0.0, 2.0));
    vec3 o = fsrTexel(base, vec2(1.0, 2.0));

    float bL = fsrLuma(b), cL = fsrLuma(c), eL = fsrLuma(e), fL = fsrLuma(f);
    float gL = fsrLuma(g), hL = fsrLuma(h), iL = fsrLuma(i), jL = fsrLuma(j);
    float kL = fsrLuma(k), lL = fsrLuma(l), nL = fsrLuma(n), oL = fsrLuma(o);

    vec2 dir = vec2(0.0);
    float len = 0.0;
    fsrEasuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
    fsrEasuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
    fsrEasuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
    fsrEasuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

    // Normalise the direction; a flat area gets an arbitrary one.
    float dirR = dot(dir, dir);
    bool zero = dirR < (1.0 / 32768.0);
    dirR = zero ? 1.0 : inversesqrt(dirR);
    dir.x = zero ? 1.0 : dir.x;
    dir *= dirR;

    // 0..2 down to 0..1, shaped with a square.
    len *= 0.5;
    len *= len;

    // Stretch the kernel along the edge, squeeze it across.
    float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
    vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
    float lob = 0.5 + ((1.0 / 4.0 - 0.04) - 0.5) * len;
    float clp = 1.0 / lob;

    vec3 min4 = min(min(f, g), min(j, k));
    vec3 max4 = max(max(f, g), max(j, k));

    vec3 aC = vec3(0.0);
    float aW = 0.0;
    fsrEasuTap(aC, aW, vec2(0.0, -1.0) - pp, dir, len2, lob, clp, b);
    fsrEasuTap(aC, aW, vec2(1.0, -1.0) - pp, dir, len2, lob, clp, c);
    fsrEasuTap(aC, aW, vec2(-1.0, 1.0) - pp, dir, len2, lob, clp, i);
    fsrEasuTap(aC, aW, vec2(0.0, 1.0) - pp, dir, len2, lob, clp, j);
    fsrEasuTap(aC, aW, vec2(0.0, 0.0) - pp, dir, len2, lob, clp, f);
    fsrEasuTap(aC, aW, vec2(-1.0, 0.0) - pp, dir, len2, lob, clp, e);
    fsrEasuTap(aC, aW, vec2(1.0, 1.0) - pp, dir, len2, lob, clp, k);
    fsrEasuTap(aC, aW, vec2(2.0, 1.0) - pp, dir, len2, lob, clp, l);
    fsrEasuTap(aC, aW, vec2(2.0, 0.0) - pp, dir, len2, lob, clp, h);
    fsrEasuTap(aC, aW, vec2(1.0, 0.0) - pp, dir, len2, lob, clp, g);
    fsrEasuTap(aC, aW, vec2(1.0, 2.0) - pp, dir, len2, lob, clp, o);
    fsrEasuTap(aC, aW, vec2(0.0, 2.0) - pp, dir, len2, lob, clp, n);

    // Normalise and clamp to the nearest four texels to avoid ringing.
    return min(max4, max(min4, aC / aW));
}

// FSR 1.0 upscale followed by its sharpening pass (RCAS). The driver runs one
// shader per draw, so the upscale is evaluated for the pixel and its four
// neighbours instead of reading a first pass back: five times the texture
// fetches of the plain upscale.
const float FSR_RCAS_LIMIT = 0.25 - (1.0 / 16.0);
const float FSR_RCAS_SHARPNESS = 0.2; // stops; 0 is sharpest

void main() {
    vec2 px = u_pixelDelta;
    vec3 e = fsrEasu(r_texcoord);
    vec3 b = fsrEasu(r_texcoord + vec2(0.0, -px.y));
    vec3 d = fsrEasu(r_texcoord + vec2(-px.x, 0.0));
    vec3 f = fsrEasu(r_texcoord + vec2(px.x, 0.0));
    vec3 h = fsrEasu(r_texcoord + vec2(0.0, px.y));

    vec3 mn4 = min(min(b, d), min(f, h));
    vec3 mx4 = max(max(b, d), max(f, h));

    // How far the ring can be pushed before the result clips.
    vec3 hitMin = mn4 / (4.0 * mx4 + 1.0e-5);
    vec3 hitMax = (1.0 - mx4) / (4.0 * mn4 - 4.0 - 1.0e-5);
    vec3 lobeRGB = max(-hitMin, hitMax);
    float lobe = max(-FSR_RCAS_LIMIT, min(max(lobeRGB.r, max(lobeRGB.g, lobeRGB.b)), 0.0)) * exp2(-FSR_RCAS_SHARPNESS);

    o_color = vec4((lobe * (b + d + h + f) + e) / (4.0 * lobe + 1.0), 1.0);
}
