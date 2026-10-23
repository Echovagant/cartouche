'use client';

/**
 * 计划确认闸门（多条操作时的形态）。
 *
 * 与 `canvas/ConfirmCard.tsx` 是**同一套交互**：
 *   · 先把影响面、目标文件、备份文件、操作类型一次说清楚；
 *   · 影响面超过一半要再点一次才真的执行；
 *   · 预演失败就不给执行按钮（影响面算不出来，没资格让人确认）；
 *   · 取消什么也不发生。
 *
 * 为什么不直接用 ConfirmCard：它的 props 是**单条**操作（op / preview 各一个），
 * 而模型给的是一份计划里的**好几条**操作，每条都有自己的影响面。
 * 这里把同一套规则按 N 条并排报出来。ConfirmCard 本身**没有改动** ——
 * 计划只有一条操作时仍然直接用它。
 */

import { useEffect, useState } from 'react';
import { CheckCircleIcon, WarningIcon } from '@phosphor-icons/react';
import { ActionButton } from '../canvas/ui';
import { opLabel } from './opLabels';
import { describeZeroImpact, findZeroImpactOps } from './failures';

/** 计划里的一条操作 */
export interface PlanGateOp {
  readonly op: string;
  readonly params: Record<string, unknown>;
}

/** 一条操作的预演结果（与引擎 /api/op/preview 的返回同形） */
export interface PlanGatePreview {
  readonly op: string;
  readonly target: string;
  /** 像元口径的 op 才有这三个数；非像元型 op 是 null */
  readonly affectedPixels: number | null;
  readonly totalPixels: number | null;
  readonly affectedRatio: number | null;
  readonly backupPath: string | null;
  readonly backupNamePattern?: string | null;
  readonly verified: boolean;
  /**
   * raster = 像元口径；value = 非像元型 op（改属性、改编码那种）。
   *
   * 为什么确认卡要分这个：矢量 op 没有像元，"将影响的像元 0 / 0"对它毫无意义，
   * 硬显示出来等于给用户一个假数字。它自己有一句人话结论（如"12 条要素会赋值"），
   * 那才是用户该看的。
   */
  readonly kind?: 'raster' | 'value' | undefined;
  /** 非像元型 op 自己的人话结论 */
  readonly summary?: string | null;
}

