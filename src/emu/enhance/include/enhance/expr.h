// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace eka2l1::enhance {
    /**
     * What an expression is evaluated against: the registers at a hook, guest
     * memory, the loop variables of a draw (`i`, `p`) and the profile's named
     * variables (`$name`).
     */
    struct eval_context {
        std::uint32_t regs[16] = {};
        std::uint32_t cpsr = 0;
        double i = 0;
        double p = 0;
        std::vector<double> *vars = nullptr;

        // Reads guest memory; returns false when the address is not mapped.
        bool (*read)(void *opaque, std::uint32_t addr, void *out, std::uint32_t size) = nullptr;
        void *opaque = nullptr;

        // Set when a memory read failed. The value read is then zero.
        bool fault = false;
    };

    /**
     * Names of the profile's variables. An expression refers to one as `$name`;
     * compiling an expression adds the names it uses.
     */
    struct name_table {
        std::vector<std::string> names;
        std::uint32_t slot(const std::string &name);
    };

    /**
     * A small arithmetic expression over registers and guest memory, as written
     * in an enhancement profile:
     *
     *   numbers      12, 0x1F, 1.5
     *   registers    r0..r15, sp, lr, pc, cpsr, reg(n)
     *   variables    i (vertex index), p (vertex pointer), $name
     *   memory       u8(a) u16(a) u32(a) s8(a) s16(a) s32(a) f32(a)
     *   functions    fx(v, bits) = v / 2^bits, bits(v) = the float with these
     *                32 bits, min(a, b), max(a, b), abs(a), sel(c, a, b)
     *   operators    + - * / %  << >>  & | ^ ~  == != < <= > >=  && || !
     *
     * Values are doubles; the bitwise operators and shifts work on the value
     * as a 32-bit unsigned integer (>> is logical; use s32() first, or sar(v, n),
     * for an arithmetic shift).
     */
    class expr {
    public:
        // Throws std::runtime_error with the position on a syntax error.
        static expr compile(const std::string &text, name_table &names);

        bool empty() const {
            return nodes_.empty();
        }

        double eval(eval_context &ctx) const;

        const std::string &text() const {
            return text_;
        }

    private:
        struct node {
            std::uint8_t op = 0;
            std::int32_t a = -1, b = -1, c = -1;
            double value = 0;
        };

        std::vector<node> nodes_;
        std::int32_t root_ = -1;
        std::string text_;

        double eval_node(std::int32_t index, eval_context &ctx) const;

        friend struct parser;
    };
}
