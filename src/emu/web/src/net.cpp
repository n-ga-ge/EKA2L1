// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The boundary between the emulated Bluetooth and the page.
//
//   page  -> eka2l1_web_net_link(self_id, name)       the room link is up (id > 0) or down (0)
//   page  -> eka2l1_web_net_peer(peer_id, present)    a room member came or went
//   page  -> eka2l1_web_net_receive(src, data, len)   one frame from a member
//   page <-  Module.eka2l1OnNetSend(dst, bytes)       one frame for a member (0 = all of them)
//
// The exports are called on the page's main thread, which must never wait for
// the emulator: they copy their arguments into the link's queue and return.
// The frames are opaque here and to the page; services/bluetooth/protocols/web/stack.h
// describes them.

#include <web/net.h>

#include <services/bluetooth/protocols/web/link.h>
#include <services/bluetooth/protocols/web/overall_web.h>

#include <emscripten.h>
#include <emscripten/threading.h>

#include <cstdlib>
#include <cstring>

using namespace eka2l1;

namespace {
    using net_link = epoc::bt::web::link;

    // Called on whichever emulator thread sends; the page gets the frame on its
    // main thread, in the order the calls were made.
    void emit(int dst, const std::uint8_t *data, std::size_t size) {
        // The call is asynchronous, so the page gets its own copy to free.
        std::uint8_t *copy = static_cast<std::uint8_t *>(std::malloc(size ? size : 1));
        std::memcpy(copy, data, size);

        MAIN_THREAD_ASYNC_EM_ASM({
            const bytes = new Uint8Array(wasmMemory.buffer, $1, $2).slice();
            _free($1);
            if (Module['eka2l1OnNetSend']) {
                Module['eka2l1OnNetSend']($0, bytes);
            }
        }, dst, copy, static_cast<int>(size));
    }

    control::json null_if_empty(const std::string &text) {
        return text.empty() ? control::json(nullptr) : control::json(text);
    }
}

namespace eka2l1::web {
    void net_setup() {
        net_link::get().set_emitter(emit);
    }

    bool net_route(const control::request &req, control::response &res) {
        if (req.path != std::vector<std::string>{ "v1", "net" }) {
            return false;
        }

        if (req.method != "GET") {
            res = control::response::error(405, "method_not_allowed", "only GET is supported");
            return true;
        }

        epoc::bt::web::diagnostics diag;
        epoc::bt::web::diagnose(diag);

        control::json::array peers;
        for (const auto &peer : diag.peers) {
            peers.push_back(control::json({ { "id", peer.id },
                { "address", peer.announced ? control::json(peer.address) : control::json(nullptr) },
                { "name", peer.announced ? control::json(peer.name) : control::json(nullptr) } }));
        }

        control::json::array listeners;
        for (const auto &lis : diag.listeners) {
            listeners.push_back(control::json({ { "protocol", lis.protocol }, { "port", lis.port },
                { "queued", lis.queued }, { "accepting", lis.accepting } }));
        }

        control::json::array connections;
        for (const auto &conn : diag.connections) {
            connections.push_back(control::json({ { "peer", conn.peer }, { "id", conn.id }, { "initiator", conn.initiator },
                { "protocol", conn.protocol }, { "port", conn.port }, { "state", conn.state },
                { "txBytes", conn.tx_bytes }, { "rxBytes", conn.rx_bytes }, { "rxQueued", conn.rx_queued } }));
        }

        control::json::array events;
        for (const auto &evt : diag.events) {
            events.push_back(control::json({ { "ms", evt.ms }, { "op", evt.op }, { "protocol", null_if_empty(evt.protocol) },
                { "port", evt.port }, { "peer", evt.peer }, { "result", evt.result } }));
        }

        const auto &totals = diag.totals;

        res = control::response::from_json({
            { "link", control::json({ { "up", diag.link.up }, { "self", diag.link.self }, { "name", diag.link.name },
                          { "thread", diag.thread }, { "dropped", diag.frames_dropped } }) },
            // Without a running guest there is no Bluetooth device to have an address.
            { "attached", diag.attached },
            { "address", null_if_empty(diag.address) },
            // The device's Bluetooth name as the other players' games are told it.
            { "name", diag.attached ? control::json(diag.name) : control::json(nullptr) },
            { "peers", peers },
            { "listeners", listeners },
            { "connections", connections },
            { "totals", control::json({ { "framesIn", totals.frames_in }, { "framesOut", totals.frames_out },
                            { "badFrames", totals.bad_frames }, { "seqErrors", totals.seq_errors },
                            { "connectsIn", totals.connects_in }, { "connectsOut", totals.connects_out },
                            { "refused", totals.refused }, { "inquiries", totals.inquiries },
                            { "selections", totals.selections }, { "sdpQueries", totals.sdp_queries } }) },
            { "events", events },
        });

        return true;
    }
}

extern "C" {
// The page's room link came up (self_id is our id in the room, 1 to 255) or
// went down (0). `name` is the player's name in the room, UTF-8, at most 64
// bytes: it becomes the device's Bluetooth name, which is what the other
// players' games are shown, until the guest sets another; null or empty
// leaves the device's own name.
EMSCRIPTEN_KEEPALIVE void eka2l1_web_net_link(int self_id, const char *name) {
    net_link::get().post_link(self_id, name);
}

// A room member came (present != 0) or went.
EMSCRIPTEN_KEEPALIVE void eka2l1_web_net_peer(int peer_id, int present) {
    net_link::get().post_peer(peer_id, present != 0);
}

// One frame from the member `src_peer`, as that member's emulator sent it. The
// bytes are copied before this returns.
EMSCRIPTEN_KEEPALIVE void eka2l1_web_net_receive(int src_peer, const void *data, int len) {
    net_link::get().post_frame(src_peer, data, len);
}
}
