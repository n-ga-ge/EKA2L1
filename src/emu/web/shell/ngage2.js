// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// N-Gage 2.0: what the page does for a game that runs on a phone (an S60 3rd
// Edition Nokia 5320) instead of the original N-Gage.
//
// The phone is a device zip (POST /v1/devices { archive }), its clock is set
// to a date when the N-Gage application's certificates were still valid
// (PUT /v1/clock), the application is installed every session because the
// emulator keeps only drive C between visits and the application lives on E,
// and the game, a .n-gage file, is installed directly, without going through
// the application (POST /v1/apps { type: "ngage2-direct" }).
//
// A game comes as a zip holding its one .n-gage file (the site's
// tools/games/pack.py stores it uncompressed); ngageFile() takes that file out.

// Any date before 2019 works; the tests use this one.
export const PHONE_CLOCK_MS = Date.parse('2009-06-01T12:00:00Z');
// An N-Gage 2.0 phone needs a memory this large (eka2l1-client.js start()).
export const PHONE_MEMORY_MB = 2048;

const u16 = (bytes, at) => bytes[at] | (bytes[at + 1] << 8);
const u32 = (bytes, at) => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;

// The .n-gage file inside a game's zip, as a source eka2l1-client.js
// uploadFrom() takes ({ bytes, open, blob }). `source` is the zip's source.
// A file that is not a zip is taken to be the .n-gage file itself.
export async function ngageFile(source) {
  const zip = await source.blob();
  const head = new Uint8Array(await zip.slice(0, 30).arrayBuffer());
  if (head.length < 30 || u32(head, 0) !== 0x04034b50) return { bytes: zip.size, open: async () => zip.stream(), blob: async () => zip };

  // The first entry's local header: method, sizes, name and extra lengths.
  const method = u16(head, 8);
  const flags = u16(head, 6);
  const nameLength = u16(head, 26);
  const extraLength = u16(head, 28);
  let packed = u32(head, 18);
  let size = u32(head, 22);
  const start = 30 + nameLength + extraLength;
  const name = new TextDecoder().decode((await zip.slice(30, 30 + nameLength).arrayBuffer()));
  if (!/\.n-gage$/i.test(name)) throw new Error(`The zip's first file is ${name}, not an N-Gage 2.0 game (.n-gage).`);
  if (flags & 8) {
    // Sizes only in the central directory: a one-entry zip has it at the end.
    const tail = new Uint8Array(await zip.slice(Math.max(0, zip.size - 65558)).arrayBuffer());
    for (let at = tail.length - 22; at >= 0; at--) {
      if (u32(tail, at) !== 0x06054b50) continue;
      const directory = u32(tail, at + 16) - Math.max(0, zip.size - 65558);
      packed = u32(tail, directory + 20);
      size = u32(tail, directory + 24);
      break;
    }
  }
  const body = zip.slice(start, start + packed);
  if (method === 0) return { bytes: size, open: async () => body.stream(), blob: async () => body };
  if (method === 8 && typeof DecompressionStream !== 'undefined') {
    const inflated = () => body.stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return { bytes: size, open: async () => inflated(), blob: async () => new Response(inflated()).blob() };
  }
  throw new Error('The game file is packed in a way this browser cannot unpack.');
}
