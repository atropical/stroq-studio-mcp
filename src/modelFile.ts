// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * import_model_file's local side: the one place the relay reads files. Only a
 * .glb, a .gltf (with the .bin buffers and PNG/JPEG/WebP/KTX2 images it
 * names, from its folder and at most two levels down) or a .zip of the same;
 * no symlinks, no hidden files, nothing outside the model's folder; buffer
 * sizes must match the glTF and images their type; at most MAX_MODEL_BYTES.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';
import { inflateRawSync } from 'node:zlib';

export const MAX_MODEL_BYTES = 100 * 1024 * 1024;
/** Bytes per chunk sent to the tab (base64 makes a frame about 1.4 MB). */
export const CHUNK_BYTES = 1024 * 1024;
export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.zip'];
/** What a .gltf (or a zip) may carry beside the model. */
export const SIBLING_EXTENSIONS = ['.bin', '.png', '.jpg', '.jpeg', '.webp', '.ktx2'];
/** Folders below the model's own that a sibling may sit in. */
export const MAX_DEPTH = 2;
const MAX_SIBLINGS = 200;

export interface ModelFile {
  /** Path relative to the model's folder, with forward slashes (the main file is its base name). */
  name: string;
  data: Uint8Array;
}

export interface Sibling {
  path: string;
  /** buffers[].byteLength, when the glTF names it as a buffer. */
  byteLength?: number;
}

export class ModelFileError extends Error {}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** A regular file, not a symlink, whose real path is inside root (a real path). Returns its size. */
async function plainFileInside(path: string, root: string): Promise<number> {
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(path);
  } catch {
    throw new ModelFileError(`No file at ${path}`);
  }
  if (st.isSymbolicLink()) throw new ModelFileError(`${path} is a symlink; give the real file`);
  if (!st.isFile()) throw new ModelFileError(`${path} is not a file`);
  const rel = relative(root, await realpath(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new ModelFileError(`${path} is outside the model's folder`);
  return st.size;
}

/** A relative path's checks: no scheme, absolute, '..' or hidden segment; an allowed type; at most MAX_DEPTH folders down. */
function checkRelative(p: string, allowed: string[], what: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || /^[\\/]/.test(p) || parts.some((s) => s === '' || s === '..')) throw new ModelFileError(`${what} names a file outside its folder: ${p}`);
  if (parts.some((s) => s.startsWith('.'))) throw new ModelFileError(`${what} names a hidden file: ${p}`);
  if (parts.length - 1 > MAX_DEPTH) throw new ModelFileError(`${what} names a file more than ${MAX_DEPTH} folders down: ${p}`);
  if (!allowed.includes(extname(p).toLowerCase())) throw new ModelFileError(`${what} names ${p}: only ${allowed.join(', ')} files may come with a model`);
  return parts.join('/');
}

const IMAGE_EXTENSIONS = SIBLING_EXTENSIONS.filter((e) => e !== '.bin');

/** The files a .gltf names (buffers and images), checked; data: URIs are inside the file already. */
export function gltfSiblings(json: unknown): Sibling[] {
  const out = new Map<string, Sibling>();
  const doc = (json ?? {}) as { buffers?: unknown; images?: unknown };
  const add = (item: { uri?: unknown; byteLength?: unknown } | null, buffer: boolean) => {
    const uri = item?.uri;
    if (typeof uri !== 'string' || uri.startsWith('data:')) return;
    let p: string;
    try {
      p = decodeURIComponent(uri);
    } catch {
      throw new ModelFileError(`Bad file name in the glTF: ${uri}`);
    }
    const path = checkRelative(p, buffer ? ['.bin'] : IMAGE_EXTENSIONS, 'The glTF');
    const prev: Sibling = out.get(path) ?? { path };
    if (buffer) {
      const len = item?.byteLength;
      if (typeof len !== 'number' || !Number.isInteger(len) || len < 0) throw new ModelFileError(`The glTF buffer ${uri} has no byteLength`);
      if (prev.byteLength !== undefined && prev.byteLength !== len) throw new ModelFileError(`The glTF names ${uri} with two sizes`);
      prev.byteLength = len;
    } else if (prev.byteLength !== undefined) throw new ModelFileError(`The glTF names ${uri} as a buffer and an image`);
    out.set(path, prev);
  };
  for (const b of Array.isArray(doc.buffers) ? doc.buffers : []) add(b, true);
  for (const i of Array.isArray(doc.images) ? doc.images : []) add(i, false);
  if (out.size > MAX_SIBLINGS) throw new ModelFileError(`The glTF names more than ${MAX_SIBLINGS} files`);
  return [...out.values()];
}

const MAGIC: Record<string, number[]> = {
  '.png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  '.jpg': [0xff, 0xd8, 0xff],
  '.jpeg': [0xff, 0xd8, 0xff],
  '.ktx2': [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a],
};
const GLB = [0x67, 0x6c, 0x54, 0x46]; // "glTF"
const starts = (d: Uint8Array, sig: number[], at = 0) => d.length >= at + sig.length && sig.every((b, i) => d[at + i] === b);

/** An image's first bytes must match its type (a .env renamed .png is refused). */
export function checkImage(name: string, d: Uint8Array) {
  const ext = extname(name).toLowerCase();
  const sig = MAGIC[ext];
  const ok = ext === '.webp' ? starts(d, [0x52, 0x49, 0x46, 0x46]) && starts(d, [0x57, 0x45, 0x42, 0x50], 8) : !!sig && starts(d, sig);
  if (!ok) throw new ModelFileError(`${name} is not a ${ext.slice(1).toUpperCase()} image`);
}

