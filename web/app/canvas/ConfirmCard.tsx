'use client';

/**
 * 确认卡：四道闸门。
 *
 * 这张卡是"改动会不会落到文件上"的最后一道关卡，所以它必须把
 * **影响面、目标文件、备份文件、操作类型**四件事一次说清楚：
 *
 *   ① 将影响多少像元（占全图多少）
 *   ② 改的是哪个文件（相对项目根的路径）
 *   ③ 会生成哪个备份（改错了还能退回去）
 *   ④ 这是什么操作（涂色 / 擦除 / 亮度对比度调整）
 *
 * 影响面超过一半时要多点一次：这种改动一旦落盘，视觉上基本等于重画，
 * 用户多半不是这个意思——但也不能替他取消，所以改成二次确认。
 *
 * 预演失败时**不给执行按钮**：影响面都算不出来，就没资格让人确认。
 */

import { useEffect, useState } from 'react';
import { CheckCircleIcon, WarningIcon } from '@phosphor-icons/react';
import type { EditOp, OpPreview } from './types';
import { ActionButton } from './ui';
import { ConfirmCardBody, formatPixelGate } from '../motion/ConfirmCardBody';

/** 执行结束后的结果 */
export interface ExecOutcome {
  /** ok = 成功；warn = 操作成功但有后续问题（如导出失败）；error = 操作失败 */
  readonly tone: 'ok' | 'warn' | 'error';
  readonly message: string;
}

export interface ConfirmCardProps {
  /** 即将执行的操作 */
  readonly op: EditOp;
  /** 预演结果（null = 还在预演或预演失败） */
  readonly preview: OpPreview | null;
  readonly previewing: boolean;
  /** 预演失败时的中文提示 */
  readonly previewError: string | null;
  readonly executing: boolean;
  readonly outcome: ExecOutcome | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/** 影响面超过这个比例就要二次确认 */
const LARGE_IMPACT_RATIO = 0.5;

export default function ConfirmCard({
  op,
  preview,
  previewing,
  previewError,
  executing,
  outcome,
  onConfirm,
  onCancel,
}: ConfirmCardProps) {
  // 二次确认的"上膛"状态：第一次点只是把按钮换成更郑重的说法
  const [armed, setArmed] = useState(false);

  // 换一条操作就重新上膛：上一条的风险提示不能顺延到下一条
  useEffect(() => {
    setArmed(false);
  }, [op, preview]);

  const ratio =
    preview && preview.totalPixels > 0
      ? preview.affectedRatio > 0
        ? preview.affectedRatio
        : preview.affectedPixels / preview.totalPixels
      : 0;
  const largeImpact = ratio > LARGE_IMPACT_RATIO;

  const handleConfirm = (): void => {
    if (largeImpact && !armed) {
      setArmed(true);
      return;
    }
    onConfirm();
  };

  const opTarget = op.params.target;
  /**
   * 备份怎么写。
   *
   * 预演阶段还没有真的备份，但**备份叫什么名字是定死的**
   * （`<原名>.bak.<时间戳>`），所以提前说清楚，用户改完知道去哪儿找原件。
   * 引擎给了完整路径就用路径，没给路径但给了命名样式就用样式。
   */
  const backupText = preview?.backupPath
    ? preview.backupPath
    : preview?.backupNamePattern
      ? `${preview.backupNamePattern}（与原文件同目录）`
      : '（引擎执行时自动生成备份）';
  const gates = [
    {
      label: '将影响的像元',
      value: preview
        ? formatPixelGate(preview.affectedPixels, preview.totalPixels, ratio)
        : '正在计算…',
    },
    {
      label: '目标文件',
      value: preview?.target || (typeof opTarget === 'string' ? opTarget : '（未指定）'),
    },
    {
      label: '将生成的备份',
      value: backupText,
    },
    {
      label: '操作类型',
      value: op.label,
    },
  ];

  const canExecute = preview !== null && previewError === null && !executing && !outcome;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-studio/78 p-6 backdrop-blur-sm">
      <ConfirmCardBody
        variant="studio"
        title="确认这次改动"
        opLabel={op.op}
        gates={gates}
        headerAction={
          outcome ? null : (
            <ActionButton variant="quiet" onClick={onCancel} className="!px-2 !py-1 text-[11.5px]">
              取消
            </ActionButton>
          )
        }
      >
        {previewError ? (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <strong>预演失败：</strong>
            {previewError}
            <div className="mt-1 text-studio-ink-3">影响面算不出来，这次先不执行。</div>
          </div>
        ) : null}

        {largeImpact && previewError === null && !outcome ? (
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

        {outcome ? (
          <div
            className={`mt-3 flex items-start gap-2 rounded-lg border px-3 py-2.5 text-[12.5px] leading-relaxed ${
              outcome.tone === 'ok'
                ? 'border-accent/40 bg-accent/12 text-accent'
                : 'border-warn/40 bg-warn/12 text-warn'
            }`}
          >
            {outcome.tone === 'ok' ? (
              <CheckCircleIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
            ) : (
              <WarningIcon size={16} weight="bold" className="mt-0.5 shrink-0" />
            )}
            <span>{outcome.message}</span>
          </div>
        ) : null}

        <div className="mt-4 flex items-center justify-end gap-2">
          {outcome ? (
            <ActionButton variant="ghost" onClick={onCancel}>
              关闭
            </ActionButton>
          ) : (
            <>
              <ActionButton variant="quiet" onClick={onCancel} disabled={executing}>
                取消
              </ActionButton>
              {previewError ? null : (
                <ActionButton
                  variant="primary"
                  onClick={handleConfirm}
                  disabled={!canExecute}
                  title={canExecute ? '执行这次改动' : '正在预演…'}
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
            </>
          )}
        </div>
      </ConfirmCardBody>
    </div>
  );
}
