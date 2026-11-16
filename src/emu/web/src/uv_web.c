// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// libuv platform layer for the browser build. libuv has no Emscripten port, and
// its portable poll(2) backend keeps its descriptor table in loop fields that
// only exist on the platforms uv/unix.h knows about. This one is stateless: it
// rebuilds the table from the loop's watcher list on every poll, which is
// cheap for the handful of descriptors the emulator ever watches.
//
// Emscripten's poll() does not block, so waiting is done in short sleeps.
#include "uv.h"
#include "internal.h"

#include <errno.h>
#include <poll.h>
#include <stdlib.h>
#include <unistd.h>

#define WEB_POLL_SLICE_US 2000

int uv__platform_loop_init(uv_loop_t *loop) {
    (void)loop;
    return 0;
}

void uv__platform_loop_delete(uv_loop_t *loop) {
    (void)loop;
}

int uv__io_fork(uv_loop_t *loop) {
    (void)loop;
    return 0;
}

void uv__platform_invalidate_fd(uv_loop_t *loop, int fd) {
    // Nothing is cached between polls; a stopped watcher is already gone from
    // loop->watchers, which is what uv__io_poll consults.
    (void)loop;
    (void)fd;
}

int uv__io_check_fd(uv_loop_t *loop, int fd) {
    struct pollfd p[1];
    int rv;
    (void)loop;

    p[0].fd = fd;
    p[0].events = POLLIN;
    p[0].revents = 0;

    do
        rv = poll(p, 1, 0);
    while (rv == -1 && (errno == EINTR || errno == EAGAIN));

    if (rv == -1)
        return UV__ERR(errno);

    if (p[0].revents & POLLNVAL)
        return UV_EINVAL;

    return 0;
}

void uv__io_poll(uv_loop_t *loop, int timeout) {
    struct pollfd *fds;
    unsigned int count;
    unsigned int i;
    unsigned int nevents;
    int have_signals;
    int nfds;
    uint64_t deadline;
    QUEUE *q;
    uv__io_t *w;

    if (loop->nfds == 0)
        return;

    while (!QUEUE_EMPTY(&loop->watcher_queue)) {
        q = QUEUE_HEAD(&loop->watcher_queue);
        QUEUE_REMOVE(q);
        QUEUE_INIT(q);

        w = QUEUE_DATA(q, uv__io_t, watcher_queue);
        w->events = w->pevents;
    }

    fds = uv__malloc(sizeof(*fds) * (loop->nwatchers ? loop->nwatchers : 1));
    if (fds == NULL)
        abort();

    deadline = (timeout > 0) ? (uv__hrtime(UV_CLOCK_FAST) / 1000000 + (uint64_t)timeout) : 0;

    for (;;) {
        count = 0;
        for (i = 0; i < loop->nwatchers; i++) {
            w = loop->watchers[i];
            if (w != NULL && w->events != 0) {
                fds[count].fd = w->fd;
                fds[count].events = (short)w->events;
                fds[count].revents = 0;
                count++;
            }
        }

        nfds = count ? poll(fds, count, 0) : 0;
        SAVE_ERRNO(uv__update_time(loop));

        if (nfds > 0) {
            nevents = 0;
            have_signals = 0;

            for (i = 0; i < count; i++) {
                if ((unsigned)fds[i].fd >= loop->nwatchers)
                    continue;

                // Re-read: an earlier callback may have stopped this watcher.
                w = loop->watchers[fds[i].fd];
                if (w == NULL)
                    continue;

                fds[i].revents &= w->pevents | POLLERR | POLLHUP;
                if (fds[i].revents == 0)
                    continue;

                if (w == &loop->signal_io_watcher) {
                    have_signals = 1;
                } else {
                    w->cb(loop, w, fds[i].revents);
                }
                nevents++;
            }

            if (have_signals != 0)
                loop->signal_io_watcher.cb(loop, &loop->signal_io_watcher, POLLIN);

            if (nevents != 0 || have_signals != 0)
                break;
        }

        if (timeout == 0)
            break;

        if (timeout > 0 && (uv__hrtime(UV_CLOCK_FAST) / 1000000) >= deadline)
            break;

        usleep(WEB_POLL_SLICE_US);
    }

    uv__free(fds);
}

// A page cannot enumerate network interfaces, so the guest sees none.
int uv_interface_addresses(uv_interface_address_t **addresses, int *count) {
    *addresses = NULL;
    *count = 0;
    return 0;
}

void uv_free_interface_addresses(uv_interface_address_t *addresses, int count) {
    (void)addresses;
    (void)count;
}