function checkSibling(s: Sibling, d: Uint8Array) {
  if (s.byteLength === undefined) return checkImage(s.path, d);
  if (d.length !== s.byteLength) throw new ModelFileError(`${s.path} is ${d.length} bytes, the glTF says ${s.byteLength}`);
}

function parseGltf(d: Uint8Array, name: string): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(d));
  } catch {
    throw new ModelFileError(`${name} is not valid JSON`);
  }
}

/**
 * A zip's entries, read and checked without trusting it: only .glb/.gltf and
 * the sibling types, no hidden segments, at most MAX_DEPTH folders down,
 * stored or deflated, no encryption or zip64, within max. A .gltf inside is
 * checked like one on disk (its siblings must be in the zip); images by type.
 */
export function checkZip(zip: Uint8Array, max = MAX_MODEL_BYTES): void {
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i--)
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new ModelFileError('The .zip is not a zip file');
  const count = dv.getUint16(eocd + 10, true);
  let at = dv.getUint32(eocd + 16, true);
  if (count === 0xffff || at === 0xffffffff) throw new ModelFileError('Zip64 files are not supported');
  if (count > MAX_SIBLINGS + 10) throw new ModelFileError(`The .zip holds more than ${MAX_SIBLINGS + 10} files`);
  const entries = new Map<string, Uint8Array>();
  let total = 0;
  let models = 0;
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || dv.getUint32(at, true) !== 0x02014b50) throw new ModelFileError('The .zip is damaged');
    const flags = dv.getUint16(at + 8, true);
    const method = dv.getUint16(at + 10, true);
    const csize = dv.getUint32(at + 20, true);
    const usize = dv.getUint32(at + 24, true);
    const nlen = dv.getUint16(at + 28, true);
    const xlen = dv.getUint16(at + 30, true);
    const clen = dv.getUint16(at + 32, true);
    const local = dv.getUint32(at + 42, true);
    const name = dec.decode(zip.subarray(at + 46, at + 46 + nlen));
    at += 46 + nlen + xlen + clen;
    if (name.endsWith('/')) {
      checkRelative(`${name}x.bin`, ['.bin'], 'The .zip'); // folders: same path rules
      continue;
    }
    const path = checkRelative(name, ['.glb', '.gltf', ...SIBLING_EXTENSIONS], 'The .zip');
    if (flags & 1) throw new ModelFileError('Encrypted zips are not supported');
    if (method !== 0 && method !== 8) throw new ModelFileError(`${name}: only stored or deflated zip entries`);
    total += usize;
    if (total > max) throw new ModelFileError(`The model and its files are over ${mb(max)}`);
    if (local + 30 > zip.length || dv.getUint32(local, true) !== 0x04034b50) throw new ModelFileError('The .zip is damaged');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const raw = zip.subarray(start, start + csize);
    let data: Uint8Array;
    try {
      data = method === 0 ? raw : new Uint8Array(inflateRawSync(raw, { maxOutputLength: Math.max(1, usize) }));
    } catch {
      throw new ModelFileError(`${name} in the .zip is damaged`);
    }
    if (data.length !== usize) throw new ModelFileError(`${name} in the .zip is damaged`);
    const ext = extname(path).toLowerCase();
    if (ext === '.glb' || ext === '.gltf') models++;
    if (ext === '.glb' && !starts(data, GLB)) throw new ModelFileError(`${name} is not a GLB`);
    if (IMAGE_EXTENSIONS.includes(ext)) checkImage(path, data);
    entries.set(path, data);
  }
  if (models === 0) throw new ModelFileError('The .zip holds no .glb or .gltf');
  for (const [path, data] of entries) {
    if (extname(path).toLowerCase() !== '.gltf') continue;
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    for (const s of gltfSiblings(parseGltf(data, path))) {
      const d = entries.get(dir + s.path);
      if (!d) throw new ModelFileError(`${path} names ${s.path}, which is not in the .zip`);
      checkSibling(s, d);
    }
  }
}

/** Reads a model for import, checked as above. Throws ModelFileError with a message for the agent. */
export async function readModelFiles(path: string, max = MAX_MODEL_BYTES): Promise<ModelFile[]> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ModelFileError('Give the model as an absolute path');
  const ext = extname(path).toLowerCase();
  if (!MODEL_EXTENSIONS.includes(ext)) throw new ModelFileError(`Only ${MODEL_EXTENSIONS.join(', ')} files (export a GLB from Blender)`);
  if (basename(path).startsWith('.')) throw new ModelFileError('Hidden files are not models');
  let root: string;
  try {
    root = await realpath(dirname(path));
  } catch {
    throw new ModelFileError(`No folder at ${dirname(path)}`);
  }
  const main = join(root, basename(path));
  let total = await plainFileInside(main, root);
  if (total > max) throw new ModelFileError(`The file is over ${mb(max)}`);
  const mainData = new Uint8Array(await readFile(main));
  if (mainData.length > max) throw new ModelFileError(`The file is over ${mb(max)}`);
  const files: ModelFile[] = [{ name: basename(main), data: mainData }];
  if (ext === '.glb') {
    if (!starts(mainData, GLB)) throw new ModelFileError(`${basename(main)} is not a GLB`);
    return files;
  }
  if (ext === '.zip') {
    checkZip(mainData, max);
    return files;
  }
  for (const s of gltfSiblings(parseGltf(mainData, basename(main)))) {
    const p = join(root, ...s.path.split('/'));
    total += await plainFileInside(p, root);
    if (total > max) throw new ModelFileError(`The model and its files are over ${mb(max)}`);
    const data = new Uint8Array(await readFile(p));
    checkSibling(s, data);
    files.push({ name: s.path, data });
  }
  return files;
}
