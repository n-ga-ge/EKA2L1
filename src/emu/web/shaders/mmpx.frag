// MMPX: a pixel-art scaler that doubles the picture and keeps its style. Lines
// and curves stay one colour (nothing is blended), so it adds no new colours
// to a palette.
//
// The algorithm is from "MMPX Style-Preserving Pixel Art Magnification" by
// Morgan McGuire and Mara Gagiu, Journal of Computer Graphics Techniques 10(2),
// 2021, https://casual-effects.com/research/McGuire2021PixelArt/. The rules
// below are the authors' reference GLSL, which carries this notice:
//
//   MMPX.glc
//   Copyright 2020 Morgan McGuire & Mara Gagiu.
//   Provided under the Open Source MIT license https://opensource.org/licenses/MIT
//
//   See js-demo.html for the commented source code.
//   This is an optimized GLSL port of that version
//   by Morgan McGuire and Mara Gagiu.
//
// Changes for this emulator's one-pass upscale-shader interface (GLSL ES 3.00,
// WebGL2): the reference writes the four output pixels of one source pixel;
// here every output pixel works out the four of the source pixel it lies in
// and takes its own. MMPX only doubles: at larger scales each of the four
// stays a block, and where the middle of a source pixel falls inside an output
// pixel (odd scales) that output pixel is the mix of the two halves.

precision highp float;
precision highp int;

uniform sampler2D u_tex;
uniform vec2 u_texelDelta; // 1 / source size in texels
uniform vec2 u_pixelDelta; // 1 / output size in pixels
in vec2 r_texcoord;
out vec4 o_color;

#define ABGR8 uint

ivec2 centre;
ivec2 last;

// The picture is opaque, so the alpha byte is always 255.
ABGR8 src(int x, int y) {
    uvec3 c = uvec3(texelFetch(u_tex, clamp(centre + ivec2(x, y), ivec2(0), last), 0).rgb * 255.0 + 0.5);
    return 0xFF000000u | (c.b << 16) | (c.g << 8) | c.r;
}

vec3 unpack(ABGR8 C) {
    return vec3(float(C & 0xFFu), float((C >> 8) & 0xFFu), float((C >> 16) & 0xFFu)) / 255.0;
}

uint luma(ABGR8 C) {
    uint alpha = (C & 0xFF000000u) >> 24;
    return (((C & 0x00FF0000u) >> 16) + ((C & 0x0000FF00u) >> 8) + (C & 0x000000FFu) + 1u) * (256u - alpha);
}

bool all_eq2(ABGR8 B, ABGR8 A0, ABGR8 A1) {
    return ((B ^ A0) | (B ^ A1)) == 0u;
}

bool all_eq3(ABGR8 B, ABGR8 A0, ABGR8 A1, ABGR8 A2) {
    return ((B ^ A0) | (B ^ A1) | (B ^ A2)) == 0u;
}

bool all_eq4(ABGR8 B, ABGR8 A0, ABGR8 A1, ABGR8 A2, ABGR8 A3) {
    return ((B ^ A0) | (B ^ A1) | (B ^ A2) | (B ^ A3)) == 0u;
}

bool any_eq3(ABGR8 B, ABGR8 A0, ABGR8 A1, ABGR8 A2) {
    return B == A0 || B == A1 || B == A2;
}

bool none_eq2(ABGR8 B, ABGR8 A0, ABGR8 A1) {
    return (B != A0) && (B != A1);
}

bool none_eq4(ABGR8 B, ABGR8 A0, ABGR8 A1, ABGR8 A2, ABGR8 A3) {
    return B != A0 && B != A1 && B != A2 && B != A3;
}

