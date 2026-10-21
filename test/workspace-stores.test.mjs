import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { MemoryStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'memory-store.ts')).href
);
const { HttpProjectStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'http-store.ts')).href
);
const { FileHandleStore } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'workspace', 'file-handle-store.ts')).href
);

/* ─────────── MemoryStore ─────────── */

test('MemoryStore：写入后可读回，内容一致', async () => {
  const store = new MemoryStore();
  await store.write('a/b.txt', new TextEncoder().encode('hello'));
  const back = await store.read('a/b.txt');
  assert.equal(Buffer.from(back).toString('utf8'), 'hello');
  assert.equal(await store.exists('a/b.txt'), true);
  assert.equal(await store.exists('nope.txt'), false);
});

test('MemoryStore：rename 覆盖已有目标', async () => {
  const store = new MemoryStore();
  await store.write('a.txt', new TextEncoder().encode('OLD'));
  await store.write('b.txt', new TextEncoder().encode('NEW'));
  await store.rename('b.txt', 'a.txt');
  assert.equal(Buffer.from(await store.read('a.txt')).toString(), 'NEW');
  assert.equal(await store.exists('b.txt'), false);
});

test('MemoryStore：list 返回目录下的条目名', async () => {
  const store = new MemoryStore();
  await store.write('d/x.txt', new TextEncoder().encode('1'));
  await store.write('d/y.txt', new TextEncoder().encode('2'));
  const entries = await store.list('d');
  assert.deepEqual(entries.sort(), ['x.txt', 'y.txt']);
});

test('MemoryStore：lock 标记会让 assertWritable 抛 OccupiedError', async () => {
  const store = new MemoryStore();
  await store.write('a.shp', new TextEncoder().encode('x'));
  await store.write('a.lock', new TextEncoder().encode(''));
  await assert.rejects(() => store.assertWritable('a.shp'), /文件被占用/);
});

/* ─────────── HttpProjectStore（对接真实 HTTP 服务） ─────────── */

/**
 * 契约：引擎服务暴露一组 /api/fs/* 端点。
 * 这里起一个真实 HTTP 服务实现该契约，测的是客户端的真实行为。
 */
