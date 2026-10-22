import type { Metadata } from 'next';
import AiWorkbench from './AiWorkbench';

export const metadata: Metadata = {
  title: '图签 Cartouche · AI 接入',
  description:
    '配置模型密钥、实时拉取官方模型清单、发一句话测连通性。密钥只留在本机，不落盘明文、不进仓库。',
};

/**
 * AI 接入路由页。
 *
 * 和画布一样：服务端组件只做元数据外壳，交互都在 'use client' 的
 * AiWorkbench 里 —— 静态导出下不需要任何 Node 运行时。
 */
export default function AiPage() {
  return <AiWorkbench />;
}
