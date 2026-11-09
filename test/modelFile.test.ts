import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { checkZip, gltfSiblings, readModelFiles } from '../src/modelFile.js';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-model-')));
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'stroq-outside-')));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
const put = (name: string, data: string | Uint8Array) => {
  const p = join(dir, name);
  writeFileSync(p, data);
  return p;
};
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const GLB = 'glTF\u0002\u0000\u0000\u0000';

/** A minimal zip (deflated entries), for the checks. */
function zip(entries: Record<string, string | Uint8Array>): Uint8Array {
  const enc = new TextEncoder();
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const comp = deflateRawSync(data);
    const n = enc.encode(name);
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0);
    l.writeUInt16LE(8, 8);
    l.writeUInt32LE(comp.length, 18);
    l.writeUInt32LE(data.length, 22);
    l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    locals.push(l, Buffer.from(n), comp);
    central.push(c, Buffer.from(n));
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Object.keys(entries).length, 8);
  e.writeUInt16LE(Object.keys(entries).length, 10);
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, e]));
}

describe('readModelFiles', () => {
  it('reads a .glb and a .zip', async () => {
    expect(await readModelFiles(put('box.glb', GLB))).toEqual([{ name: 'box.glb', data: new TextEncoder().encode(GLB) }]);
    expect((await readModelFiles(put('pack.ZIP', zip({ 'box.glb': GLB, 'tex/a.png': PNG }))))[0]!.name).toBe('pack.ZIP');
    await expect(readModelFiles(put('fake.glb', 'not a glb'))).rejects.toThrow('not a GLB');
  });

  it('reads a .gltf with the buffers and images it names, from its folder', async () => {
    mkdirSync(join(dir, 'tex'), { recursive: true });
    put('mesh.bin', 'bin');
    put('tex/a b.png', PNG);
    const gltf = put('scene.gltf', JSON.stringify({ buffers: [{ uri: 'mesh.bin', byteLength: 3 }, { uri: 'data:application/octet-stream;base64,AA==', byteLength: 1 }], images: [{ uri: 'tex/a%20b.png' }] }));
    expect((await readModelFiles(gltf)).map((f) => f.name)).toEqual(['scene.gltf', 'mesh.bin', 'tex/a b.png']);
  });

  it('refuses other types, relative paths, folders and missing files', async () => {
    await expect(readModelFiles(put('model.fbx', 'x'))).rejects.toThrow('Only .glb, .gltf, .zip');
    await expect(readModelFiles('box.glb')).rejects.toThrow('absolute path');
    mkdirSync(join(dir, 'dir.glb'), { recursive: true });
    await expect(readModelFiles(join(dir, 'dir.glb'))).rejects.toThrow('not a file');
    await expect(readModelFiles(join(dir, 'gone.glb'))).rejects.toThrow('No file');
  });

  it('refuses a .env (or any other file) named as a buffer or image', async () => {
    put('.env', 'SECRET=1');
    put('notes.txt', 'x');
    for (const buffers of [[{ uri: '.env', byteLength: 8 }], [{ uri: 'notes.txt', byteLength: 1 }], [{ uri: 'sub/.git/x.bin', byteLength: 1 }]])
      await expect(readModelFiles(put('leak.gltf', JSON.stringify({ buffers })))).rejects.toThrow(/hidden|only \.bin/);
    await expect(readModelFiles(put('leak2.gltf', JSON.stringify({ images: [{ uri: '.env' }] })))).rejects.toThrow('hidden');
    expect(() => gltfSiblings({ images: [{ uri: 'a/b/c/d.png' }] })).toThrow('folders down');
    expect(gltfSiblings({ images: [{ uri: 'a/b/d.png' }] })).toEqual([{ path: 'a/b/d.png' }]);
  });

  it('refuses a buffer whose size is not its byteLength, and a fake image', async () => {
    put('short.bin', 'abc');
    await expect(readModelFiles(put('size.gltf', JSON.stringify({ buffers: [{ uri: 'short.bin', byteLength: 99 }] })))).rejects.toThrow('the glTF says 99');
    await expect(readModelFiles(put('nolen.gltf', JSON.stringify({ buffers: [{ uri: 'short.bin' }] })))).rejects.toThrow('no byteLength');
    put('fake.png', 'SECRET=1');
    await expect(readModelFiles(put('img.gltf', JSON.stringify({ images: [{ uri: 'fake.png' }] })))).rejects.toThrow('not a PNG');
  });

  it('refuses symlinks, and glTF files that point out of the folder', async () => {
    writeFileSync(join(outside, 'secret.glb'), GLB);
    symlinkSync(join(outside, 'secret.glb'), join(dir, 'link.glb'));
    await expect(readModelFiles(join(dir, 'link.glb'))).rejects.toThrow('symlink');
    writeFileSync(join(outside, 'k.bin'), 'x');
    symlinkSync(join(outside, 'k.bin'), join(dir, 'k.bin'));
    await expect(readModelFiles(put('linked.gltf', JSON.stringify({ buffers: [{ uri: 'k.bin', byteLength: 1 }] })))).rejects.toThrow('symlink');
    for (const uri of ['../x.bin', '/etc/passwd', 'file:///etc/passwd', '..%2Fx.bin', 'a/../../x.bin', 'C:\\x.bin'])
      expect(() => gltfSiblings({ buffers: [{ uri, byteLength: 1 }] }), uri).toThrow();
  });

  it('caps the size, siblings included', async () => {
    await expect(readModelFiles(put('big.glb', new Uint8Array(2000)), 1000)).rejects.toThrow('over');
    put('half.bin', new Uint8Array(600));
    await expect(readModelFiles(put('two.gltf', JSON.stringify({ buffers: [{ uri: 'half.bin', byteLength: 600 }], pad: 'x'.repeat(500) })), 1000)).rejects.toThrow('over');
  });
});

