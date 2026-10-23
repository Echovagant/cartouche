'use client';

/**
 * 出图工具条。
 *
 * 四个互斥的工具：查看 / 画笔 / 框选 / 调色。
 * 视觉沿用 Toolbar.tsx（同一排按钮、同样的描边与高亮），
 * 所以工具条和导出/报告那排看上去是一套东西，而不是又一套设计。
 *
 * 工具条同时承担"参数面板"的职责：颜色、笔宽、框选后的动作、亮度对比度
 * 都放在这里——它们都是"下一步要发出去的那条操作"的参数，
 * 散到别处会让用户不知道改了什么就会改文件。
 */

import {
  CursorClickIcon,
  EraserIcon,
  PaintBrushIcon,
  PaintBucketIcon,
  SelectionIcon,
  SlidersIcon,
} from '@phosphor-icons/react';
import type { EditTool, LevelsParams } from './types';
import { isToolDisabled, type ToolBlockedReasons } from './editAvailability';
import { ActionButton } from './ui';

export interface EditToolbarProps {
  readonly tool: EditTool;
  readonly onToolChange: (tool: EditTool) => void;
  /**
   * 每个工具各自的不可用原因（null = 可用）。
   *
   * 按工具分开，是因为四个工具的限制**不一样**：
   * 画笔/框选要把屏幕坐标换算成栅格的原生像元（换算由引擎做，
   * 投影坐标系的底图照样能画，只有压根没有坐标系才不行），
   * 调色不需要（引擎侧整幅逐像元算），查看永远可用。
   */
  readonly blockedByTool: ToolBlockedReasons;
  /** 涂色颜色 */
  readonly color: string;
  readonly onColorChange: (color: string) => void;
  /** 笔宽（屏幕像素） */
  readonly brushWidth: number;
  readonly onBrushWidthChange: (width: number) => void;
  /** 框选是否已经画出来 */
  readonly hasBox: boolean;
  /** 框选之后选「涂色」还是「擦除」 */
  readonly onBoxAction: (kind: 'paint' | 'erase') => void;
  readonly levels: LevelsParams;
  readonly onLevelsChange: (levels: LevelsParams) => void;
  /** 调色：按当前参数预演一次 */
  readonly onPreviewLevels: () => void;
  /** 正在预演 / 执行：按钮置灰，防重复提交 */
  readonly busy: boolean;
}

interface ToolSpec {
  readonly id: EditTool;
  readonly label: string;
  readonly title: string;
  readonly Icon: typeof CursorClickIcon;
}

const TOOLS: readonly ToolSpec[] = [
  { id: 'view', label: '查看', title: '拖动、缩放、选中要素（默认）', Icon: CursorClickIcon },
  { id: 'brush', label: '画笔', title: '按住拖动画一笔', Icon: PaintBrushIcon },
  { id: 'box', label: '框选', title: '拖出一个矩形', Icon: SelectionIcon },
  { id: 'levels', label: '调色', title: '调整亮度与对比度', Icon: SlidersIcon },
];

/** 笔宽三档（屏幕像素） */
const BRUSH_WIDTHS: readonly { readonly px: number; readonly label: string }[] = [
  { px: 3, label: '小' },
  { px: 6, label: '中' },
  { px: 12, label: '大' },
];

const METHOD_LABEL: Record<LevelsParams['method'], string> = {
  'linear-stretch': '线性拉伸',
  gamma: 'Gamma',
  manual: '手动',
};

