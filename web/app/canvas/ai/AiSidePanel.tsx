'use client';

/**
 * 画布内的 AI 面板（右侧，VS Code 的 Copilot 位）。
 *
 * 为什么搬进画布（2026-11-15 用户裁定）：AI 问答的**结果**要落在图上——
 * 计划→确认→地图当场刷新，用户看到图真的变了才会信这个功能有用。
 * 接入配置（接入线/密钥/模型/试一句）也全部内联——ai.html 不再需要。
 *
 * 计费方式说明（2026-11-15 按官网核对，写在各接入线的 note 里）：
 * 同一厂商的「订阅 key」与「按量 API key」是两把不同的 key，
 * 用户粘哪把就按哪把计费——引擎不区分，都走 Bearer token 发到对应端点。
 */
import { useEffect, useState } from 'react';
import {
  CheckCircleIcon,
  DownloadSimpleIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
  XIcon,
  EyeIcon,
  KeyIcon,
} from '@phosphor-icons/react';
import { ActionButton, TextField } from '../ui';
import ConfirmCard from '../ConfirmCard';
import PlanGate, { type PlanGatePreview } from '../../ai/PlanGate';
import ValueTable from '../../ai/ValueTable';
import { opLabel } from '../../ai/opLabels';
import {
  describeExecuteFailure,
  describePlanFailure,
  describePreviewFailure,
  describeZeroImpact,
  findZeroImpactOps,
  type HumanFailure,
} from '../../ai/failures';
import { useLlm, type PlanPayload } from '../../ai/useLlm';
import { ENGINE_BASE } from '../../engine-base';
import { engineFetch } from '../../engine-auth';

/** 引擎执行操作的返回体（逐条结果） */
interface ExecResultPayload {
  readonly ok: boolean;
  readonly results: readonly {
    readonly index: number;
    readonly op: string;
    readonly ok: boolean;
    readonly target?: string;
    readonly unimplemented?: boolean;
    readonly value?: { readonly summary?: string; readonly data?: unknown };
    readonly error?: string;
  }[];
  readonly completed: number;
  readonly failedAt?: number;
  readonly warning?: string;
}