void main() {
    ivec2 size = textureSize(u_tex, 0);
    last = min(size, ivec2(1.0 / u_texelDelta + 0.5)) - 1;

    vec2 texel = r_texcoord * vec2(size);
    centre = ivec2(floor(texel));

    ABGR8 A = src(-1, -1), B = src(0, -1), C = src(1, -1);
    ABGR8 D = src(-1, 0), E = src(0, 0), F = src(1, 0);
    ABGR8 G = src(-1, 1), H = src(0, 1), I = src(1, 1);

    // The four output pixels of E:  J K
    //                               L M
    ABGR8 J = E, K = E, L = E, M = E;

    if (((A ^ E) | (B ^ E) | (C ^ E) | (D ^ E) | (F ^ E) | (G ^ E) | (H ^ E) | (I ^ E)) != 0u) {
        ABGR8 P = src(0, -2), S = src(0, 2);
        ABGR8 Q = src(-2, 0), R = src(2, 0);
        ABGR8 Bl = luma(B), Dl = luma(D), El = luma(E), Fl = luma(F), Hl = luma(H);

        // 1:1 slope rules
        if ((D == B && D != H && D != F) && (El >= Dl || E == A) && any_eq3(E, A, C, G) && ((El < Dl) || A != D || E != P || E != Q)) J = D;
        if ((B == F && B != D && B != H) && (El >= Bl || E == C) && any_eq3(E, A, C, I) && ((El < Bl) || C != B || E != P || E != R)) K = B;
        if ((H == D && H != F && H != B) && (El >= Hl || E == G) && any_eq3(E, A, G, I) && ((El < Hl) || G != H || E != S || E != Q)) L = H;
        if ((F == H && F != B && F != D) && (El >= Fl || E == I) && any_eq3(E, C, G, I) && ((El < Fl) || I != H || E != R || E != S)) M = F;

        // Intersection rules
        if ((E != F && all_eq4(E, C, I, D, Q) && all_eq2(F, B, H)) && (F != src(3, 0))) K = M = F;
        if ((E != D && all_eq4(E, A, G, F, R) && all_eq2(D, B, H)) && (D != src(-3, 0))) J = L = D;
        if ((E != H && all_eq4(E, G, I, B, P) && all_eq2(H, D, F)) && (H != src(0, 3))) L = M = H;
        if ((E != B && all_eq4(E, A, C, H, S) && all_eq2(B, D, F)) && (B != src(0, -3))) J = K = B;
        if (Bl < El && all_eq4(E, G, H, I, S) && none_eq4(E, A, D, C, F)) J = K = B;
        if (Hl < El && all_eq4(E, A, B, C, P) && none_eq4(E, D, G, I, F)) L = M = H;
        if (Fl < El && all_eq4(E, A, D, G, Q) && none_eq4(E, B, C, I, H)) K = M = F;
        if (Dl < El && all_eq4(E, C, F, I, R) && none_eq4(E, B, A, G, H)) J = L = D;

        // 2:1 slope rules
        if (H != B) {
            if (H != A && H != E && H != C) {
                if (all_eq3(H, G, F, R) && none_eq2(H, D, src(2, -1))) L = M;
                if (all_eq3(H, I, D, Q) && none_eq2(H, F, src(-2, -1))) M = L;
            }

            if (B != I && B != G && B != E) {
                if (all_eq3(B, A, F, R) && none_eq2(B, D, src(2, 1))) J = K;
                if (all_eq3(B, C, D, Q) && none_eq2(B, F, src(-2, 1))) K = J;
            }
        } // H !== B

        if (F != D) {
            if (D != I && D != E && D != C) {
                if (all_eq3(D, A, H, S) && none_eq2(D, B, src(1, 2))) J = L;
                if (all_eq3(D, G, B, P) && none_eq2(D, H, src(1, -2))) L = J;
            }

            if (F != E && F != A && F != G) {
                if (all_eq3(F, C, H, S) && none_eq2(F, B, src(-1, 2))) K = M;
                if (all_eq3(F, I, B, P) && none_eq2(F, H, src(-1, -2))) M = K;
            }
        } // F !== D
    } // not constant

    // Which of the four this output pixel is: 0 in the left or upper half of
    // the source pixel, 1 in the other, and in between only for an output
    // pixel that the middle of the source pixel runs through.
    vec2 scale = u_texelDelta / u_pixelDelta;
    vec2 side = clamp((fract(texel) - 0.5) * scale + 0.5, 0.0, 1.0);

    o_color = vec4(mix(mix(unpack(J), unpack(K), side.x), mix(unpack(L), unpack(M), side.x), side.y), 1.0);
}