describe('checkZip', () => {
  it('takes a model with its buffers and images', () => {
    expect(() => checkZip(zip({ 'm/scene.gltf': JSON.stringify({ buffers: [{ uri: 'a.bin', byteLength: 2 }], images: [{ uri: 't/a.png' }] }), 'm/a.bin': 'ab', 'm/t/a.png': PNG }))).not.toThrow();
  });

  it('refuses dotfiles, other types, deep paths, fakes and wrong sizes', () => {
    expect(() => checkZip(zip({ 'box.glb': GLB, '.env': 'x' }))).toThrow('hidden');
    expect(() => checkZip(zip({ 'box.glb': GLB, '__MACOSX/._box.glb': 'x' }))).toThrow('hidden');
    expect(() => checkZip(zip({ 'box.glb': GLB, 'notes.txt': 'x' }))).toThrow('only');
    expect(() => checkZip(zip({ 'box.glb': GLB, '../x.png': PNG }))).toThrow('outside');
    expect(() => checkZip(zip({ 'a/b/c/box.glb': GLB }))).toThrow('folders down');
    expect(() => checkZip(zip({ 'box.glb': GLB, 'fake.png': 'SECRET' }))).toThrow('not a PNG');
    expect(() => checkZip(zip({ 'box.glb': 'nope' }))).toThrow('not a GLB');
    expect(() => checkZip(zip({ 'a.png': PNG }))).toThrow('no .glb');
    expect(() => checkZip(zip({ 's.gltf': JSON.stringify({ buffers: [{ uri: 'a.bin', byteLength: 5 }] }), 'a.bin': 'ab' }))).toThrow('the glTF says 5');
    expect(() => checkZip(zip({ 's.gltf': JSON.stringify({ buffers: [{ uri: 'gone.bin', byteLength: 2 }] }) }))).toThrow('not in the .zip');
    expect(() => checkZip(new TextEncoder().encode('PK'))).toThrow('not a zip');
  });
});