/** 计划里某条操作的影响对象（展示用） */
function targetText(params: Record<string, unknown>): string {
  const raw = params['target'];
  if (typeof raw !== 'string' || raw.trim() === '') return '（未指定）';
  return raw.replace(/^(?:dataset|layer|summary):\/\//, '');
}

export interface AiSidePanelProps {
  readonly projectRoot: string | null;
  readonly activeLayerName: string | null;
  /** 用户明确选中的图层 id；「这一层」靠它落到具体文件 */
  readonly activeLayerId?: string | null;
  readonly onClose: () => void;
  readonly onExecuted: () => void;
}

/**
 * 画布右侧的 AI 面板：接入配置 + 一句话提议 + 确认后执行。
 *
 * 为什么它长在画布里而不是单独一个页面：AI 的价值在**结果落到图上** ——
 * 计划 → 确认 → 地图当场刷新这条链一断，用户就不信这东西有用。
 */
export function AiSidePanel({
  projectRoot,
  activeLayerName,
  activeLayerId,
  onClose,
  onExecuted,
}: AiSidePanelProps) {
  const llm = useLlm();
  const configured = llm.status?.configured ?? false;
  const effortLevels = llm.status?.effortLevels ?? [];
  const provider = llm.status?.provider ?? '';
  const activeNote = llm.status?.providers.find((p) => p.id === provider)?.note ?? '';

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('max');
  const [instruction, setInstruction] = useState('');
  const [proposal, setProposal] = useState<PlanPayload | null>(null);
  const [previews, setPreviews] = useState<PlanGatePreview[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewFailure, setPreviewFailure] = useState<HumanFailure | null>(null);
  const [blocker, setBlocker] = useState<HumanFailure | null>(null);
  const [executing, setExecuting] = useState(false);
  const [execFailure, setExecFailure] = useState<HumanFailure | null>(null);
  const [execResult, setExecResult] = useState<ExecResultPayload | null>(null);
  const [gateOpen, setGateOpen] = useState(false);
  const [panelError, setPanelError] = useState<string | null>(null);
  /**
   * 复杂任务的分步队列。
   *
   * 模型先只给步骤清单（不改文件），用户按顺序一步一确认；
   * 每一步都当作一次新的提议请求发回去，模型一次只想一件事。
   */
  const [stepPlan, setStepPlan] = useState<{
    readonly intent: string;
    readonly goals: readonly string[];
    readonly index: number;
  } | null>(null);

  useEffect(() => {
    const models = llm.models?.models ?? llm.status?.models ?? [];
    if (models.length === 0) return;
    setModel((prev) => (prev && models.includes(prev) ? prev : (models[0] ?? '')));
  }, [llm.models, llm.status]);

  useEffect(() => {
    const levels = llm.status?.effortLevels ?? [];
    if (levels.length > 0 && !levels.includes(effort)) setEffort(levels[0] ?? 'max');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [llm.status?.provider]);

  const submitKey = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key) return;
    const res = await llm.setKey(key, llm.status?.provider);
    setApiKey('');
    if (res.ok) void llm.pullModels();
  };

  /** 「记住这台电脑」：写入本机 DPAPI 密文，同时立即使会话生效（免二次粘贴） */
  const rememberKey = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key || llm.isBusy('key')) return;
    try {
      const res = await engineFetch(`${ENGINE_BASE}/api/llm/persist-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: llm.status?.provider, apiKey: key }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      await llm.setKey(key, llm.status?.provider);
      setApiKey('');
      void llm.pullModels();
    } catch (err) {
      setApiKey('');
      setPanelError(`没能记住密钥：${(err as Error).message}（key 仍在输入框，可改用「仅本次会话使用」）`);
    }
  };

  /** 清除：会话密钥必清；这台电脑上有记住的密文就一并删 */
  const forgetKey = async (): Promise<void> => {
    const provider = llm.status?.provider;
    if (provider) await llm.clearKey(provider);
    try {
      await engineFetch(`${ENGINE_BASE}/api/llm/persist-key`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: provider }),
      });
    } catch {
      /* 删除失败不打断：会话密钥已经清了 */
    }
    void llm.refreshStatus();
  };

  const runPreviews = async (
    ops: readonly { op: string; params: Record<string, unknown> }[],
  ): Promise<PlanGatePreview[]> => {
    setPreviewing(true);
    setPreviewFailure(null);
    setPreviews([]);
    const list: PlanGatePreview[] = [];
    for (const [index, op] of ops.entries()) {
      try {
        const res = await engineFetch(`${ENGINE_BASE}/api/op/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: op.op,
            params: op.params,
            ...(projectRoot ? { root: projectRoot } : {}),
          }),
        });
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } & Partial<PlanGatePreview>;
        if (!res.ok) {
          setPreviewFailure(
            describePreviewFailure({
              op: op.op,
              index,
              message: body?.message ?? `预演失败（HTTP ${res.status}）`,
            }),
          );
          break;
        }
        list.push(body as PlanGatePreview);
        setPreviews([...list]);
      } catch (err) {
        setPreviewFailure(
          describePreviewFailure({
            op: op.op,
            index,
            message: `无法连接引擎服务 ${ENGINE_BASE}：${(err as Error).message}`,
          }),
        );
        break;
      }
    }
    setPreviews(list);
    setPreviewing(false);
    return list;
  };

  const sendPlan = async (stepOnly = false, textOverride?: string): Promise<void> => {
    const text = (textOverride ?? instruction).trim();
    if (!text || !configured) return;
    // 用户重新写一句话就是要换任务：旧的分步队列不再沿用
    if (!stepOnly) setStepPlan(null);
    setProposal(null);
    setPreviews([]);
    setPreviewFailure(null);
    setExecResult(null);
    setGateOpen(false);
    setBlocker(null);
    setExecFailure(null);
    setPanelError(null);
    const res = await llm.requestPlan({
      prompt: text,
      model,
      effort,
      root: projectRoot,
      ...(activeLayerId ? { activeLayerId } : {}),
      ...(stepOnly ? { stepOnly: true } : {}),
    });
    if (!res) return;
    setProposal(res);
    if (!res.ok) return;
    // 复杂任务：先把步骤摆给用户看，不急着出计划
    if (res.steps.length > 0) {
      setStepPlan({ intent: text, goals: res.steps, index: 0 });
      return;
    }
    const ops = res.plan?.ops ?? [];
    const previewed = await runPreviews(ops);
    if (previewed.length !== ops.length) return;
    const zero = findZeroImpactOps(previewed);
    if (zero.length > 0) {
      const first = zero[0]!;
      setBlocker(
        describeZeroImpact({
          op: previewed[first]?.op,
          index: first,
          totalPixels: previewed[first]?.totalPixels ?? 0,
        }),
      );
      return;
    }
    setGateOpen(true);
  };

  /** 把分步队列里的一步当成一次独立的提议请求 */
  const runStep = async (index: number): Promise<void> => {
    if (!stepPlan) return;
    const goal = stepPlan.goals[index];
    if (!goal) return;
    // 模型给的步骤常自带句号，拼接时去掉一个，别出现「。。」
    const goalText = goal.replace(/[。；;，,\s]+$/, '');
    const text = `第 ${index + 1} 步（共 ${stepPlan.goals.length} 步）：${goalText}。总目标：${stepPlan.intent}`;
    setInstruction(text);
    await sendPlan(true, text);
  };

  const confirmExecute = async (): Promise<void> => {
    const doc = proposal?.plan;
    if (!doc) return;
    setExecuting(true);
    try {
      const res = await engineFetch(`${ENGINE_BASE}/api/op/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          plan: {
            version: doc.version,
            ...(doc.intent ? { intent: doc.intent } : {}),
            ops: doc.ops.map((op) => ({
              op: op.op,
              params: op.params,
              ...(op.preconditions ? { preconditions: op.preconditions } : {}),
              ...(op.expect ? { expect: op.expect } : {}),
              ...(op.requireUserConfirm !== undefined
                ? { requireUserConfirm: op.requireUserConfirm }
                : {}),
            })),
          },
          confirmed: true,
          ...(projectRoot ? { root: projectRoot, projectRoot } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as ExecResultPayload | null;
      if (!res.ok || !body) {
        setExecFailure(describeExecuteFailure({ message: `执行失败（HTTP ${res.status}）` }));
        setGateOpen(false);
        return;
      }
      setExecFailure(null);
      setExecResult(body);
      setGateOpen(false);
      if (body.completed > 0) {
        onExecuted();
        // 已经有操作落盘：旧计划的「文件还没动」不再成立，撤掉它，
        // 只留执行结果（哪条成功、哪条失败）。分步队列是独立状态，不受影响。
        setProposal(null);
        setPreviews([]);
      }
      // 分步任务：这一步全部成功才推进队列；部分失败时停在原地，
      // 让用户看清哪条没成，而不是悄悄跳到下一步。
      if (body.ok && stepPlan) {
        setStepPlan(
          stepPlan.index + 1 >= stepPlan.goals.length
            ? null
            : { ...stepPlan, index: stepPlan.index + 1 },
        );
      }
    } catch (err) {
      setExecFailure(
        describeExecuteFailure({
          message: `无法连接引擎服务 ${ENGINE_BASE}：${(err as Error).message}`,
        }),
      );
      setGateOpen(false);
    } finally {
      setExecuting(false);
    }
  };

  const cancelPlan = (): void => {
    setGateOpen(false);
    setPreviews([]);
    setPreviewFailure(null);
    setBlocker(null);
  };

  return (
    <div className="flex h-full flex-col border-l border-studio-line bg-studio-2/70">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-studio-line px-3">
        <strong className="text-[12.5px] font-medium text-studio-ink">AI 改图</strong>
        <span className="text-[11px] text-studio-ink-3">
          {configured ? (llm.status?.model ?? '') : '未配置密钥'}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          aria-label="收起 AI 面板"
          className="flex w-7 items-center justify-center text-studio-ink-3 transition-colors hover:text-studio-ink"
        >
          <XIcon size={13} aria-hidden="true" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {/* ── 接入配置 ── */}
        <div className="rounded-lg border border-studio-line bg-studio-3/50 p-3">
          <div className="flex items-center gap-1.5 text-[12px] font-medium text-studio-ink">
            <PlugsConnectedIcon size={13} aria-hidden="true" />
            接入
          </div>
          <label className="mt-2 block text-[11.5px] text-studio-ink-3" htmlFor="panel-provider">
            接入线
          </label>
          <select
            id="panel-provider"
            value={provider}
            onChange={(e) => void llm.selectProvider(e.target.value)}
            className="mt-1 w-full rounded-lg border border-studio-line bg-studio/70 px-2 py-1.5 text-[12px] text-studio-ink focus:border-accent focus:outline-none"
          >
            {(llm.status?.providers ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.displayName}
                {p.configured ? ' ✓' : ''}
              </option>
            ))}
          </select>
          {activeNote ? (
            <p className="mt-1.5 text-[11px] leading-relaxed text-studio-ink-3">{activeNote}</p>
          ) : null}
          <div className="mt-2 flex gap-1.5">
            <TextField
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitKey();
              }}
              placeholder="粘贴 API Key"
              className="min-w-0 flex-1"
              autoComplete="off"
              spellCheck={false}
            />
            <ActionButton
              variant="primary"
              onClick={() => void submitKey()}
              disabled={!apiKey.trim() || llm.isBusy('key')}
            >
              {llm.isBusy('key') ? <SpinnerGapIcon size={13} className="animate-spin" /> : null}
              仅本次会话使用
            </ActionButton>
            {/* 「记住这台电脑」：key 以 DPAPI 密文存本机（引擎写，前端只见状态），重启不用重填 */}
            <ActionButton
              onClick={() => void rememberKey()}
              disabled={!apiKey.trim() || llm.isBusy('key')}
              title="以 DPAPI 密文存本机（%LOCALAPPDATA%\cartouche\keys），重启后不用重填"
            >
              记住这台电脑
            </ActionButton>
            {configured ? (
              <ActionButton onClick={() => void forgetKey()} disabled={llm.isBusy('key')}>
                清除
              </ActionButton>
            ) : null}
          </div>
          <p className="mt-1 text-[11px] text-studio-ink-3">
            只进引擎内存，不落盘不回显。同一厂商的订阅 key 与按量 key 是两把不同的 key——粘哪把就按哪把计费。
          </p>
        </div>

        {/* ── 模型 ── */}
        {configured ? (
          <div className="mt-3 rounded-lg border border-studio-line bg-studio-3/50 p-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-studio-ink">
              <KeyIcon size={13} aria-hidden="true" />
              模型
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={(llm.models?.models ?? llm.status?.models ?? []).length === 0}
                className="max-w-[200px] rounded-lg border border-studio-line bg-studio/70 px-2 py-1 text-[12px] text-studio-ink focus:border-accent focus:outline-none"
              >
                {(llm.models?.models ?? llm.status?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <ActionButton onClick={() => void llm.pullModels(provider)} disabled={llm.isBusy('models')}>
                {llm.isBusy('models') ? (
                  <SpinnerGapIcon size={13} className="animate-spin" />
                ) : (
                  <DownloadSimpleIcon size={13} />
                )}
                刷新
              </ActionButton>
              {effortLevels.length > 0 ? (
                <select
                  value={effort}
                  onChange={(e) => setEffort(e.target.value)}
                  className="rounded-lg border border-studio-line bg-studio/70 px-2 py-1 text-[12px] text-studio-ink focus:border-accent focus:outline-none"
                >
                  {effortLevels.map((lv) => (
                    <option key={lv} value={lv}>
                      思考 {lv}
                    </option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* ── 试一句 ── */}
        {configured ? (
          <details className="mt-3 rounded-lg border border-studio-line bg-studio-3/50 px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-studio-ink-2">
              试一句（连通性测试）
            </summary>
            <textarea
              rows={2}
              className="mt-2 w-full resize-y rounded-lg border border-studio-line bg-studio/70 px-2 py-1.5 text-[12px] text-studio-ink focus:border-accent focus:outline-none"
              placeholder="发一句话过去看模型怎么回"
              defaultValue="用一句话说：这张图适合用来做什么？"
              id="panel-test-prompt"
            />
            <ActionButton
              onClick={() => {
                const el = document.getElementById('panel-test-prompt') as HTMLTextAreaElement | null;
                void llm.testConnection({ prompt: el?.value ?? '你好', model, effort });
              }}
              disabled={!configured || llm.isBusy('test')}
              className="mt-2"
            >
              {llm.isBusy('test') ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PaperPlaneTiltIcon size={13} />}
              发一句
            </ActionButton>
            {llm.testResult ? (
              <div className="mt-2 rounded border border-studio-line bg-studio/60 p-2">
                <div className="font-mono text-[10.5px] text-studio-ink-3">
                  {llm.testResult.model} · {llm.testResult.elapsedMs} ms
                </div>
                <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-studio-ink">
                  {llm.testResult.reply}
                </p>
              </div>
            ) : null}
          </details>
        ) : null}

        {/* ── 一句话改图 ── */}
        {configured ? (
          <div className="mt-3">
            <div className="flex items-center gap-1.5 text-[12px] font-medium text-studio-ink">
              <PaperPlaneTiltIcon size={13} aria-hidden="true" />
              用一句话改图
            </div>
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              rows={3}
              className="mt-2 w-full resize-y rounded-lg border border-studio-line bg-studio/70 px-2.5 py-2 text-[12.5px] leading-relaxed text-studio-ink placeholder:text-studio-ink-3 focus:border-accent focus:outline-none"
              placeholder={
                activeLayerName
                  ? `例如：把《${activeLayerName}》右上角那片提亮一点，别动别的`
                  : '例如：把底图右上角那片提亮一点，别动别的'
              }
            />
            <div className="mt-2 flex items-center gap-2">
              <ActionButton
                variant="primary"
                onClick={() => void sendPlan()}
                disabled={llm.planBusy || !instruction.trim()}
              >
                {llm.planBusy ? <SpinnerGapIcon size={13} className="animate-spin" /> : <PaperPlaneTiltIcon size={13} />}
                {llm.planBusy ? '正在出计划…' : '提议改动'}
              </ActionButton>
              <EyeIcon size={13} aria-hidden="true" className="text-studio-ink-3" />
              <span className="text-[11.5px] text-studio-ink-3">发送前可逐字查看</span>
            </div>
          </div>
        ) : null}

        {panelError ? (
          <p className="mt-2 text-[12px] leading-relaxed text-warn">{panelError}</p>
        ) : null}

        {stepPlan ? (
          <div className="mt-3 rounded-lg border border-studio-line bg-studio-3/50 p-3">
            <div className="text-[12px] font-medium text-studio-ink">
              这件事分 {stepPlan.goals.length} 步做
            </div>
            <p className="mt-0.5 text-[11.5px] leading-relaxed text-studio-ink-3">
              一步一确认：上一步落盘、地图刷新之后，再做下一步。
            </p>
            <ol className="mt-2 flex flex-col gap-1">
              {stepPlan.goals.map((goal, index) => {
                const done = index < stepPlan.index;
                const current = index === stepPlan.index;
                return (
                  <li
                    key={`${index}-${goal}`}
                    className={`flex items-start gap-2 rounded px-1.5 py-1 text-[12px] leading-relaxed ${
                      current ? 'bg-accent/12 text-studio-ink' : 'text-studio-ink-2'
                    }`}
                  >
                    <span className="mt-0.5 shrink-0 font-mono text-[11px] text-studio-ink-3">
                      {done ? '✓' : `${index + 1}.`}
                    </span>
                    <span className={done ? 'text-studio-ink-3 line-through' : ''}>{goal}</span>
                  </li>
                );
              })}
            </ol>
            <div className="mt-2 flex items-center gap-2">
              <ActionButton
                variant="primary"
                onClick={() => void runStep(stepPlan.index)}
                disabled={llm.planBusy || executing || gateOpen}
              >
                {llm.planBusy
                  ? '正在出计划…'
                  : stepPlan.index === 0
                    ? '开始第 1 步'
                    : `继续第 ${stepPlan.index + 1} 步`}
              </ActionButton>
              <ActionButton variant="quiet" onClick={() => setStepPlan(null)}>
                不按步骤
              </ActionButton>
            </div>
          </div>
        ) : null}

        {proposal && proposal.schemaIssues.length > 0 ? (
          <div className="mt-3 rounded-lg border border-warn/45 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <strong>计划不合法：</strong>
            <ul className="mt-1 space-y-0.5">
              {proposal.schemaIssues.map((issue, i) => (
                <li key={`${issue.opIndex}-${i}`}>· {issue.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {proposal && proposal.unsupported.length > 0 ? (
          <div className="mt-3 rounded-lg border border-warn/45 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <strong>还没做的操作：</strong>
            <ul className="mt-1 space-y-0.5">
              {proposal.unsupported.map((item) => (
                <li key={`${item.opIndex}-${item.op}`}>· {item.message}</li>
              ))}
            </ul>
          </div>
        ) : null}

        {/* 模型自己说的话：请你补充信息 / 这件事做不了 / 回话不是 JSON。
            没有这一块，用户只会看到"什么都没发生"，不知道下一步该补什么。 */}
        {proposal &&
        !proposal.ok &&
        proposal.message &&
        proposal.schemaIssues.length === 0 &&
        proposal.unsupported.length === 0 ? (
          <div className="mt-3 rounded-lg border border-warn/45 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed">
            <strong className="text-warn">
              {proposal.error === 'plan_needs_clarification' ? '需要你说清楚一点：' : '这次没出计划：'}
            </strong>
            <span className="mt-0.5 block text-studio-ink-2">{proposal.message}</span>
          </div>
        ) : null}

        {proposal?.plan ? (
          <div className="mt-3 rounded-lg border border-studio-line bg-studio/60 p-3">
            <div className="mb-1.5 font-mono text-[11px] text-studio-ink-3">
              计划预览（文件还没动）
              {proposal.elapsedMs !== null ? ` · ${proposal.elapsedMs} ms` : ''}
            </div>
            {proposal.plan.intent ? (
              <p className="mb-1.5 text-[12.5px] leading-relaxed text-studio-ink-2">{proposal.plan.intent}</p>
            ) : null}
            <ol className="flex flex-col gap-1.5">
              {proposal.plan.ops.map((op, index) => (
                <li key={`${op.op}-${index}`} className="rounded border border-studio-line bg-studio/45 px-2 py-1.5">
                  <div className="flex flex-wrap items-center gap-x-2 text-[12px] text-studio-ink">
                    <span className="font-mono text-[11px] text-studio-ink-3">#{index + 1}</span>
                    <strong className="font-medium">{opLabel(op.op)}</strong>
                    <span className="font-mono text-[11px] break-all text-studio-ink-3">{targetText(op.params)}</span>
                  </div>
                  <pre className="mt-1 overflow-x-auto whitespace-pre-wrap rounded bg-studio/70 p-1.5 font-mono text-[10.5px] leading-relaxed text-studio-ink-2">
                    {JSON.stringify(op.params, null, 2)}
                  </pre>
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {previews.length > 0 ? (
          <div className="mt-3 rounded-lg border border-studio-line bg-studio/60 p-3">
            <div className="mb-1.5 font-mono text-[11px] text-studio-ink-3">量化影响</div>
            <ul className="space-y-1.5">
              {previews.map((preview, index) => {
                const total = preview.totalPixels ?? 0;
                const ratio =
                  total > 0
                    ? (preview.affectedRatio ?? 0) > 0
                      ? (preview.affectedRatio ?? 0)
                      : (preview.affectedPixels ?? 0) / total
                    : 0;
                const isValue = preview.kind === 'value';
                return (
                  <li key={`${preview.op}-${index}`} className="text-[12px] text-studio-ink-2">
                    · {preview.op}：
                    {isValue
                      ? (preview.summary ?? '（引擎没有给出结论）')
                      : (
                        <>
                          影响{' '}
                          <span className="font-mono text-studio-ink">
                            {(preview.affectedPixels ?? 0).toLocaleString('zh-CN')}
                          </span>{' '}
                          像元（{(ratio * 100).toFixed(1)}%）
                        </>
                      )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1.5 text-[11.5px] text-studio-ink-3">预演不写盘，落盘要等你确认。</p>
          </div>
        ) : null}

        {previewFailure ? (
          <div className="mt-3 rounded-lg border border-warn/40 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <div className="font-medium">{previewFailure.title}</div>
            <div className="mt-0.5 text-studio-ink-2">{previewFailure.detail}</div>
            <div className="mt-0.5"><span className="text-studio-ink-3">下一步：</span>{previewFailure.next}</div>
          </div>
        ) : null}

        {blocker ? (
          <div className="mt-3 rounded-lg border border-warn/45 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <div className="font-medium">{blocker.title}</div>
            <div className="mt-0.5 text-studio-ink-2">{blocker.detail}</div>
            <div className="mt-0.5"><span className="text-studio-ink-3">下一步：</span>{blocker.next}</div>
          </div>
        ) : null}

        {execFailure ? (
          <div className="mt-3 rounded-lg border border-warn/45 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
            <div className="font-medium">{execFailure.title}</div>
            <div className="mt-0.5 text-studio-ink-2">{execFailure.detail}</div>
            <div className="mt-0.5"><span className="text-studio-ink-3">下一步：</span>{execFailure.next}</div>
          </div>
        ) : null}

        {execResult ? (
          <div className="mt-3 rounded-lg border border-studio-line bg-studio/60 p-3">
            <div className="mb-1.5 font-mono text-[11px] text-studio-ink-3">执行结果</div>
            {execResult.results.length > 0 ? (
              <ul className="space-y-1.5">
                {execResult.results.map((result) => {
                  const failure = result.ok ? null : describeExecuteFailure({ op: result.op, message: result.error ?? '未知原因' });
                  return (
                    <li key={result.index} className="flex items-start gap-2 text-[12.5px]">
                      {result.ok ? (
                        <CheckCircleIcon size={13} weight="fill" className="mt-0.5 shrink-0 text-accent" />
                      ) : (
                        <WarningCircleIcon size={13} weight="fill" className="mt-0.5 shrink-0 text-warn" />
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="font-mono text-[11px]">{result.op}</span>
                        <span className="ml-1 text-studio-ink-2">{result.ok ? '成功' : (failure?.title ?? '失败')}</span>
                        {result.ok && result.value?.summary ? (
                          <span className="mt-0.5 block text-studio-ink-2">{result.value.summary}</span>
                        ) : null}
                        {result.ok && result.value?.data ? <ValueTable data={result.value.data} /> : null}
                        {failure ? (
                          <span className="mt-0.5 block text-studio-ink-2">
                            {failure.detail}
                            <span className="mt-0.5 block text-studio-ink-3">下一步：{failure.next}</span>
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="text-[12.5px] text-studio-ink-2">{execResult.warning ?? '没有可报告的结果'}</p>
            )}
            <p className="mt-1.5 text-[11.5px] leading-relaxed text-studio-ink-3">
              {execResult.ok
                ? '全部成功：改动已落盘，地图已刷新，备份与留痕已写进项目目录。'
                : execResult.completed > 0
                  ? `部分成功：${execResult.completed}/${execResult.results.length} 条完成，已完成的不回滚。`
                  : '全部失败：文件没有被改动。'}
            </p>
          </div>
        ) : null}
      </div>

      {gateOpen && proposal?.plan ? (
        proposal.plan.ops.length === 1 ? (
          <ConfirmCard
            op={{
              op: proposal.plan.ops[0]?.op ?? '',
              params: proposal.plan.ops[0]?.params ?? {},
              label: opLabel(proposal.plan.ops[0]?.op ?? ''),
            }}
            preview={(previews[0] ?? null) as import('../types').OpPreview | null}
            previewing={previewing}
            previewError={previewFailure?.detail ?? null}
            executing={executing}
            outcome={null}
            onConfirm={() => void confirmExecute()}
            onCancel={cancelPlan}
          />
        ) : (
          <PlanGate
            ops={proposal.plan.ops.map((op) => ({ op: op.op, params: op.params }))}
            previews={previews}
            previewing={previewing}
            previewError={previewFailure?.detail ?? null}
            executing={executing}
            onConfirm={() => void confirmExecute()}
            onCancel={cancelPlan}
          />
        )
      ) : null}
    </div>
  );
}
