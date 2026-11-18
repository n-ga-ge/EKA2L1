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

// ---------------------------------------------------------------------------
// TEMPORARY STAND-IN, to be deleted once the emulator's "ngage2-direct" install
// type has landed (EKA2L1 branch ngage2-direct-install). An emulator without
// it answers 400 "unknown install type"; the page then does what that install
// type does, the way the N-Gage 2.0 bring-up did it by hand:
//   1. cut the part with Content-ID <Game> (a SIS file) out of the .n-gage
//      file, which is a MIME multipart (the <Metadata> part before it has the
//      same package UID and would uninstall the game if installed after it);
//   2. install that SIS (POST /v1/apps { path }); see which executables it
//      added to E:/sys/bin (or C:/sys/bin);
//   3. write the app registration the application would have written,
//      <drive>:/private/10003a3f/import/apps/<exe>_reg.rsc, on the exe's
//      drive, and make the emulator read the registrations again.
// It returns what POST /v1/apps returns: { added: [{ name, uid }] }.

// The Game part's byte range in the .n-gage file.
async function gamePart(file) {
  const text = new TextDecoder('latin1').decode(await file.arrayBuffer());
  const boundary = /boundary="?([^";\r\n]+)"?/i.exec(text.slice(0, 2048));
  if (!boundary) throw new Error('Not an N-Gage 2.0 game file: it has no parts.');
  const id = text.search(/Content-ID:\s*<Game>/i);
  if (id < 0) throw new Error('The N-Gage 2.0 game file has no Game part.');
  const start = text.indexOf('\r\n\r\n', id) + 4;
  // The part ends where the next boundary line starts; the files seen have no
  // line break before the last one.
  let end = text.indexOf(`--${boundary[1]}`, start);
  if (start < 4 || end < 0) throw new Error('The N-Gage 2.0 game file is cut short.');
  if (text.slice(end - 2, end) === '\r\n') end -= 2;
  return [start, end];
}

// Symbian's checksum of a UID triple (Mem::Crc over the even and the odd bytes).
function uidChecksum(bytes) {
  const crc = (values) => {
    let value = 0;
    for (const byte of values) {
      value ^= byte << 8;
      for (let bit = 0; bit < 8; bit++) value = (value & 0x8000 ? (value << 1) ^ 0x1021 : value << 1) & 0xffff;
    }
    return value;
  };
  const even = []; const odd = [];
  bytes.forEach((byte, index) => (index % 2 ? odd : even).push(byte));
  return ((crc(odd) << 16) | crc(even)) >>> 0;
}

// An APP_REGISTRATION_INFO resource for app `uid` whose executable is
// `exe` (without .exe): the layout of the one written by hand for Asphalt 3,
// with the UID, the checksum, the name and the offsets that follow it changed.
export function registration(uid, exe) {
  const name = [...exe].map((char) => char.charCodeAt(0));
  if (!name.length || name.length > 64 || name.some((code) => code < 0x20 || code > 0x7e)) throw new Error(`cannot register an executable named ${exe}`);
  const out = [];
  const word = (value) => out.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const half = (value) => out.push(value & 0xff, (value >>> 8) & 0xff);
  word(0x101F4A6B); word(0x101F8021); word(uid >>> 0);
  word(uidChecksum(out.slice(0, 12)));
  out.push(0x00); half(0x35 + 2 * name.length); out.push(0x01); // flags, largest resource, which hold compressed text
  const first = out.length;
  out.push(0x00); // no text run first
  out.push(0x09, 0, 0, 0, 0, 0, 0, 0, 0, name.length); // reserved long and link, the name's length
  out.push(name.length, ...name); // the name, as compressed text
  out.push(0x19, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, ...new Array(15).fill(0)); // the rest, as written for Asphalt 3
  const end = out.length;
  half(first); half(end);
  return new Uint8Array(out);
}

async function listing(emu, path) {
  const response = await emu.request('GET', `/v1/files?path=${encodeURIComponent(path)}`);
  return response.ok ? (response.json().entries || []).map((entry) => entry.name) : [];
}

export async function standInInstall(emu, file, name, uid) {
  console.warn('the emulator has no "ngage2-direct" install: using the page\'s stand-in');
  const blob = await file.blob();
  const [start, end] = await gamePart(blob);
  const before = { E: await listing(emu, 'E:/sys/bin'), C: await listing(emu, 'C:/sys/bin') };
  const part = blob.slice(start, end);
  const sisName = `${name}-game.sis`;
  try {
    const path = await emu.uploadFrom(sisName, { bytes: part.size, open: async () => part.stream() });
    await emu.call('POST', '/v1/apps', { path, type: 'sis' });
  } finally {
    await emu.request('DELETE', `/v1/files?path=${encodeURIComponent('docs:/uploads/' + sisName)}`);
  }
  // Without a catalogue: the game's package UID (the SIS file's third UID),
  // which is its app's UID in the games tried.
  const header = new Uint8Array(await part.slice(0, 12).arrayBuffer());
  const wanted = uid ? parseInt(String(uid), 16) : u32(header, 8);
  if (!(wanted > 0)) throw new Error('It is not known which app the game starts.');
  // The game's program is the new executable whose third UID is the app's
  // (ONE also installs a small starter, AS_2000AFBF.exe, with another UID).
  let drive = null; let exe = null;
  for (const letter of ['E', 'C']) {
    const added = (await listing(emu, `${letter}:/sys/bin`)).filter((entry) => !before[letter].includes(entry) && /\.exe$/i.test(entry));
    for (const entry of added) {
      const response = await emu.request('GET', `/v1/files?path=${encodeURIComponent(`${letter}:/sys/bin/${entry}`)}`);
      if (response.ok && response.body.length >= 12 && u32(response.body, 8) === wanted) { drive = letter; exe = entry.replace(/\.exe$/i, ''); break; }
    }
    if (exe) break;
  }
  if (!exe) throw new Error('The game was installed, but its program was not found.');
  await emu.call('PUT', `/v1/files?path=${encodeURIComponent(`${drive}:/private/10003a3f/import/apps/${exe}_reg.rsc`)}`, registration(wanted, exe));
  // Remounting the (empty) card slot makes the emulator read the registrations again.
  await emu.request('DELETE', '/v1/card');
  // The registration has no caption, and the emulator's list leaves such an
  // app out; it launches all the same.
  const apps = (await emu.call('GET', '/v1/apps?system=1')).apps || [];
  const listed = apps.find((item) => parseInt(item.uid, 16) === wanted);
  return { added: [listed || { uid: `0x${wanted.toString(16).toUpperCase().padStart(8, '0')}`, name: exe }] };
}
// End of the TEMPORARY STAND-IN.
