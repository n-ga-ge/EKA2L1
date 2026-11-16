// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page logic: boots the emulator, installs the firmware and game it is given
// (by URL parameters or file pickers) and wires up input and audio.
//
//   ?fw=<url>     N-Gage firmware ROM dump to install when no device exists yet
//   ?game=<url>   game card dump (.zip/.7z/.rar) to install and launch
//   ?log=<filter> emulator log filter (default *:warn), e.g. *:info
//   ?persist=0    keep nothing between visits (default: firmware, games and
//                 saves are stored in this origin's private file system)
//
// Both are fetched with CORS, so the hosting server must allow this origin.

import { Eka2l1, KEYS } from './eka2l1-client.js';

const params = new URLSearchParams(location.search);
const statusEl = document.getElementById('status');
const overlay = document.getElementById('overlay');
const setup = document.getElementById('setup');
const canvas = document.getElementById('canvas');

const setStatus = (text) => { statusEl.textContent = text; };

// Keyboard to N-Gage keys.
const KEYMAP = {
  ArrowUp: KEYS.up, ArrowDown: KEYS.down, ArrowLeft: KEYS.left, ArrowRight: KEYS.right,
  Enter: KEYS.ok, Space: KEYS.ok, KeyQ: KEYS.lsk, KeyW: KEYS.rsk, Backspace: KEYS.clear,
  Minus: KEYS.star, Equal: KEYS.hash, KeyC: KEYS.call, KeyE: KEYS.end,
  Digit0: KEYS[0], Digit1: KEYS[1], Digit2: KEYS[2], Digit3: KEYS[3], Digit4: KEYS[4],
  Digit5: KEYS[5], Digit6: KEYS[6], Digit7: KEYS[7], Digit8: KEYS[8], Digit9: KEYS[9],
  Numpad0: KEYS[0], Numpad1: KEYS[1], Numpad2: KEYS[2], Numpad3: KEYS[3], Numpad4: KEYS[4],
  Numpad5: KEYS[5], Numpad6: KEYS[6], Numpad7: KEYS[7], Numpad8: KEYS[8], Numpad9: KEYS[9],
};

