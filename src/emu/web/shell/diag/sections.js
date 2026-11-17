// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The sections of the diagnostics, in no particular order: each says where it
// goes with `order`. core.js describes what a section is.

import audio from './audio.js';
import browser from './browser.js';
import environment from './environment.js';
import errors from './errors.js';
import graphics from './graphics.js';
import memory from './memory.js';
import network from './network.js';
import session from './session.js';
import speed from './speed.js';
import startup from './startup.js';

export const SECTIONS = [session, speed, graphics, audio, errors, memory, environment, network, startup, browser];
