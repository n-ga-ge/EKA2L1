// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-2.0-or-later
#include <enhance/expr.h>

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <stdexcept>

namespace eka2l1::enhance {
    enum : std::uint8_t {
        OP_NUM,
        OP_REG,
        OP_REGN,
        OP_CPSR,
        OP_I,
        OP_P,
        OP_VAR,
        OP_U8,
        OP_U16,
        OP_U32,
        OP_S8,
        OP_S16,
        OP_S32,
        OP_F32,
        OP_FX,
        OP_BITS,
        OP_MIN,
        OP_MAX,
        OP_ABS,
        OP_SEL,
        OP_SAR,
        OP_ADD,
        OP_SUB,
        OP_MUL,
        OP_DIV,
        OP_MOD,
        OP_SHL,
        OP_SHR,
        OP_AND,
        OP_OR,
        OP_XOR,
        OP_NOT,
        OP_NEG,
        OP_LNOT,
        OP_EQ,
        OP_NE,
        OP_LT,
        OP_LE,
        OP_GT,
        OP_GE,
        OP_LAND,
        OP_LOR
    };

    std::uint32_t name_table::slot(const std::string &name) {
        const auto found = std::find(names.begin(), names.end(), name);
        if (found != names.end()) {
            return static_cast<std::uint32_t>(found - names.begin());
        }

        names.push_back(name);
        return static_cast<std::uint32_t>(names.size() - 1);
    }

    static std::uint32_t to_u32(const double value) {
        if (!std::isfinite(value)) {
            return 0;
        }

        // Wrap the way a 32-bit register does, for negative values too.
        return static_cast<std::uint32_t>(static_cast<std::int64_t>(value));
    }

    struct parser {
        const std::string &text;
        name_table &names;
        expr &out;
        std::size_t pos = 0;

        [[noreturn]] void fail(const std::string &what) const {
            throw std::runtime_error(what + " at character " + std::to_string(pos + 1) + " of `" + text + "`");
        }