export interface PlanGateProps {
  readonly ops: readonly PlanGateOp[];
  readonly previews: readonly PlanGatePreview[];
  readonly previewing: boolean;
  readonly previewError: string | null;
  readonly executing: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** 影响面超过这个比例就要二次确认 */
const LARGE_IMPACT_RATIO = 0.5;

function formatCount(n: number): string {
  return n.toLocaleString('zh-CN');
}

/** 目标路径：params 里可能写成 dataset:// 相对路径，这里只做展示用的还原 */
function targetOf(params: Record<string, unknown>): string {
  const raw = params['target'];
  if (typeof raw !== 'string' || raw.trim() === '') return '（未指定）';
  return raw.replace(/^(?:dataset|layer|summary):\/\//, '');
}

export default function PlanGate({
  ops,
  previews,
  previewing,
  previewError,
  executing,
  onConfirm,
  onCancel,
}: PlanGateProps) {
  // 二次确认的"上膛"状态：第一次点只是把按钮换成更郑重的说法
  const [armed, setArmed] = useState(false);

  // 换一份计划就重新上膛：上一条的风险提示不能顺延到下一条
  useEffect(() => {
    setArmed(false);
  }, [ops]);

  const largeImpact = previews.some(
    (p) => p.kind !== 'value' && (p.totalPixels ?? 0) > 0 && ratioOf(p) > LARGE_IMPACT_RATIO,
  );

  /**
   * 预演说「一个像元都没改到」的操作。
   *
   * 这种改动**什么都不会发生**：多半是区域落在影像之外，或掩膜没盖住任何像元。
   * 引擎会把它判成失败（2026-10-23 起），所以界面也不能给执行按钮 ——
   * 不然用户看到的还是「0 / 192 像元（0.0%）」，像是最轻松的一次改动。
   */
  const zeroImpactIndexes = findZeroImpactOps(previews);
  const hasZeroImpact = zeroImpactIndexes.length > 0;

  const handleConfirm = (): void => {
    if (largeImpact && !armed) {
      setArmed(true);
      return;
    }
    onConfirm();
  };

  const canExecute =
    previews.length === ops.length && ops.length > 0 && previewError === null && !executing && !hasZeroImpact;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-studio/78 p-6 backdrop-blur-sm">
      <div
        className="w-[560px] max-w-full rounded-panel border border-studio-line bg-studio-2 p-5"
        style={{ boxShadow: 'var(--studio-stage-shadow)' }}
      >
        <div className="flex items-center gap-2.5">
          <strong className="font-display text-[15px] font-semibold text-studio-ink">
            确认这次改动
          </strong>
          <span className="rounded border border-studio-line bg-studio-3/70 px-1.5 py-0.5 font-mono text-[11px] text-studio-ink-2">
            {ops.length} 条操作
          </span>
          <span className="flex-1" />
          <ActionButton variant="quiet" onClick={onCancel} className="!px-2 !py-1 text-[11.5px]">
            取消
          </ActionButton>
        </div>

        <ol className="mt-4 flex flex-col gap-3">
          {ops.map((op, index) => {
            const preview = previews[index];
            const ratio = preview ? ratioOf(preview) : 0;
            // 非像元型 op（矢量改属性那种）：不报像元，报它自己的结论。
            const isValue = preview?.kind === 'value';
            const backupText = preview?.backupPath
              ? preview.backupPath
              : preview?.backupNamePattern
                ? isValue
                  ? `如需写文件，自动备份为 ${preview.backupNamePattern}（与原文件同目录）`
                  : `${preview.backupNamePattern}（与原文件同目录）`
                : '（引擎执行时自动生成备份）';
            const gates = [
              ...(isValue
                ? [
                    {
                      label: '这次会做什么',
                      value: preview?.summary ?? '（引擎没有给出结论）',
                    },
                  ]
                : [
                    {
                      label: '将影响的像元',
                      value: preview
                        ? `${formatCount(preview.affectedPixels ?? 0)} / ${formatCount(preview.totalPixels ?? 0)} 像元（${(ratio * 100).toFixed(1)}%）`
                        : '正在计算…',
                    },
                  ]),
              { label: '目标文件', value: preview?.target ?? targetOf(op.params) },
              { label: '将生成的备份', value: backupText },
              { label: '操作类型', value: `${opLabel(op.op)}（${op.op}）` },
            ];
            return (
              <li
                key={`${op.op}-${index}`}
                className="rounded-lg border border-studio-line bg-studio/45 px-3 py-2"
              >
                <div className="mb-2 font-mono text-[11.5px] text-studio-ink-3">
                  第 {index + 1} 条 · {op.op}
                </div>
                <ul className="flex flex-col gap-1.5">
                  {gates.map((gate) => (
                    <li key={gate.label} className="flex items-start gap-2.5">
                      <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/20 font-mono text-[10px] text-accent">
                        ·
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[11px] text-studio-ink-3">{gate.label}</div>
                        <div className="mt-0.5 font-mono text-[12.5px] break-all text-studio-ink">
                          {gate.value}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
        </ol>

        {previewError ? (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <strong>预演失败：</strong>
            {previewError}
            <div className="mt-1 text-studio-ink-3">影响面算不出来，这次先不执行。</div>
          </div>
        ) : null}

        {largeImpact && previewError === null ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warn/45 bg-warn/14 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <WarningIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
            <span>
              <strong>影响面过大：</strong>
              这次改动会影响一半以上的像元，请确认。
              <br />
              <span className="text-studio-ink-2">点一次只是提醒，再点一次才真的执行。</span>
            </span>
          </div>
        ) : null}

        {hasZeroImpact && previewError === null ? (
          <div className="mt-3 flex items-start gap-2 rounded-lg border border-warn/45 bg-warn/14 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <WarningIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
            <span>
              <strong>有操作一个像元都没改到：</strong>
              第 {zeroImpactIndexes.map((i) => i + 1).join('、')} 条预演下来影响像元是 0
              （多半是区域落在影像之外，或掩膜没盖住任何像元）。
              <br />
              <span className="text-studio-ink-2">
                下一步：
                {describeZeroImpact({
                  index: zeroImpactIndexes[0],
                  op: previews[zeroImpactIndexes[0] ?? 0]?.op,
                  totalPixels: previews[zeroImpactIndexes[0] ?? 0]?.totalPixels ?? 0,
                }).next}
              </span>
            </span>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          <ActionButton variant="quiet" onClick={onCancel} disabled={executing}>
            取消
          </ActionButton>
          {previewError ? null : (
            <ActionButton
              variant="primary"
              onClick={handleConfirm}
              disabled={!canExecute}
              title={
                canExecute
                  ? '执行这次改动'
                  : hasZeroImpact
                    ? '有操作一个像元都没改到，先把区域对齐再执行'
                    : '正在预演…'
              }
            >
              {executing
                ? '执行中…'
                : previewing
                  ? '预演中…'
                  : armed
                    ? '我确认，继续执行'
                    : '确认执行'}
            </ActionButton>
          )}
        </div>
      </div>
    </div>
  );
}

function ratioOf(preview: PlanGatePreview): number {
  const total = preview.totalPixels ?? 0;
  if (total <= 0) return 0;
  const ratio = preview.affectedRatio ?? 0;
  return ratio > 0 ? ratio : (preview.affectedPixels ?? 0) / total;
}

/** 执行成功后给的一句收尾（成功 / 部分成功 / 失败） */
export function outcomeTone(
  ok: boolean,
  completed: number,
  total: number,
): 'ok' | 'warn' | 'error' {
  if (ok) return 'ok';
  return completed > 0 ? 'warn' : 'error';
}

/** 收尾提示里的图标（保持与 ConfirmCard 一致） */
export function OutcomeIcon({ tone }: { readonly tone: 'ok' | 'warn' | 'error' }) {
  return tone === 'ok' ? (
    <CheckCircleIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
  ) : (
    <WarningIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
  );
}
