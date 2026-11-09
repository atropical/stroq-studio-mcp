import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gltfSiblings, readModelFiles } from '../src/modelFile.js';

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

describe('readModelFiles', () => {
  it('reads a .glb and a .zip', async () => {
    expect(await readModelFiles(put('box.glb', 'glTF'))).toEqual([{ name: 'box.glb', data: new TextEncoder().encode('glTF') }]);
    expect((await readModelFiles(put('pack.ZIP', 'PK')))[0]!.name).toBe('pack.ZIP');
  });

  it('reads a .gltf with the buffers and images it names, from its folder', async () => {
    mkdirSync(join(dir, 'tex'), { recursive: true });
    put('mesh.bin', 'bin');
    put('tex/a b.png', 'png');
    const gltf = put('scene.gltf', JSON.stringify({ buffers: [{ uri: 'mesh.bin' }, { uri: 'data:application/octet-stream;base64,AA==' }], images: [{ uri: 'tex/a%20b.png' }] }));
    expect((await readModelFiles(gltf)).map((f) => f.name)).toEqual(['scene.gltf', 'mesh.bin', 'tex/a b.png']);
  });

  it('refuses other types, relative paths, folders and missing files', async () => {
    await expect(readModelFiles(put('model.fbx', 'x'))).rejects.toThrow('Only .glb, .gltf, .zip');
    await expect(readModelFiles('box.glb')).rejects.toThrow('absolute path');
    mkdirSync(join(dir, 'dir.glb'), { recursive: true });
    await expect(readModelFiles(join(dir, 'dir.glb'))).rejects.toThrow('not a file');
    await expect(readModelFiles(join(dir, 'gone.glb'))).rejects.toThrow('No file');
  });

  it('refuses symlinks, and glTF files that point out of the folder', async () => {
    writeFileSync(join(outside, 'secret.glb'), 'x');
    symlinkSync(join(outside, 'secret.glb'), join(dir, 'link.glb'));
    await expect(readModelFiles(join(dir, 'link.glb'))).rejects.toThrow('symlink');
    writeFileSync(join(outside, 'k.bin'), 'x');
    symlinkSync(join(outside, 'k.bin'), join(dir, 'k.bin'));
    await expect(readModelFiles(put('linked.gltf', JSON.stringify({ buffers: [{ uri: 'k.bin' }] })))).rejects.toThrow('symlink');
    for (const uri of ['../x.bin', '/etc/passwd', 'file:///etc/passwd', '..%2Fx.bin', 'a/../../x.bin', 'C:\\x.bin'])
      expect(() => gltfSiblings({ buffers: [{ uri }] }), uri).toThrow('outside its folder');
  });

  it('caps the size, siblings included', async () => {
    await expect(readModelFiles(put('big.glb', new Uint8Array(2000)), 1000)).rejects.toThrow('over');
    put('half.bin', new Uint8Array(600));
    await expect(readModelFiles(put('two.gltf', JSON.stringify({ buffers: [{ uri: 'half.bin' }], pad: 'x'.repeat(500) })), 1000)).rejects.toThrow('over');
  });
});