async function fetchBytes(url, label) {
  if (!/^https?:$/.test(new URL(url, location.href).protocol)) {
    throw new Error(`${label}: only http(s) URLs are allowed`);
  }

  const response = await fetch(url, { mode: 'cors', credentials: 'omit' });
  if (!response.ok) throw new Error(`${label}: download failed (${response.status})`);

  const total = Number(response.headers.get('Content-Length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    setStatus(total ? `${label}: ${Math.round((received / total) * 100)}%` : `${label}: ${(received / 1048576).toFixed(1)} MB`);
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

async function installFirmware(emu, bytes) {
  setStatus('Installing firmware…');
  const path = await emu.upload('firmware.rom', bytes);
  await emu.call('POST', '/v1/devices', { rom: path });
  await emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/firmware.rom')}`);
}

async function launch(emu, app) {
  setStatus(`Starting ${app.name}…`);
  await emu.call('POST', `/v1/apps/${app.uid}/launch`);
  setStatus(app.name);
}

async function installAndLaunch(emu, bytes, name, sourceKey = null) {
  setStatus('Installing game…');
  const path = await emu.upload(name, bytes);
  const installed = await emu.call('POST', '/v1/apps', { path, type: 'ngage' });
  await emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + name)}`);
  const app = installed.added[0] || (await emu.call('GET', '/v1/apps')).apps[0];
  if (!app) throw new Error('No game was found on the card dump');

  if (sourceKey) rememberGame(sourceKey, app.uid);
  emu.save(); // keep the installed game for the next visit
  await launch(emu, app);
}

// Which installed game a URL produced, so a repeat visit can skip the download.
const gameKey = (url) => 'eka2l1.game.' + new URL(url, location.href).href;

function rememberGame(url, uid) {
  try { localStorage.setItem(gameKey(url), uid); } catch { /* storage disabled */ }
}

async function findInstalledGame(emu, url) {
  let uid = null;
  try { uid = localStorage.getItem(gameKey(url)); } catch { /* storage disabled */ }
  if (!uid) return null;

  // Right after boot the guest is still scanning its app registries; give it
  // a moment before deciding the game is gone.
  for (let attempt = 0; attempt < 20; attempt++) {
    const { apps } = await emu.call('GET', '/v1/apps');
    const found = apps.find((app) => app.uid === uid);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

function wireInput(emu) {
  const held = new Set();

  const onKey = (down) => (event) => {
    const scan = KEYMAP[event.code];
    if (scan === undefined) return;
    event.preventDefault();
    if (down && held.has(event.code)) return; // ignore auto-repeat
    if (down) held.add(event.code); else held.delete(event.code);
    emu.key(scan, down);
  };

  window.addEventListener('keydown', onKey(true));
  window.addEventListener('keyup', onKey(false));
  window.addEventListener('blur', () => {
    for (const code of held) emu.key(KEYMAP[code], false);
    held.clear();
  });
}

function wireAudio(emu) {
  // Browsers only allow sound after a user gesture.
  const unlock = () => {
    emu.enableAudio().catch((error) => console.warn('audio unavailable:', error));
    overlay.hidden = true;
  };
  window.addEventListener('keydown', unlock, { once: true });
  window.addEventListener('pointerdown', unlock, { once: true });
}

async function main() {
  if (!crossOriginIsolated) {
    setStatus('This page needs cross-origin isolation (COOP/COEP response headers) to run.');
    return;
  }

  const emu = new Eka2l1();
  window.eka2l1 = emu; // for the console and automated tests

  setStatus('Starting emulator…');
  await emu.start({ canvas, persist: params.get('persist') !== '0' });
  wireInput(emu);
  wireAudio(emu);

  // Flush saves when the tab is hidden or closed, on top of the periodic pass.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') emu.module._eka2l1_web_save();
  });

  // ?log=<filter> turns emulator logging up, e.g. ?log=*:info or ?log=*:trace.
  if (params.get('log')) {
    await emu.call('PATCH', '/v1/config', { logFilter: params.get('log') });
  }

  const devices = await emu.call('GET', '/v1/devices');
  const hasDevice = devices.devices.length > 0;

  const fwUrl = params.get('fw');
  const gameUrl = params.get('game');

  if ((hasDevice || fwUrl) && gameUrl) {
    if (!hasDevice) await installFirmware(emu, await fetchBytes(fwUrl, 'Firmware'));

    const installed = hasDevice ? await findInstalledGame(emu, gameUrl) : null;
    if (installed) {
      await launch(emu, installed);
    } else {
      const name = new URL(gameUrl, location.href).pathname.split('/').pop() || 'game.zip';
      await installAndLaunch(emu, await fetchBytes(gameUrl, 'Game'), name, gameUrl);
    }
    overlay.textContent = 'Click or press a key for sound';
    overlay.hidden = false;
    return;
  }

  // No URLs given: ask for files.
  setStatus(hasDevice ? 'Choose a game card dump.' : 'Choose your N-Gage firmware and a game card dump.');
  document.getElementById('fw-file').parentElement.hidden = hasDevice;
  setup.hidden = false;
  setup.addEventListener('submit', async (event) => {
    event.preventDefault();
    const fwFile = document.getElementById('fw-file').files[0];
    const gameFile = document.getElementById('game-file').files[0];
    if ((!hasDevice && !fwFile) || !gameFile) return;

    setup.hidden = true;
    try {
      if (!hasDevice) await installFirmware(emu, new Uint8Array(await fwFile.arrayBuffer()));
      await installAndLaunch(emu, new Uint8Array(await gameFile.arrayBuffer()), gameFile.name);
      canvas.focus();
    } catch (error) {
      setStatus(String(error.message || error));
      setup.hidden = false;
    }
  });
}

main().catch((error) => {
  console.error(error);
  setStatus(String(error.message || error));
});
