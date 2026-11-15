'use client';

/**
 * AI 接入页 → 已退役（2026-11-15 用户裁定）。
 *
 * 全部功能（接入线/密钥/模型/试一句/一句话改图）已搬进画布右栏的 AI 面板。
 * 本页只做一件事：把来的人送到画布去。
 *
 * 为什么保留文件而不是删除路由：静态导出里 ai.html 是独立产物，
 * 浏览器书签或第三方可能还指着这个路径 —— 保留一个重定向比 404 更友好。
 */
import { useEffect } from 'react';

export default function AiRedirectPage() {
  useEffect(() => {
    window.location.href = 'canvas.html';
  }, []);

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-studio text-studio-ink">
      <div className="text-center">
        <p className="text-[14px] text-studio-ink-2">AI 功能已整合进画布 —— 正在跳转…</p>
        <a href="canvas.html" className="mt-3 inline-block text-[13px] text-accent underline">
          如果浏览器没有自动跳转，点这里
        </a>
      </div>
    </div>
  );
}
