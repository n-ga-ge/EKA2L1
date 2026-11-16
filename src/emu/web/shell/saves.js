// Copyright (c) 2026 EKA2L1 Team.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Save data export and import.
//
// N-Gage games keep their saves and settings in the phone's memory, under
// C:\System\Apps\<game folder>\ (Shadowkey: game00.sav ... plus its key
// configuration). Export packs that folder tree into a .zip; import puts a
// .zip back. The archive paths are relative to C:\, so an export can be
// inspected or edited with any zip tool and imported again.

// The guest folder that holds every game's writable data.
export const SAVE_ROOT = 'System/Apps';

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_IMPORT_FILES = 2000;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

// Builds an uncompressed zip from [{ name, bytes, modified? }].
export function buildZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const { time, day } = dosDateTime(file.modified || new Date());
    const crc = crc32(file.bytes);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, file.bytes.length, true);
    local.setUint32(22, file.bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, file.bytes);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, file.bytes.length, true);
    entry.setUint32(24, file.bytes.length, true);
    entry.setUint16(28, name.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), name);

    offset += 30 + name.length + file.bytes.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);

  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Reads a zip (stored or deflated entries) into [{ name, bytes }].
export async function readZip(buffer) {
  const data = new Uint8Array(buffer);
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  let end = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) throw new Error('This is not a zip archive.');

  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  if (count > MAX_IMPORT_FILES) throw new Error('The archive has too many files to be a save export.');

  const decoder = new TextDecoder();
  const files = [];
  let total = 0;

  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('The archive is damaged.');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith('/')) continue; // directory entry

    total += size;
    if (total > MAX_IMPORT_BYTES) throw new Error('The archive is too large to be a save export.');

    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = data.subarray(start, start + packed);
    let bytes;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) bytes = await inflateRaw(raw);
    else throw new Error(`"${name}" uses a compression method this page cannot read.`);

    if (bytes.length !== size || crc32(bytes) !== crc) throw new Error(`"${name}" is damaged.`);
    files.push({ name, bytes });
  }

  return files;
}

// Archive name -> path under the save root, or null if the entry does not
// belong there. Rejects anything that could climb out of the folder.
export function saveRelativePath(name) {
  const parts = name.replace(/\\/g, '/').split('/').filter((part) => part.length > 0);
  if (parts.some((part) => part === '.' || part === '..' || part.includes(':'))) return null;
  const root = SAVE_ROOT.split('/');
  if (parts.length <= root.length) return null;
  for (let i = 0; i < root.length; i++) {
    if (parts[i].toLowerCase() !== root[i].toLowerCase()) return null;
  }
  return parts.slice(root.length).join('/');
}

const guestPath = (relative) => `C:/${SAVE_ROOT}${relative ? '/' + relative : ''}`;
const fileTarget = (relative) => '/v1/files?path=' + encodeURIComponent(guestPath(relative));

// Lists every file under the save root: [{ path, size, modified }], with
// `path` relative to the root.
export async function listSaves(emu) {
  const out = [];
  const walk = async (relative) => {
    const res = await emu.request('GET', fileTarget(relative));
    if (!res.ok) return;
    for (const entry of res.json().entries || []) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.directory) await walk(child);
      else out.push({ path: child, size: entry.size, modified: entry.modified });
    }
  };
  await walk('');
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// Packs the save folder into a zip Blob. Returns { blob, files }.
export async function exportSaves(emu) {
  const listing = await listSaves(emu);
  const files = [];
  for (const item of listing) {
    const res = await emu.request('GET', fileTarget(item.path));
    if (!res.ok) throw new Error(`Could not read ${item.path}`);
    files.push({ name: `${SAVE_ROOT}/${item.path}`, bytes: res.body, modified: item.modified ? new Date(item.modified) : new Date() });
  }
  return { blob: buildZip(files), files: files.length };
}

// Writes the save files of a zip back into the guest and stores them.
// Returns { written, skipped }: entries outside the save folder are skipped.
export async function importSaves(emu, buffer) {
  const entries = await readZip(buffer);
  let written = 0;
  let skipped = 0;

  for (const entry of entries) {
    const relative = saveRelativePath(entry.name);
    if (relative === null) { skipped++; continue; }
    const res = await emu.request('PUT', fileTarget(relative), entry.bytes);
    if (!res.ok) throw new Error(`Could not write ${relative}: ${res.text()}`);
    written++;
  }

  if (written === 0) throw new Error(`The archive has no files under ${SAVE_ROOT}/. Was it exported from this page?`);
  await emu.save();
  return { written, skipped };
}

export function downloadBlob(blob, name) {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 10000);
}

export function exportFileName(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `eka2l1-saves-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.zip`;
}