export default function EditToolbar({
  tool,
  onToolChange,
  blockedByTool,
  color,
  onColorChange,
  brushWidth,
  onBrushWidthChange,
  hasBox,
  onBoxAction,
  levels,
  onLevelsChange,
  onPreviewLevels,
  busy,
}: EditToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-studio-line bg-studio-2/40 px-4 py-2">
      {TOOLS.map(({ id, label, title, Icon }) => {
        const active = tool === id;
        // 每个工具按**自己**的原因置灰：
        // 以前这里看的是一个全局字符串，栅格不是 4326 时连「调色」都被一起禁用了
        const reason = blockedByTool[id];
        const disabled = isToolDisabled(blockedByTool, id, tool);
        return (
          <ActionButton
            key={id}
            variant={active ? 'primary' : 'ghost'}
            onClick={() => onToolChange(id)}
            disabled={disabled}
            title={disabled ? (reason ?? '') : title}
            className="!px-2.5 !py-1.5"
          >
            <Icon size={15} weight="bold" />
            {label}
          </ActionButton>
        );
      })}

      {tool === 'brush' ? (
        <>
          <span className="h-4 w-px bg-studio-line" />
          <label className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            颜色
            <input
              type="color"
              value={color}
              onChange={(event) => onColorChange(event.target.value)}
              className="h-6 w-9 cursor-pointer rounded border border-studio-line bg-studio-3 p-0.5"
            />
          </label>
          <span className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            笔宽
            {BRUSH_WIDTHS.map((item) => (
              <ActionButton
                key={item.px}
                variant={brushWidth === item.px ? 'primary' : 'quiet'}
                onClick={() => onBrushWidthChange(item.px)}
                className="!px-2 !py-0.5 text-[11px]"
              >
                {item.label}
              </ActionButton>
            ))}
          </span>
          <span className="text-[11.5px] text-studio-ink-3">在地图上按住拖动画一笔</span>
        </>
      ) : null}

      {tool === 'box' ? (
        <>
          <span className="h-4 w-px bg-studio-line" />
          <label className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            颜色
            <input
              type="color"
              value={color}
              onChange={(event) => onColorChange(event.target.value)}
              className="h-6 w-9 cursor-pointer rounded border border-studio-line bg-studio-3 p-0.5"
            />
          </label>
          <ActionButton
            variant="ghost"
            onClick={() => onBoxAction('paint')}
            disabled={!hasBox || busy}
            title={hasBox ? '把框选区域涂成当前颜色' : '先在地图上拖出一个矩形'}
            className="!px-2.5 !py-1"
          >
            <PaintBucketIcon size={14} weight="bold" />
            涂色
          </ActionButton>
          <ActionButton
            variant="ghost"
            onClick={() => onBoxAction('erase')}
            disabled={!hasBox || busy}
            title={hasBox ? '擦掉框选区域' : '先在地图上拖出一个矩形'}
            className="!px-2.5 !py-1"
          >
            <EraserIcon size={14} weight="bold" />
            擦除
          </ActionButton>
          <span className="text-[11.5px] text-studio-ink-3">
            {hasBox ? '选区已就绪，选「涂色」或「擦除」' : '在地图上拖出一个矩形'}
          </span>
        </>
      ) : null}

      {tool === 'levels' ? (
        <>
          <span className="h-4 w-px bg-studio-line" />
          <label className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            方法
            <select
              value={levels.method}
              onChange={(event) =>
                onLevelsChange({
                  ...levels,
                  method: event.target.value as LevelsParams['method'],
                })
              }
              className="rounded-lg border border-studio-line bg-studio/70 px-2 py-1 text-[12px] text-studio-ink"
            >
              {Object.entries(METHOD_LABEL).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            亮度
            <input
              type="range"
              min={-1}
              max={1}
              step={0.05}
              value={levels.brightness}
              onChange={(event) =>
                onLevelsChange({ ...levels, brightness: Number(event.target.value) })
              }
              className="h-1 w-24 accent-[#2f6f5e]"
            />
            <span className="tnum w-10 text-right font-mono text-[10.5px] text-studio-ink-3">
              {levels.brightness.toFixed(2)}
            </span>
          </label>
          <label className="flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
            对比度
            <input
              type="range"
              min={0}
              max={4}
              step={0.05}
              value={levels.contrast}
              onChange={(event) =>
                onLevelsChange({ ...levels, contrast: Number(event.target.value) })
              }
              className="h-1 w-24 accent-[#2f6f5e]"
            />
            <span className="tnum w-10 text-right font-mono text-[10.5px] text-studio-ink-3">
              {levels.contrast.toFixed(2)}
            </span>
          </label>
          <ActionButton variant="ghost" onClick={onPreviewLevels} disabled={busy} className="!px-2.5 !py-1">
            预览效果
          </ActionButton>
        </>
      ) : null}

      {blockedByTool[tool] ? (
        <span className="ml-auto text-[11.5px] text-warn">{blockedByTool[tool]}</span>
      ) : (
        <span className="ml-auto text-[11.5px] text-studio-ink-3">改动会先经过确认卡，不会直接落盘</span>
      )}
    </div>
  );
}
