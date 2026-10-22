import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { LocalFolderStore, OccupiedError } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'index.ts')).href
);
const { writeBack, backupPathFor, replaceFileAtomically } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'gdal', 'writeback.ts')).href
);
const { resolveGdal } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'gdal', 'env.ts')).href
);
const { runTool } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'gdal', 'runner.ts')).href
);
const { RasterEditor, readRasterPixels } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'raster', 'index.ts')).href
);

/** GDAL 位置；本机没装 GDAL 时为 null（引擎接线那条用例会跳过） */
const gdalLoc = resolveGdal();

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cartouche-wb-'));
  const store = new LocalFolderStore(dir);
  await store.write('data.tif', new TextEncoder().encode('ORIGINAL'));
  return { dir, store };
}

/**
 * 造一张可改的 GeoTIFF（16×12、三波段、带仿射参数）。
 *
 * 用 gdal_create 而不是手搓二进制：它产出的是标准 GTiff，
 * 颜色解释是 Red/Green/Blue —— 正好覆盖"窗口写回时颜色解释要一致"那条链路。
 */
async function makeRaster(dir, name) {
  const out = join(dir, `${name}.tif`);
  const res = await runTool(gdalLoc, `gdal_create${gdalLoc.exeSuffix}`, [
    '-outsize', '16', '12',
    '-bands', '3',
    '-ot', 'Byte',
    '-a_srs', 'EPSG:4326',
    '-a_ullr', '120.30', '30.532', '120.316', '30.52',
    '-burn', '10', '-burn', '20', '-burn', '30',
    out,
  ]);
  if (!res.ok) throw new Error(`gdal_create 失败：${res.stderr}`);
  return out;
}

