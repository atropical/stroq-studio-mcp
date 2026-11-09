// stroq-studio-mcp: the relay between an MCP client and a Strōq World Studio tab.
// Copyright (C) 2026 Atropical
// SPDX-License-Identifier: GPL-3.0-only

/**
 * import_model_file's local side: the one place the relay reads files. Only a
 * .glb, a .gltf (with the buffers and images it names, from its own folder)
 * or a .zip; no symlinks, nothing outside the model's folder, at most
 * MAX_MODEL_BYTES in all.
 */
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative } from 'node:path';

export const MAX_MODEL_BYTES = 100 * 1024 * 1024;
/** Bytes per chunk sent to the tab (base64 makes a frame about 1.4 MB). */
export const CHUNK_BYTES = 1024 * 1024;
export const MODEL_EXTENSIONS = ['.glb', '.gltf', '.zip'];
const MAX_SIBLINGS = 200;

export interface ModelFile {
  /** Path relative to the model's folder, with forward slashes (the main file is its base name). */
  name: string;
  data: Uint8Array;
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

/** The files a .gltf names (buffers and images), as relative paths; data: URIs are inside the file already. */
export function gltfSiblings(json: unknown): string[] {
  const out = new Set<string>();
  const doc = (json ?? {}) as { buffers?: unknown; images?: unknown };
  const items = [...(Array.isArray(doc.buffers) ? doc.buffers : []), ...(Array.isArray(doc.images) ? doc.images : [])] as { uri?: unknown }[];
  for (const item of items) {
    const uri = item?.uri;
    if (typeof uri !== 'string' || uri.startsWith('data:')) continue;
    let p: string;
    try {
      p = decodeURIComponent(uri);
    } catch {
      throw new ModelFileError(`Bad file name in the glTF: ${uri}`);
    }
    if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || /^[\\/]/.test(p) || p.split(/[\\/]/).includes('..')) throw new ModelFileError(`The glTF names a file outside its folder: ${uri}`);
    out.add(p.replace(/\\/g, '/'));
  }
  if (out.size > MAX_SIBLINGS) throw new ModelFileError(`The glTF names more than ${MAX_SIBLINGS} files`);
  return [...out];
}

/** Reads a model for import, checked as above. Throws ModelFileError with a message for the agent. */
export async function readModelFiles(path: string, max = MAX_MODEL_BYTES): Promise<ModelFile[]> {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new ModelFileError('Give the model as an absolute path');
  const ext = extname(path).toLowerCase();
  if (!MODEL_EXTENSIONS.includes(ext)) throw new ModelFileError(`Only ${MODEL_EXTENSIONS.join(', ')} files (export a GLB from Blender)`);
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
  if (ext !== '.gltf') return files;
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(mainData));
  } catch {
    throw new ModelFileError('The .gltf is not valid JSON');
  }
  for (const rel of gltfSiblings(json)) {
    const p = join(root, ...rel.split('/'));
    total += await plainFileInside(p, root);
    if (total > max) throw new ModelFileError(`The model and its files are over ${mb(max)}`);
    files.push({ name: rel, data: new Uint8Array(await readFile(p)) });
  }
  return files;
}
