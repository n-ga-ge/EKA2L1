/*
 * Copyright (c) 2021 EKA2L1 Team
 * 
 * This file is part of EKA2L1 project.
 * 
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 * 
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 * 
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

#include <services/bluetooth/protocols/btmidman_inet.h>
#include <services/bluetooth/btmidman.h>

#include <common/platform.h>

#if EKA2L1_PLATFORM(WEB)
#include <services/bluetooth/protocols/web/overall_web.h>
#endif

namespace eka2l1::epoc::bt {
    midman::midman()
        : local_name_(u"eka2l1")
        , native_handle_(nullptr) {
    }
    
    std::unique_ptr<midman> make_bluetooth_midman(const eka2l1::config::state &conf, const std::uint32_t reserved_stack_type) {
#if EKA2L1_PLATFORM(WEB)
        // A browser has no sockets: Bluetooth goes through the page instead.
        return web::make_midman();
#else
        return std::make_unique<midman_inet>(conf);
#endif
    }
}