test('写回：原文件被新内容整体替换', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'MODIFIED');
    assert.equal(res.verified, true);
    assert.equal(res.bytesWritten, 8);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：自动生成备份，且备份内容是原文件', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    assert.ok(res.backupPath, '应返回备份路径');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是写回前的原内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：backup=false 时不产生备份', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      backup: false,
    });
    assert.equal(res.backupPath, null);
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：即使 exists() 误报"不存在"，也必须生成备份（防无备份覆盖原文件）', async () => {
  const { dir, store } = await setup();
  try {
    // 模拟 Windows 上文件被杀软/索引器短暂独占：access 失败 → 早期实现的 exists()
    // 会把它误判成"文件不存在"，于是跳过备份直接覆盖原文件。
    const lying = Object.create(store);
    lying.exists = async () => false;
    const res = await writeBack(lying, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
    });
    assert.ok(res.backupPath, 'exists() 误报不存在时也必须生成备份');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是写回前的原内容');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子替换：即使 exists() 误报"不存在"，也必须生成备份', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('.tmp.tif', new TextEncoder().encode('NEW'));
    const lying = Object.create(store);
    lying.exists = async () => false;
    const res = await replaceFileAtomically(lying, { target: 'data.tif', tempPath: '.tmp.tif' });
    assert.ok(res.backupPath, 'exists() 误报不存在时也必须生成备份');
    const backup = Buffer.from(await store.read(res.backupPath)).toString();
    assert.equal(backup, 'ORIGINAL', '备份必须是替换前的原内容');
    assert.equal(Buffer.from(await store.read('data.tif')).toString(), 'NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：同一秒内对同一目标连续写回，备份不会互相覆盖', async () => {
  const { dir, store } = await setup();
  try {
    // 用同一个 label 强制两次备份同名，模拟"同一秒内连续写回"
    const r1 = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('VERSION2'),
      label: 'same',
    });
    const r2 = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('VERSION3'),
      label: 'same',
    });
    assert.notEqual(r1.backupPath, r2.backupPath, '两次备份不能是同一个文件名');
    assert.equal(
      Buffer.from(await store.read(r1.backupPath)).toString(),
      'ORIGINAL',
      '第一份备份必须仍是最初的内容（不能被第二次覆盖）',
    );
    assert.equal(
      Buffer.from(await store.read(r2.backupPath)).toString(),
      'VERSION2',
      '第二份备份是上一版内容',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：目标确实不存在时不产生备份，写入仍然成功', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'brand-new.tif',
      data: new TextEncoder().encode('BRAND NEW'),
    });
    assert.equal(res.backupPath, null, '目标本来就不存在，不应有备份');
    assert.equal(Buffer.from(await store.read('brand-new.tif')).toString(), 'BRAND NEW');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：不留下临时文件', async () => {  const { dir, store } = await setup();
  try {
    await writeBack(store, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') });
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '不应残留 .tmp 文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：伴随文件一并写入', async () => {
  const { dir, store } = await setup();
  try {
    await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      sidecars: [
        { path: 'data.tfw', data: new TextEncoder().encode('0.001\n') },
        { path: 'data.prj', data: new TextEncoder().encode('GEOGCS[]\n') },
      ],
    });
    assert.equal(Buffer.from(await store.read('data.tfw')).toString(), '0.001\n');
    assert.ok(await store.exists('data.prj'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：文件被占用时抛 OccupiedError 且原文件不变', async () => {
  const { dir, store } = await setup();
  try {
    // 模拟 ArcGIS 持有文件：覆盖式 rename 失败（EPERM/EBUSY）
    const locked = Object.create(store);
    locked.rename = async () => {
      const err = new Error('EPERM: operation not permitted');
      err.code = 'EPERM';
      throw err;
    };
    await assert.rejects(
      () => writeBack(locked, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /文件被占用/,
    );
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'ORIGINAL', '被占用时原文件必须保持不变');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '失败后应清理临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：存在锁文件时提前拒绝，且不产生备份', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('data.lock', new TextEncoder().encode(''));
    await assert.rejects(
      () => writeBack(store, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /文件被占用/,
    );
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0, '被占用时不应产生备份');
    assert.equal(Buffer.from(await store.read('data.tif')).toString(), 'ORIGINAL');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('写回：校验失败时中止替换，原文件保持不变', async () => {
  const { dir, store } = await setup();
  try {
    // 注入一个会篡改写入内容的 store，模拟"写进去的东西不对"
    const evil = Object.create(store);
    evil.write = async (path, data) => {
      if (String(path).endsWith('.tmp')) {
        await store.write(path, new TextEncoder().encode('CORRUPTED'));
        return;
      }
      return store.write(path, data);
    };
    await assert.rejects(
      () => writeBack(evil, { target: 'data.tif', data: new TextEncoder().encode('MODIFIED') }),
      /校验失败/,
    );
    const after = Buffer.from(await store.read('data.tif')).toString();
    assert.equal(after, 'ORIGINAL', '校验失败时原文件必须保持不变');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.endsWith('.tmp')).length, 0, '失败后应清理临时文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('backupPathFor：备份名带时间戳且与目标同目录', () => {
  const p = backupPathFor('a/b/data.tif');
  assert.ok(p.startsWith('a/b/data.tif.bak.'), p);
  assert.ok(!p.includes('\\'), '应使用正斜杠保持跨平台一致');
});

/* ── 另存为新文件（copy 模式）─────────────────────────────────────────
 *
 * 用户裁定（2026-10-22）：默认直接改原文件，另给一个"另存为新文件"的按钮。
 *
 * copy 模式的底线只有一条：**原文件一个字节都不动**。
 * 缺 outputPath、或 outputPath 就是原文件时必须明确报错 ——
 * 默默退回 replace 会把用户的原文件改掉，
 * 而用户以为自己是"存了个副本"，那是这条链路上最坏的结果。
 */

test('另存为新文件：新文件被写入，原文件一个字节都不动', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      mode: 'copy',
      outputPath: 'copy.tif',
    });
    assert.ok(res.outputPath, '应返回新文件路径');
    assert.equal(res.backupPath, null, '原文件没被改，备份它没有意义');
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '原文件必须一个字节都不动',
    );
    assert.equal(Buffer.from(await store.read('copy.tif')).toString(), 'MODIFIED');
    assert.equal(res.verified, true);
    assert.equal(res.bytesWritten, 8);
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0, 'copy 模式不应产生备份');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('另存为新文件：没给 outputPath 时明确报错，不默默改成写原文件', async () => {
  const { dir, store } = await setup();
  try {
    await assert.rejects(
      () =>
        writeBack(store, {
          target: 'data.tif',
          data: new TextEncoder().encode('MODIFIED'),
          mode: 'copy',
        }),
      /必须给出 outputPath/,
    );
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '报错后原文件必须没动',
    );
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0, '报错后不应产生备份');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('另存为新文件：outputPath 与原文件相同则明确报错', async () => {
  const { dir, store } = await setup();
  try {
    // 同一路径的两种写法都要被拦下 —— 比的是解析后的绝对路径，不是字符串
    await assert.rejects(
      () =>
        writeBack(store, {
          target: 'data.tif',
          data: new TextEncoder().encode('MODIFIED'),
          mode: 'copy',
          outputPath: 'data.tif',
        }),
      /不能与原文件相同/,
    );
    await assert.rejects(
      () =>
        writeBack(store, {
          target: 'data.tif',
          data: new TextEncoder().encode('MODIFIED'),
          mode: 'copy',
          outputPath: './data.tif',
        }),
      /不能与原文件相同/,
    );
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '报错后原文件必须没动',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('另存为新文件：占用检测查的是新文件，被占用时报错且原文件不变', async () => {
  const { dir, store } = await setup();
  try {
    // 模拟 ArcGIS 正打开**新文件**：占用检测必须落在我们要写的那个路径上
    const occupied = Object.create(store);
    occupied.assertWritable = async (path) => {
      if (String(path).includes('copy.tif')) throw new OccupiedError(path, new Error('busy'));
      return store.assertWritable(path);
    };
    await assert.rejects(
      () =>
        writeBack(occupied, {
          target: 'data.tif',
          data: new TextEncoder().encode('MODIFIED'),
          mode: 'copy',
          outputPath: 'copy.tif',
        }),
      /文件被占用/,
    );
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '被占用时原文件必须保持不变',
    );
    assert.equal(await store.exists('copy.tif'), false, '被占用时不应产出新文件');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('另存为新文件：原文件正被占用也不影响另存（原文件一个字节都不动）', async () => {
  const { dir, store } = await setup();
  try {
    // copy 模式根本不写原文件，所以原文件被 ArcGIS 打开时**不该**失败 ——
    // "原图开着，另存一份"恰恰是这个按钮最常见的用法。
    const occupied = Object.create(store);
    occupied.assertWritable = async (path) => {
      if (String(path).includes('data.tif')) throw new OccupiedError(path, new Error('busy'));
      return store.assertWritable(path);
    };
    const res = await writeBack(occupied, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      mode: 'copy',
      outputPath: 'copy.tif',
    });
    assert.equal(Buffer.from(await store.read('copy.tif')).toString(), 'MODIFIED');
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '原文件必须一个字节都不动',
    );
    assert.equal(res.backupPath, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('另存为新文件：伴随文件写到新文件旁边并跟着改名', async () => {
  const { dir, store } = await setup();
  try {
    const res = await writeBack(store, {
      target: 'data.tif',
      data: new TextEncoder().encode('MODIFIED'),
      mode: 'copy',
      outputPath: 'copy.tif',
      sidecars: [
        { path: 'data.tfw', data: new TextEncoder().encode('0.001\n') },
        { path: 'data.prj', data: new TextEncoder().encode('GEOGCS[]\n') },
      ],
    });
    assert.equal(
      Buffer.from(await store.read('copy.tfw')).toString(),
      '0.001\n',
      '伴随文件应跟着新文件改名并落在新文件旁边',
    );
    assert.ok(await store.exists('copy.prj'));
    assert.equal(await store.exists('data.tfw'), false, '原文件旁边的伴随文件不应被动');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子替换：copy 模式把临时文件落到新文件，原文件不动且不产生备份', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('.tmp.tif', new TextEncoder().encode('NEW'));
    const res = await replaceFileAtomically(store, {
      target: 'data.tif',
      tempPath: '.tmp.tif',
      mode: 'copy',
      outputPath: 'copy.tif',
    });
    assert.equal(res.backupPath, null, '原文件没被改，不应有备份');
    assert.ok(res.outputPath, '应返回新文件路径');
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '原文件必须一个字节都不动',
    );
    assert.equal(Buffer.from(await store.read('copy.tif')).toString(), 'NEW');
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes('.bak.')).length, 0, 'copy 模式不应产生备份');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('原子替换：copy 模式没给 outputPath 时明确报错', async () => {
  const { dir, store } = await setup();
  try {
    await store.write('.tmp.tif', new TextEncoder().encode('NEW'));
    await assert.rejects(
      () => replaceFileAtomically(store, { target: 'data.tif', tempPath: '.tmp.tif', mode: 'copy' }),
      /必须给出 outputPath/,
    );
    assert.equal(
      Buffer.from(await store.read('data.tif')).toString(),
      'ORIGINAL',
      '报错后原文件必须没动',
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  '另存为新文件（引擎接线）：像素级操作写到新文件，原文件一个字节都不动',
  { skip: gdalLoc ? false : '本机没有 GDAL，跳过' },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cartouche-wb-gdal-'));
    const store = new LocalFolderStore(dir);
    try {
      await makeRaster(dir, 'marked');
      const editor = new RasterEditor({ loc: gdalLoc, store });
      const before = await readFile(join(dir, 'marked.tif'));

      const res = await editor.paint(
        { target: 'marked.tif', region: { minX: 4, minY: 3, maxX: 10, maxY: 8 }, color: '#00FF00' },
        { outputPath: 'copy.tif' },
      );

      const after = await readFile(join(dir, 'marked.tif'));
      assert.deepEqual(after, before, '原文件必须一个字节都不动');
      assert.ok(res.outputPath, '应返回新文件路径');
      assert.equal(res.backupPath, null, '原文件没被改，不应有备份');
      assert.ok(res.verified, '新文件应通过回读校验');

      // 涂色落在新文件上：#00FF00 → R=0、G=255、B=0（原图烧的是 10/20/30）
      const px = await readRasterPixels(gdalLoc, join(dir, 'copy.tif'));
      const idx = 5 * px.width + 5;
      assert.equal(px.bands[0][idx], 0, '新文件上应有涂色（红通道）');
      assert.equal(px.bands[1][idx], 255, '新文件上应有涂色（绿通道）');
      assert.equal(px.bands[2][idx], 0, '新文件上应有涂色（蓝通道）');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);
