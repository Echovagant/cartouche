'use client';

/**
 * 项目相关的引擎调用封装。
 *
 * 为什么单独抽一个 hook：
 *   - 「登记根 / 读写清单 / 落产出物」是一组独立于出图的动作，
 *     混进 useEngine 会让那个 hook 同时管两件事（地图数据 vs 项目数据），
 *     将来动一边很容易踩到另一边；
 *   - 「最近打开过的项目」只存在**浏览器本地**（localStorage）：
 *     它是"我刚才在做什么"的提示，不是项目数据。
 *     项目数据一律落在项目目录的 `.cartouche/` 里，浏览器里不留副本。
 *
 * 路径语义（与引擎的契约一致）：
 *   - `path` 一律是**项目的绝对路径**（项目根在哪）；
 *   - 引擎请求里的 `path` 一律是**相对项目根**的路径，`root` 才是项目根。
 *     两者不要混：这里管前者，useEngine 管后者。
 */

import { useCallback, useEffect, useState } from 'react';
import { ENGINE_BASE } from './useEngine';
import type { ProjectManifest, ProjectOutput, ProjectSummary } from './types';

export type { ProjectManifest, ProjectOutput, ProjectSummary } from './types';

const RECENT_KEY = 'cartouche.recent-projects';

/** 本地最近项目：只存在浏览器里，不外传、也不落进项目目录 */
function readRecent(): ProjectSummary[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is ProjectSummary =>
          typeof item === 'object' &&
          item !== null &&
          typeof (item as ProjectSummary).path === 'string',
      )
      .slice(0, 10);
  } catch {
    return [];
  }
}

function writeRecent(list: readonly ProjectSummary[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
  } catch {
    /* 隐私模式下写不了，忽略即可 */
  }
}

/** 从错误响应里挖出能给人看的中文说明 */
async function readErrorMessage(res: Response): Promise<string> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { message?: string };
    if (body?.message) detail = body.message;
  } catch {
    /* 错误体不是 JSON（例如代理返回的 HTML），保留状态码 */
  }
  return detail;
}

/** 统一的请求入口：把"连不上"翻译成能照着做的话 */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw new Error(
      `无法连接引擎服务 ${ENGINE_BASE}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
    );
  }
}

/** Blob → 纯 base64（去掉 data URL 前缀） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'));
    reader.readAsDataURL(blob);
  });
}

export function useProjects() {
  const [recent, setRecent] = useState<readonly ProjectSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRecent(readRecent());
    setLoading(false);
  }, []);

  /** 把打开过的项目记到本地，方便下次直接点开 */
  const remember = useCallback((path: string, m: ProjectManifest) => {
    const summary: ProjectSummary = {
      path,
      name: m.name,
      updatedAt: m.updatedAt,
      layerCount: m.layers.length,
    };
    const next = [summary, ...readRecent().filter((p) => p.path !== path)].slice(0, 10);
    writeRecent(next);
    setRecent(next);
  }, []);

  /**
   * 把文件夹登记成引擎的工作区根。
   *
   * 幂等：同一个目录重复登记，引擎返回的还是那一条（不会拿到两个 id）。
   */
  const registerRoot = useCallback(async (path: string): Promise<void> => {
    try {
      const res = await request(`${ENGINE_BASE}/api/workspace/roots`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      if (!res.ok) throw new Error(await readErrorMessage(res));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
      throw err;
    }
  }, []);

  const createProject = useCallback(
    async (path: string): Promise<ProjectManifest> => {
      // 先登记成根：项目目录不在任何已登记根之下的话，引擎根本定位不到它
      await registerRoot(path);
      const res = await request(`${ENGINE_BASE}/api/project/manifest`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          path,
          create: true,
          name: path.split(/[\\/]+/).filter(Boolean).pop() ?? path,
        }),
      });
      if (!res.ok) {
        const message = `新建项目失败：${await readErrorMessage(res)}`;
        setError(message);
        throw new Error(message);
      }
      const body = (await res.json()) as { manifest?: ProjectManifest };
      if (!body.manifest) {
        const message = '新建项目失败：引擎没有返回项目清单';
        setError(message);
        throw new Error(message);
      }
      remember(path, body.manifest);
      setError(null);
      return body.manifest;
    },
    [registerRoot, remember],
  );

  const openProject = useCallback(
    async (path: string): Promise<ProjectManifest | null> => {
      // 项目可能是在别的机器上建的（.cartouche 存在、但本机没登记过这个目录），
      // 所以**打开时也要登记一次**，否则引擎定位不到它。
      await registerRoot(path);
      const res = await request(
        `${ENGINE_BASE}/api/project/manifest?path=${encodeURIComponent(path)}`,
      );
      if (!res.ok) {
        const message = `读取项目失败：${await readErrorMessage(res)}`;
        setError(message);
        throw new Error(message);
      }
      const body = (await res.json()) as { exists?: boolean; manifest?: ProjectManifest };
      if (!body.exists || !body.manifest) return null;
      remember(path, body.manifest);
      setError(null);
      return body.manifest;
    },
    [registerRoot, remember],
  );

  const saveManifest = useCallback(async (path: string, m: ProjectManifest): Promise<void> => {
    const res = await request(`${ENGINE_BASE}/api/project/manifest`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, manifest: m }),
    });
    if (!res.ok) {
      const message = `保存项目清单失败：${await readErrorMessage(res)}`;
      setError(message);
      throw new Error(message);
    }
    setError(null);
  }, []);

  const listOutputs = useCallback(async (path: string): Promise<ProjectOutput[]> => {
    const res = await request(`${ENGINE_BASE}/api/project/outputs?path=${encodeURIComponent(path)}`);
    if (!res.ok) return [];
    const body = (await res.json()) as { outputs?: ProjectOutput[] };
    return body.outputs ?? [];
  }, []);

  /**
   * 把产出物存进项目的 `.cartouche/outputs/`。
   *
   * 用 FileReader 而不是手工拼 base64：几 MB 的 PDF 手工拼会慢，而且
   * `String.fromCharCode(...bytes)` 那样展开还会爆调用栈。
   */
  const writeOutput = useCallback(async (path: string, name: string, data: Blob): Promise<string> => {
    const dataBase64 = await blobToBase64(data);
    const res = await request(`${ENGINE_BASE}/api/project/output`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, name, dataBase64 }),
    });
    if (!res.ok) {
      const message = `保存产出物失败：${await readErrorMessage(res)}`;
      setError(message);
      throw new Error(message);
    }
    const body = (await res.json()) as { relative?: string };
    setError(null);
    return body.relative ?? '';
  }, []);

  return {
    recent,
    loading,
    error,
    registerRoot,
    createProject,
    openProject,
    saveManifest,
    listOutputs,
    writeOutput,
  };
}
