'use client';

/**
 * 图层管理面板。
 *
 * 两块内容：
 *   - 工作区文件：从引擎列目录得到的文件，点一下就能作为图层加进地图；
 *   - 已加载图层：显隐、透明度、叠放次序、移除。
 *
 * 透明度与次序是**作用在地图上的**，但状态放在上层（工作台），
 * 面板只负责发意图——这样导出的 PDF 与界面上看到的始终是同一套图层状态。
 */
import {
  ArrowDownIcon,
  ArrowUpIcon,
  FolderOpenIcon,
  TrashIcon,
} from '@phosphor-icons/react';
import { guessEntryKind, type EntryKind, type LayerKind, type MapLayer } from './types';
import { ActionButton, EmptyHint, SectionLabel } from './ui';

export interface LayerPanelProps {
  /** 已加载图层（数组末尾在最上） */
  layers: readonly MapLayer[];
  /** 当前目录下的文件条目 */
  files: readonly string[];
  /** 当前目录（工作区内的相对路径，空串表示根） */
  dir: string;
  filesLoading: boolean;
  activeLayerId: string | null;
  onAddLayer: (name: string, kind: LayerKind) => void;
  onRemoveLayer: (id: string) => void;
  onToggleVisibility: (id: string) => void;
  onOpacityChange: (id: string, opacity: number) => void;
  onMoveLayer: (id: string, direction: -1 | 1) => void;
  onSelectLayer: (id: string) => void;
  /** 点目录条目时请求进入该目录 */
  onEnterDirectory: (name: string) => void;
  /** 返回上一级 */
  onGoUp: () => void;
}

const KIND_LABEL: Record<LayerKind, string> = {
  raster: '栅格',
  vector: '矢量',
};

const KIND_COLOR: Record<LayerKind, string> = {
  raster: 'bg-amber',
  vector: 'bg-accent',
};

/** 四类条目在列表里的标记色 */
const ENTRY_COLOR: Record<EntryKind, string> = {
  raster: 'bg-amber',
  vector: 'bg-accent',
  sidecar: 'bg-studio-line',
  other: 'bg-studio-line',
};

