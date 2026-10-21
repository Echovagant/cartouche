'use client';

/**
 * 工具栏。
 *
 * 两个动作对应两条"交差"链路：
 *   - 导出 PDF：把当前视口（图框、标题栏、比例尺、图例、指北针都已画好）封成 PDF；
 *   - 兼容性报告：出一份可以直接转给 GIS 同事的自检材料。
 *
 * 按钮的可用性由上层算好：没有选中图层时没法出报告（报告要有被检查的文件）。
 */
import { FilePdfIcon, ShieldCheckIcon } from '@phosphor-icons/react';
import type { HealthStatus } from './useEngine';
import { MagneticButton } from '../motion/MagneticLink';
import { ActionButton, StatusDot } from './ui';

export interface ToolbarProps {
  onExportPdf: () => void;
  onCompatReport: () => void;
  exporting: boolean;
  reporting: boolean;
  /** 是否存在可检查的文件 */
  canReport: boolean;
  health: HealthStatus;
  onReloadHealth: () => void;
}

const HEALTH_TEXT: Record<HealthStatus, string> = {
  checking: '引擎连接中',
  ready: '引擎已就绪',
  offline: '引擎未启动',
};

export default function Toolbar({
  onExportPdf,
  onCompatReport,
  exporting,
  reporting,
  canReport,
  health,
  onReloadHealth,
}: ToolbarProps) {
  const exportDisabled = exporting || health !== 'ready';
  const reportDisabled = reporting || !canReport || health !== 'ready';

  return (
    <div className="flex items-center gap-2 border-b border-studio-line bg-studio-2/60 px-4 py-2.5">
      <MagneticButton
        onClick={onExportPdf}
        disabled={exportDisabled}
        title={health !== 'ready' ? '引擎未就绪' : '把当前视口封成带图框的 PDF'}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-accent bg-accent px-3.5 py-1.5 text-[12.5px] font-medium text-paper shadow-[0_2px_14px_-4px_rgba(47,111,94,0.85)] transition-colors hover:border-accent-deep hover:bg-accent-deep active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
      >
        <FilePdfIcon size={15} weight="bold" />
        {exporting ? '正在导出' : '导出 PDF'}
      </MagneticButton>

      <MagneticButton
        onClick={onCompatReport}
        disabled={reportDisabled}
        title={canReport ? '对当前图层生成兼容性自检报告' : '先加载一个图层'}
        className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-studio-line bg-studio-3/70 px-3 py-1.5 text-[12.5px] font-medium text-studio-ink transition-colors hover:border-studio-ink-3 hover:bg-studio-3 active:translate-y-px disabled:pointer-events-none disabled:opacity-40"
      >
        <ShieldCheckIcon size={15} weight="bold" />
        {reporting ? '正在检查' : '兼容性报告'}
      </MagneticButton>

      <span className="flex-1" />

      <span className="flex items-center gap-1.5 text-[12px] text-studio-ink-2">
        <StatusDot tone={health} />
        {HEALTH_TEXT[health]}
      </span>
      <ActionButton variant="quiet" onClick={onReloadHealth} className="!px-2 !py-1 text-[11.5px]">
        重新体检
      </ActionButton>
    </div>
  );
}