function startContractServer() {
  const files = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (code, body, type = 'application/json') => {
      const buf = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      res.writeHead(code, { 'content-type': type, 'content-length': Buffer.byteLength(buf) });
      res.end(buf);
    };
    const readBody = () =>
      new Promise((resolve) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks)));
      });

    if (req.method === 'GET' && url.pathname === '/api/fs/read') {
      const p = url.searchParams.get('path');
      const v = files.get(p);
      if (!v) return send(404, { error: 'not_found' });
      return send(200, v, 'application/octet-stream');
    }
    if (req.method === 'GET' && url.pathname === '/api/fs/stat') {
      const p = url.searchParams.get('path');
      const v = files.get(p);
      if (!v) return send(404, { error: 'not_found' });
      return send(200, { size: v.length, mtimeMs: 1, isDirectory: false });
    }
    if (req.method === 'GET' && url.pathname === '/api/fs/list') {
      const p = url.searchParams.get('path') ?? '';
      const prefix = p ? `${p}/` : '';
      const names = new Set();
      for (const k of files.keys()) {
        if (k.startsWith(prefix)) names.add(k.slice(prefix.length).split('/')[0]);
      }
      return send(200, { entries: [...names] });
    }
    if (req.method === 'POST' && url.pathname === '/api/fs/write') {
      return readBody().then((buf) => {
        // 约定：body 形如 "path\0bytes"
        const sep = buf.indexOf(0);
        const p = buf.subarray(0, sep).toString('utf8');
        files.set(p, buf.subarray(sep + 1));
        send(200, { ok: true, size: files.get(p).length });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/fs/remove') {
      return readBody().then((buf) => {
        files.delete(buf.toString('utf8'));
        send(200, { ok: true });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/fs/rename') {
      return readBody().then((buf) => {
        const [from, to] = buf.toString('utf8').split('\n');
        files.set(to, files.get(from));
        files.delete(from);
        send(200, { ok: true });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/fs/copy') {
      return readBody().then((buf) => {
        const [from, to] = buf.toString('utf8').split('\n');
        files.set(to, Buffer.from(files.get(from)));
        send(200, { ok: true });
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/fs/assert-writable') {
      return readBody().then((buf) => {
        const p = buf.toString('utf8');
        // 约定：锁文件按"去掉扩展名"命名 —— a.shp 的锁是 a.lock
        const stem = p.slice(p.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
        if (files.has(`${stem}.lock`)) return send(409, { error: 'occupied' });
        send(200, { ok: true });
      });
    }
    return send(404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

test('HttpProjectStore：写入后可读回（走真实 HTTP）', async () => {
  const { server, base } = await startContractServer();
  try {
    const store = new HttpProjectStore({ baseUrl: base });
    await store.write('data/a.tif', new TextEncoder().encode('payload'));
    const back = await store.read('data/a.tif');
    assert.equal(Buffer.from(back).toString('utf8'), 'payload');
  } finally {
    server.close();
  }
});

test('HttpProjectStore：读取不存在的文件抛 NotFoundError', async () => {
  const { server, base } = await startContractServer();
  try {
    const store = new HttpProjectStore({ baseUrl: base });
    await assert.rejects(() => store.read('missing.bin'), /文件不存在/);
  } finally {
    server.close();
  }
});

test('HttpProjectStore：占用时 assertWritable 抛 OccupiedError', async () => {
  const { server, base } = await startContractServer();
  try {
    const store = new HttpProjectStore({ baseUrl: base });
    await store.write('a.shp', new TextEncoder().encode('x'));
    await store.write('a.lock', new TextEncoder().encode(''));
    await assert.rejects(() => store.assertWritable('a.shp'), /文件被占用/);
  } finally {
    server.close();
  }
});

test('HttpProjectStore：rename 与 copy 生效', async () => {
  const { server, base } = await startContractServer();
  try {
    const store = new HttpProjectStore({ baseUrl: base });
    await store.write('a.txt', new TextEncoder().encode('DATA'));
    await store.copy('a.txt', 'b.txt');
    assert.equal(Buffer.from(await store.read('b.txt')).toString(), 'DATA');
    await store.rename('b.txt', 'c.txt');
    assert.equal(await store.exists('b.txt'), false);
    assert.equal(Buffer.from(await store.read('c.txt')).toString(), 'DATA');
  } finally {
    server.close();
  }
});

test('HttpProjectStore：list 返回条目名', async () => {
  const { server, base } = await startContractServer();
  try {
    const store = new HttpProjectStore({ baseUrl: base });
    await store.write('d/x.txt', new TextEncoder().encode('1'));
    await store.write('d/y.txt', new TextEncoder().encode('2'));
    const entries = await store.list('d');
    assert.deepEqual(entries.sort(), ['x.txt', 'y.txt']);
  } finally {
    server.close();
  }
});

/* ─────────── FileHandleStore（浏览器文件系统 API） ─────────── */

/**
 * 浏览器没有 Node 环境，这里用最小的 File System Access API 替身。
 * 测的是 FileHandleStore 自身的逻辑（路径拼接、读写、错误映射），
 * 而不是浏览器 API 本身。
 */
function makeFakeDirectoryApi() {
  const files = new Map();
  const dirs = new Set(['']);

  function ensureDirs(path) {
    const parts = path.split('/').filter(Boolean);
    let acc = '';
    for (const p of parts) {
      acc = acc ? `${acc}/${p}` : p;
      dirs.add(acc);
    }
  }

  const api = {
    files,
    async getFileHandle(name, opts) {
      if (!opts?.create && !files.has(name)) {
        const e = new Error('not found');
        e.name = 'NotFoundError';
        throw e;
      }
      ensureDirs('');
      return {
        kind: 'file',
        name,
        async createWritable() {
          let buf = new Uint8Array();
          return {
            async write(chunk) {
              const b = chunk instanceof Uint8Array ? chunk : new TextEncoder().encode(String(chunk));
              const merged = new Uint8Array(buf.length + b.length);
              merged.set(buf);
              merged.set(b, buf.length);
              buf = merged;
            },
            async close() {
              files.set(name, buf);
            },
          };
        },
        async getFile() {
          const data = files.get(name) ?? new Uint8Array();
          return {
            size: data.length,
            lastModified: 1,
            async arrayBuffer() {
              return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
            },
          };
        },
      };
    },
    async getDirectoryHandle(name, opts) {
      ensureDirs(name);
      return {
        kind: 'directory',
        name,
        // 目录句柄同样能拿到文件句柄（真实 API 也是如此）
        getFileHandle: (n, o) => api.getFileHandle(name ? `${name}/${n}` : n, o),
        getDirectoryHandle: (n, o) => api.getDirectoryHandle(name ? `${name}/${n}` : n, o),
        async removeEntry(n) {
          files.delete(name ? `${name}/${n}` : n);
        },
      };
    },
    async removeEntry(name) {
      files.delete(name);
    },
  };
  return api;
}

test('FileHandleStore：写入后可读回', async () => {
  const api = makeFakeDirectoryApi();
  const store = new FileHandleStore({ api });
  await store.write('a/b.txt', new TextEncoder().encode('browser'));
  const back = await store.read('a/b.txt');
  assert.equal(Buffer.from(back).toString('utf8'), 'browser');
});

test('FileHandleStore：读取不存在的文件抛 NotFoundError', async () => {
  const api = makeFakeDirectoryApi();
  const store = new FileHandleStore({ api });
  await assert.rejects(() => store.read('missing.txt'), /文件不存在/);
});

test('FileHandleStore：exists 反映文件是否存在', async () => {
  const api = makeFakeDirectoryApi();
  const store = new FileHandleStore({ api });
  assert.equal(await store.exists('x.txt'), false);
  await store.write('x.txt', new TextEncoder().encode('1'));
  assert.equal(await store.exists('x.txt'), true);
});

test('FileHandleStore：权限类错误按"存在"处理，不伪装成不存在', async () => {
  const api = makeFakeDirectoryApi();
  await api.getFileHandle('x.txt', { create: true });
  const store = new FileHandleStore({ api });
  const original = api.getFileHandle;
  api.getFileHandle = async (name, opts) => {
    if (!opts?.create) {
      const e = new Error('permission denied');
      e.name = 'NotAllowedError';
      throw e;
    }
    return original(name, opts);
  };
  assert.equal(await store.exists('x.txt'), true, '访问被拒时应按"存在"处理');
});