export default function LayerPanel({
  layers,
  files,
  dir,
  filesLoading,
  activeLayerId,
  onAddLayer,
  onRemoveLayer,
  onToggleVisibility,
  onOpacityChange,
  onMoveLayer,
  onSelectLayer,
  onEnterDirectory,
  onGoUp,
}: LayerPanelProps) {
  const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';

  return (
    <div className="flex flex-col gap-6">
      <section>
        <SectionLabel
          right={
            <span className="font-mono text-[11px] text-studio-ink-3">
              {filesLoading ? '读取中' : `${files.length} 项`}
            </span>
          }
        >
          工作区文件
        </SectionLabel>

        <div className="mb-2 flex items-center gap-1.5 font-mono text-[11.5px] text-studio-ink-3">
          <span className="truncate" title={dir || '/'}>
            /{dir || ''}
          </span>
          {dir ? (
            <ActionButton
              variant="quiet"
              onClick={onGoUp}
              className="!px-1.5 !py-0.5 text-[11px]"
              title={`返回 ${parent || '根目录'}`}
            >
              上一级
            </ActionButton>
          ) : null}
        </div>

        <ul className="overflow-hidden rounded-lg border border-studio-line">
          {files.length === 0 ? (
            <li className="bg-studio/40 px-3 py-4 text-[12px] text-studio-ink-3">
              {filesLoading ? '正在读取…' : '这个目录是空的。'}
            </li>
          ) : (
            files.map((name) => {
              const entry = guessEntryKind(name);
              const isDir = entry === 'other';
              const isSidecar = entry === 'sidecar';
              return (
                <li
                  key={name}
                  className="flex items-center gap-2 border-t border-studio-line px-2.5 py-1.5 transition-colors first:border-t-0 hover:bg-studio-3/40"
                >
                  <span
                    aria-hidden="true"
                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${ENTRY_COLOR[entry]}`}
                  />
                  <span
                    title={name}
                    className={`min-w-0 flex-1 truncate text-[12.5px] ${
                      isSidecar ? 'text-studio-ink-3' : 'text-studio-ink-2'
                    }`}
                  >
                    {name}
                  </span>
                  {isSidecar ? (
                    // 附属文件（.dbf/.prj/.tfw…）依附于某个数据集，不能单独加载，
                    // 也不该被当成目录——以前它们显示"进入"，点下去必然报错。
                    <span className="shrink-0 font-mono text-[10.5px] text-studio-ink-3">附属</span>
                  ) : isDir ? (
                    <ActionButton
                      variant="quiet"
                      onClick={() => onEnterDirectory(name)}
                      className="!px-1.5 !py-0.5 text-[11px]"
                    >
                      <FolderOpenIcon size={12} weight="bold" />
                      进入
                    </ActionButton>
                  ) : (
                    <ActionButton
                      variant="quiet"
                      onClick={() => onAddLayer(name, entry as LayerKind)}
                      className="!px-2 !py-0.5 text-[11.5px] hover:!text-accent"
                    >
                      加载
                    </ActionButton>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </section>

      <section>
        <SectionLabel
          right={
            <span className="font-mono text-[11px] text-studio-ink-3">{layers.length}</span>
          }
        >
          已加载图层
        </SectionLabel>

        {layers.length === 0 ? (
          <EmptyHint>
            还没有图层。从上面选一个文件加载进来，地图会自动移到它的范围。
          </EmptyHint>
        ) : (
          <ul className="flex flex-col gap-2">
            {layers.map((layer, index) => {
              const active = layer.id === activeLayerId;
              return (
                <li
                  key={layer.id}
                  onClick={() => onSelectLayer(layer.id)}
                  className={`rounded-lg border px-3 py-2.5 transition-colors ${
                    active
                      ? 'border-accent bg-accent/12'
                      : 'border-studio-line bg-studio-3/45 hover:border-studio-ink-3'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={layer.visible}
                      onClick={(event) => event.stopPropagation()}
                      onChange={() => onToggleVisibility(layer.id)}
                      title="显示 / 隐藏"
                      className="h-3.5 w-3.5 shrink-0 accent-[#2f6f5e]"
                    />
                    <span
                      title={layer.path}
                      className="min-w-0 flex-1 truncate text-[12.5px] text-studio-ink"
                    >
                      {layer.name}
                    </span>
                    <span
                      className={`flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[10.5px] text-paper ${
                        KIND_COLOR[layer.kind]
                      }`}
                    >
                      {KIND_LABEL[layer.kind]}
                    </span>
                  </div>

                  <div className="mt-2 flex items-center gap-2">
                    <span className="font-mono text-[10.5px] text-studio-ink-3">透明度</span>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={Math.round(layer.opacity * 100)}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) =>
                        onOpacityChange(layer.id, Number(event.target.value) / 100)
                      }
                      className="h-1 flex-1 accent-[#2f6f5e]"
                    />
                    <span className="tnum w-8 text-right font-mono text-[10.5px] text-studio-ink-3">
                      {Math.round(layer.opacity * 100)}%
                    </span>
                  </div>

                  <div
                    className="mt-2 flex justify-end gap-1"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <ActionButton
                      variant="quiet"
                      onClick={() => onMoveLayer(layer.id, 1)}
                      disabled={index === layers.length - 1}
                      className="!px-1.5 !py-0.5 text-[11px]"
                      title="上移一层"
                    >
                      <ArrowUpIcon size={12} weight="bold" />
                    </ActionButton>
                    <ActionButton
                      variant="quiet"
                      onClick={() => onMoveLayer(layer.id, -1)}
                      disabled={index === 0}
                      className="!px-1.5 !py-0.5 text-[11px]"
                      title="下移一层"
                    >
                      <ArrowDownIcon size={12} weight="bold" />
                    </ActionButton>
                    <ActionButton
                      variant="danger"
                      onClick={() => onRemoveLayer(layer.id)}
                      className="!px-1.5 !py-0.5 text-[11px]"
                      title="移除图层"
                    >
                      <TrashIcon size={12} weight="bold" />
                    </ActionButton>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