        void skip() {
            while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos]))) {
                pos++;
            }
        }

        bool take(const char *token) {
            skip();
            const std::size_t length = std::strlen(token);
            if (text.compare(pos, length, token) != 0) {
                return false;
            }

            pos += length;
            return true;
        }

        // A one-character operator that is not the start of a longer one.
        bool take_single(const char op, const char *not_followed_by) {
            skip();
            if (pos >= text.size() || text[pos] != op) {
                return false;
            }

            if (pos + 1 < text.size() && std::strchr(not_followed_by, text[pos + 1]) && text[pos + 1] != '\0') {
                return false;
            }

            pos++;
            return true;
        }

        std::int32_t add(const std::uint8_t op, const std::int32_t a = -1, const std::int32_t b = -1,
            const std::int32_t c = -1, const double value = 0) {
            expr::node n;
            n.op = op;
            n.a = a;
            n.b = b;
            n.c = c;
            n.value = value;
            out.nodes_.push_back(n);
            return static_cast<std::int32_t>(out.nodes_.size() - 1);
        }

        std::int32_t logical_or() {
            std::int32_t left = logical_and();
            while (take("||")) {
                left = add(OP_LOR, left, logical_and());
            }
            return left;
        }

        std::int32_t logical_and() {
            std::int32_t left = bit_or();
            while (take("&&")) {
                left = add(OP_LAND, left, bit_or());
            }
            return left;
        }

        std::int32_t bit_or() {
            std::int32_t left = bit_xor();
            while (take_single('|', "|")) {
                left = add(OP_OR, left, bit_xor());
            }
            return left;
        }

        std::int32_t bit_xor() {
            std::int32_t left = bit_and();
            while (take_single('^', "")) {
                left = add(OP_XOR, left, bit_and());
            }
            return left;
        }

        std::int32_t bit_and() {
            std::int32_t left = equality();
            while (take_single('&', "&")) {
                left = add(OP_AND, left, equality());
            }
            return left;
        }

        std::int32_t equality() {
            std::int32_t left = relational();
            for (;;) {
                if (take("==")) {
                    left = add(OP_EQ, left, relational());
                } else if (take("!=")) {
                    left = add(OP_NE, left, relational());
                } else {
                    return left;
                }
            }
        }

        std::int32_t relational() {
            std::int32_t left = shift();
            for (;;) {
                if (take("<=")) {
                    left = add(OP_LE, left, shift());
                } else if (take(">=")) {
                    left = add(OP_GE, left, shift());
                } else if (take_single('<', "<")) {
                    left = add(OP_LT, left, shift());
                } else if (take_single('>', ">")) {
                    left = add(OP_GT, left, shift());
                } else {
                    return left;
                }
            }
        }

        std::int32_t shift() {
            std::int32_t left = additive();
            for (;;) {
                if (take("<<")) {
                    left = add(OP_SHL, left, additive());
                } else if (take(">>")) {
                    left = add(OP_SHR, left, additive());
                } else {
                    return left;
                }
            }
        }

        std::int32_t additive() {
            std::int32_t left = multiplicative();
            for (;;) {
                if (take("+")) {
                    left = add(OP_ADD, left, multiplicative());
                } else if (take("-")) {
                    left = add(OP_SUB, left, multiplicative());
                } else {
                    return left;
                }
            }
        }

        std::int32_t multiplicative() {
            std::int32_t left = unary();
            for (;;) {
                if (take("*")) {
                    left = add(OP_MUL, left, unary());
                } else if (take("/")) {
                    left = add(OP_DIV, left, unary());
                } else if (take("%")) {
                    left = add(OP_MOD, left, unary());
                } else {
                    return left;
                }
            }
        }

        std::int32_t unary() {
            if (take("-")) {
                return add(OP_NEG, unary());
            }
            if (take("~")) {
                return add(OP_NOT, unary());
            }
            if (take_single('!', "=")) {
                return add(OP_LNOT, unary());
            }
            if (take("+")) {
                return unary();
            }
            return primary();
        }

        std::int32_t call(const std::uint8_t op, const int arguments) {
            std::int32_t args[3] = { -1, -1, -1 };
            if (!take("(")) {
                fail("expected `(`");
            }

            for (int n = 0; n < arguments; n++) {
                if (n && !take(",")) {
                    fail("expected `,`");
                }
                args[n] = logical_or();
            }

            if (!take(")")) {
                fail("expected `)`");
            }

            return add(op, args[0], args[1], args[2]);
        }

        std::int32_t primary() {
            skip();
            if (pos >= text.size()) {
                fail("unexpected end");
            }

            const char c = text[pos];
            if (c == '(') {
                pos++;
                const std::int32_t inner = logical_or();
                if (!take(")")) {
                    fail("expected `)`");
                }
                return inner;
            }

            if (std::isdigit(static_cast<unsigned char>(c)) || c == '.') {
                const char *start = text.c_str() + pos;
                char *end = nullptr;
                double value = 0;
                if (c == '0' && pos + 1 < text.size() && (text[pos + 1] == 'x' || text[pos + 1] == 'X')) {
                    value = static_cast<double>(std::strtoull(start, &end, 16));
                } else {
                    value = std::strtod(start, &end);
                }

                if (end == start) {
                    fail("bad number");
                }

                pos += static_cast<std::size_t>(end - start);
                return add(OP_NUM, -1, -1, -1, value);
            }

            if (c == '$') {
                pos++;
                const std::size_t start = pos;
                while (pos < text.size() && (std::isalnum(static_cast<unsigned char>(text[pos])) || text[pos] == '_')) {
                    pos++;
                }
                if (pos == start) {
                    fail("expected a variable name");
                }
                return add(OP_VAR, -1, -1, -1, names.slot(text.substr(start, pos - start)));
            }

            if (std::isalpha(static_cast<unsigned char>(c)) || c == '_') {
                const std::size_t start = pos;
                while (pos < text.size() && (std::isalnum(static_cast<unsigned char>(text[pos])) || text[pos] == '_')) {
                    pos++;
                }
                const std::string word = text.substr(start, pos - start);

                if (word == "i") {
                    return add(OP_I);
                }
                if (word == "p") {
                    return add(OP_P);
                }
                if (word == "sp") {
                    return add(OP_REG, -1, -1, -1, 13);
                }
                if (word == "lr") {
                    return add(OP_REG, -1, -1, -1, 14);
                }
                if (word == "pc") {
                    return add(OP_REG, -1, -1, -1, 15);
                }
                if (word == "cpsr") {
                    return add(OP_CPSR);
                }
                if (word.size() >= 2 && word.size() <= 3 && word[0] == 'r' && std::isdigit(static_cast<unsigned char>(word[1]))
                    && (word.size() == 2 || std::isdigit(static_cast<unsigned char>(word[2])))) {
                    const int index = std::atoi(word.c_str() + 1);
                    if (index > 15) {
                        fail("no register " + word);
                    }
                    return add(OP_REG, -1, -1, -1, index);
                }

                static const struct {
                    const char *name;
                    std::uint8_t op;
                    int arguments;
                } functions[] = {
                    { "u8", OP_U8, 1 }, { "u16", OP_U16, 1 }, { "u32", OP_U32, 1 }, { "s8", OP_S8, 1 },
                    { "s16", OP_S16, 1 }, { "s32", OP_S32, 1 }, { "f32", OP_F32, 1 }, { "reg", OP_REGN, 1 },
                    { "fx", OP_FX, 2 }, { "bits", OP_BITS, 1 }, { "min", OP_MIN, 2 }, { "max", OP_MAX, 2 },
                    { "abs", OP_ABS, 1 }, { "sel", OP_SEL, 3 }, { "sar", OP_SAR, 2 }
                };

                for (const auto &function : functions) {
                    if (word == function.name) {
                        return call(function.op, function.arguments);
                    }
                }

                pos = start;
                fail("unknown name `" + word + "`");
            }

            fail("unexpected character");
        }
    };

    expr expr::compile(const std::string &text, name_table &names) {
        expr result;
        result.text_ = text;

        parser p{ text, names, result };
        result.root_ = p.logical_or();
        p.skip();
        if (p.pos != text.size()) {
            p.fail("unexpected text");
        }

        return result;
    }

    double expr::eval(eval_context &ctx) const {
        return root_ < 0 ? 0 : eval_node(root_, ctx);
    }

    double expr::eval_node(const std::int32_t index, eval_context &ctx) const {
        const node &n = nodes_[static_cast<std::size_t>(index)];

        auto memory = [&](const std::uint32_t size, void *out) {
            const std::uint32_t addr = to_u32(eval_node(n.a, ctx));
            if (!ctx.read || !ctx.read(ctx.opaque, addr, out, size)) {
                ctx.fault = true;
                std::memset(out, 0, size);
            }
        };

        switch (n.op) {
        case OP_NUM:
            return n.value;
        case OP_REG:
            return ctx.regs[static_cast<int>(n.value)];
        case OP_REGN:
            return ctx.regs[to_u32(eval_node(n.a, ctx)) & 15];
        case OP_CPSR:
            return ctx.cpsr;
        case OP_I:
            return ctx.i;
        case OP_P:
            return ctx.p;
        case OP_VAR: {
            const std::size_t slot = static_cast<std::size_t>(n.value);
            return (ctx.vars && slot < ctx.vars->size()) ? (*ctx.vars)[slot] : 0;
        }
        case OP_U8: {
            std::uint8_t v;
            memory(1, &v);
            return v;
        }
        case OP_U16: {
            std::uint16_t v;
            memory(2, &v);
            return v;
        }
        case OP_U32: {
            std::uint32_t v;
            memory(4, &v);
            return v;
        }
        case OP_S8: {
            std::int8_t v;
            memory(1, &v);
            return v;
        }
        case OP_S16: {
            std::int16_t v;
            memory(2, &v);
            return v;
        }
        case OP_S32: {
            std::int32_t v;
            memory(4, &v);
            return v;
        }
        case OP_F32: {
            float v;
            memory(4, &v);
            return v;
        }
        case OP_FX:
            return std::ldexp(eval_node(n.a, ctx), -static_cast<int>(eval_node(n.b, ctx)));
        case OP_BITS: {
            const std::uint32_t raw = to_u32(eval_node(n.a, ctx));
            float v;
            std::memcpy(&v, &raw, 4);
            return v;
        }
        case OP_MIN:
            return std::min(eval_node(n.a, ctx), eval_node(n.b, ctx));
        case OP_MAX:
            return std::max(eval_node(n.a, ctx), eval_node(n.b, ctx));
        case OP_ABS:
            return std::fabs(eval_node(n.a, ctx));
        case OP_SEL:
            return eval_node(n.a, ctx) != 0 ? eval_node(n.b, ctx) : eval_node(n.c, ctx);
        case OP_SAR:
            return static_cast<std::int32_t>(to_u32(eval_node(n.a, ctx))) >> (to_u32(eval_node(n.b, ctx)) & 31);
        case OP_ADD:
            return eval_node(n.a, ctx) + eval_node(n.b, ctx);
        case OP_SUB:
            return eval_node(n.a, ctx) - eval_node(n.b, ctx);
        case OP_MUL:
            return eval_node(n.a, ctx) * eval_node(n.b, ctx);
        case OP_DIV: {
            const double divisor = eval_node(n.b, ctx);
            return divisor == 0 ? 0 : eval_node(n.a, ctx) / divisor;
        }
        case OP_MOD: {
            const double divisor = eval_node(n.b, ctx);
            return divisor == 0 ? 0 : std::fmod(eval_node(n.a, ctx), divisor);
        }
        case OP_SHL:
            return static_cast<std::uint32_t>(to_u32(eval_node(n.a, ctx)) << (to_u32(eval_node(n.b, ctx)) & 31));
        case OP_SHR:
            return to_u32(eval_node(n.a, ctx)) >> (to_u32(eval_node(n.b, ctx)) & 31);
        case OP_AND:
            return to_u32(eval_node(n.a, ctx)) & to_u32(eval_node(n.b, ctx));
        case OP_OR:
            return to_u32(eval_node(n.a, ctx)) | to_u32(eval_node(n.b, ctx));
        case OP_XOR:
            return to_u32(eval_node(n.a, ctx)) ^ to_u32(eval_node(n.b, ctx));
        case OP_NOT:
            return static_cast<std::uint32_t>(~to_u32(eval_node(n.a, ctx)));
        case OP_NEG:
            return -eval_node(n.a, ctx);
        case OP_LNOT:
            return eval_node(n.a, ctx) == 0;
        case OP_EQ:
            return eval_node(n.a, ctx) == eval_node(n.b, ctx);
        case OP_NE:
            return eval_node(n.a, ctx) != eval_node(n.b, ctx);
        case OP_LT:
            return eval_node(n.a, ctx) < eval_node(n.b, ctx);
        case OP_LE:
            return eval_node(n.a, ctx) <= eval_node(n.b, ctx);
        case OP_GT:
            return eval_node(n.a, ctx) > eval_node(n.b, ctx);
        case OP_GE:
            return eval_node(n.a, ctx) >= eval_node(n.b, ctx);
        case OP_LAND:
            return eval_node(n.a, ctx) != 0 && eval_node(n.b, ctx) != 0;
        case OP_LOR:
            return eval_node(n.a, ctx) != 0 || eval_node(n.b, ctx) != 0;
        default:
            return 0;
        }
    }
}
