import type { Metadata } from 'next';
import CanvasWorkbench from './CanvasWorkbench';

export const metadata: Metadata = {
  title: '图签 Cartouche · 地图画布',
  description: '在浏览器里看工作区里的地图数据：栅格底图、矢量要素、属性表，一键导出带图框与标题栏的 PDF。',
};

/**
 * 画布路由页。
 *
 * 本身是服务端组件，只做元数据与外壳；真正需要浏览器的是里面的
 * CanvasWorkbench（'use client'）——静态导出下不需要任何 Node 运行时。
 */
export default function CanvasPage() {
  return <CanvasWorkbench />;
}
