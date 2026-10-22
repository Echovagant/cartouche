'use client';

/**
 * AI 接入页。
 *
 * 整页只回答三个问题，顺序也是用户心里的顺序：
 *
 *   1. **密钥从哪来** —— 粘贴（只驻留引擎内存）或指本机 DPAPI 密文
 *   2. **用哪个模型** —— 实时从官方拉清单，不靠写死的列表
 *   3. **到底能不能连通** —— 发一句话，看回话与耗时
 *
 * 关于密钥，这个页面**从头到尾不回显它**：输入框是密码框，
 * 提交后立刻清空，状态接口只回「配没配 / 从哪来」。
 * 页面上写这三条规矩，不是给用户看的免责声明 ——
 * 是让用户敢把密钥交出来。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  DownloadSimpleIcon,
  EyeIcon,
  KeyIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { ActionButton, SectionLabel, TextField } from '../canvas/ui';
import { ThemeToggle } from '../canvas/ThemeToggle';
import ConfirmCard from '../canvas/ConfirmCard';
import type { EditOp, OpPreview } from '../canvas/types';
import PlanGate, { type PlanGatePreview } from './PlanGate';
import { opLabel } from './opLabels';
import {
  useLlm,
  ENGINE_BASE,
  type ContextPreview,
  type LlmSource,
  type PlanFailureKind,
  type PlanPayload,
} from './useLlm';

/** 引擎执行操作的返回体（逐条结果） */
interface ExecResultPayload {
  readonly ok: boolean;
  readonly results: readonly {
    readonly index: number;
    readonly op: string;
    readonly ok: boolean;
    readonly target?: string;
    readonly unimplemented?: boolean;
    readonly impact?: Readonly<Record<string, unknown>>;
    readonly error?: string;
  }[];
  readonly completed: number;
  readonly failedAt?: number;
  readonly warning?: string;
}

/** 来源 → 一句人话 */
const SOURCE_TEXT: Record<LlmSource, string> = {
  none: '还没配置密钥',
  env: '来自启动脚本注入的环境变量（磁盘上只有 DPAPI 密文）',
  session: '来自这次会话里粘贴的（只在引擎内存里，引擎退出即失效）',
};

/** 失败类别 → 一句话标题（把"该怎么办"摆到最前面） */
const FAILURE_TITLE: Record<PlanFailureKind, string> = {
  not_configured: '还没配置密钥',
  key: '密钥被官方拒了',
  network: '连不上模型服务',
  bad_plan: '模型返回的计划不合法',
  unsupported: '这个操作还没做',
  unknown: '提议失败',
};

/** 闸门②的结论 → 一句人话 */
const PRECHECK_TEXT: Record<string, string> = {
  pass: '前置校验通过',
  fail: '前置校验没过',
  unimplemented: '该操作尚未支持',
  unpreviewable: '这个操作算不出影响面（确认后可直接执行）',
};

/** 计划里某条操作的影响对象（展示用） */
function targetText(params: Record<string, unknown>): string {
  const raw = params['target'];
  if (typeof raw !== 'string' || raw.trim() === '') return '（未指定）';
  return raw.replace(/^(?:dataset|layer|summary):\/\//, '');
}

export default function AiWorkbench() {
  const llm = useLlm();

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('max');
  const [prompt, setPrompt] = useState('用一句话说：这张图适合用来做什么？');

  /* ── 4 · 用一句话改图 ── */
  /** 用户的原话 */
  const [instruction, setInstruction] = useState('');
  /** 项目根（绝对路径）：给了才能把图层清单交给模型 */
  const [projectRoot, setProjectRoot] = useState('');
  /** 模型给回来的计划（只提议，不执行） */
  const [proposal, setProposal] = useState<PlanPayload | null>(null);
  /** 闸门④的确认卡是否打开 */
  const [gateOpen, setGateOpen] = useState(false);
  /** 闸门③：逐条预演出来的影响面 */
  const [previews, setPreviews] = useState<PlanGatePreview[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  /** 执行结果（逐条） */
  const [execResult, setExecResult] = useState<ExecResultPayload | null>(null);
  /** 「本次将发送什么」的预览 */
  const [contextPreview, setContextPreview] = useState<ContextPreview | null>(null);

  // 进来先看一眼当前状态：密钥是不是已经在环境变量里了
  useEffect(() => {
    void llm.refreshStatus();
    // 只在挂载时问一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 模型清单到手后，默认选中第一个（列表按官方返回的顺序）
  useEffect(() => {
    if (!llm.models || llm.models.models.length === 0) return;
    setModel((prev) =>
      prev && llm.models?.models.includes(prev) ? prev : (llm.models?.models[0] ?? ''),
    );
  }, [llm.models]);

  const effortLevels = llm.status?.effortLevels ?? ['low', 'medium', 'high', 'xhigh', 'max'];
  const status = llm.status;
  const configured = status?.configured ?? false;

  const modelsPayload = llm.models;
  const modelOptions = useMemo(
    () => modelsPayload?.models ?? status?.models ?? [],
    [modelsPayload, status],
  );

  const submitKey = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key) return;
    const res = await llm.setKey(key);
    // 无论成败，输入框里的内容都不能留着
    setApiKey('');
    if (res.ok) void llm.pullModels();
  };

  /* ── 提议层：四道闸门按顺序来 ── */

  /** 看一眼「本次将发送什么」（发之前就能看到裁剪后的上下文） */
  const showContext = async (): Promise<void> => {
    const preview = await llm.fetchContextPreview({
      prompt: instruction,
      model,
      effort,
      root: projectRoot.trim() || null,
    });
    if (preview) setContextPreview(preview);
  };

  /**
   * 闸门③：逐条预演，把影响面算出来。
   *
   * 算不出来就不给执行按钮 —— 影响面都没算出来，确认卡就成了摆设。
   */
  const runPreviews = async (ops: readonly { op: string; params: Record<string, unknown> }[]): Promise<void> => {
    setPreviewing(true);
    setPreviewError(null);
    setPreviews([]);
    const list: PlanGatePreview[] = [];
    for (const op of ops) {
      try {
        const res = await fetch(`${ENGINE_BASE}/api/op/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            op: op.op,
            params: op.params,
            ...(projectRoot.trim() ? { root: projectRoot.trim() } : {}),
          }),
        });
        const body = (await res.json().catch(() => null)) as {
          message?: string;
        } & Partial<PlanGatePreview>;
        if (!res.ok) {
          setPreviewError(body?.message ?? `预演失败（HTTP ${res.status}）`);
          break;
        }
        list.push(body as PlanGatePreview);
      } catch (err) {
        setPreviewError(
          `无法连接引擎服务 ${ENGINE_BASE}（请确认已运行 npm run dev:server）：${(err as Error).message}`,
        );
        break;
      }
    }
    setPreviews(list);
    setPreviewing(false);
  };

  /** 要一份操作计划 */
  const sendPlan = async (): Promise<void> => {
    const text = instruction.trim();
    if (!text) return;
    setProposal(null);
    setPreviews([]);
    setPreviewError(null);
    setExecResult(null);
    setGateOpen(false);
    const res = await llm.requestPlan({
      prompt: text,
      model,
      effort,
      root: projectRoot.trim() || null,
    });
    if (!res) return;
    setProposal(res);
    if (res.context) setContextPreview(res.context);
    // 闸门①（Schema）或闸门②（尚未支持）没过：只报告，不给确认
    if (!res.ok) return;
    setGateOpen(true);
    await runPreviews(res.plan?.ops ?? []);
  };

  /** 闸门④：用户点头了才真的改文件 */
  const confirmExecute = async (): Promise<void> => {
    const doc = proposal?.plan;
    if (!doc) return;
    setExecuting(true);
    try {
      const root = projectRoot.trim();
      const res = await fetch(`${ENGINE_BASE}/api/op/execute`, {
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
          ...(root ? { root, projectRoot: root } : {}),
        }),
      });
      const body = (await res.json().catch(() => null)) as ExecResultPayload | null;
      if (!res.ok || !body) {
        setExecResult({
          ok: false,
          completed: 0,
          results: [],
          failedAt: 0,
          warning: `执行失败（HTTP ${res.status}）`,
        });
        setGateOpen(false);
        return;
      }
      setExecResult(body);
      setGateOpen(false);
    } catch (err) {
      setExecResult({
        ok: false,
        completed: 0,
        results: [],
        failedAt: 0,
        warning: `无法连接引擎服务 ${ENGINE_BASE}：${(err as Error).message}`,
      });
      setGateOpen(false);
    } finally {
      setExecuting(false);
    }
  };

  /** 取消：什么也不发生 */
  const cancelPlan = (): void => {
    setGateOpen(false);
    setPreviews([]);
    setPreviewError(null);
  };

  return (
    <div className="min-h-[100dvh] bg-studio text-studio-ink">
      <header className="border-b border-studio-line">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-5 py-3.5">
          <a
            href="index.html"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-studio-ink-3 transition-colors hover:text-studio-ink"
          >
            <ArrowLeftIcon size={13} weight="bold" />
            返回首页
          </a>
          <span className="flex-1" />
          <ThemeToggle />
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="font-display text-[26px] font-semibold tracking-tight">
          AI 接入
          <span className="ml-3 align-middle rounded-full border border-amber/45 px-2 py-0.5 font-mono text-[11px] font-normal text-amber">
            开发中
          </span>
        </h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-studio-ink-2">
          把密钥交给本机引擎，挑一个模型，然后发一句话试试通不通。
          密钥不出这台机器，也不进仓库。
        </p>
        <p className="mt-3 max-w-xl text-[12.5px] leading-relaxed text-studio-ink-3">
          <span className="text-studio-ink-2">上面三步是「模型接入」：</span>
          配密钥、实时拉模型清单、发一句话测连通。
          <span className="text-studio-ink-2">第四步是「用一句话改图」：</span>
          模型只负责提议一份操作计划，真正改文件的是确定性引擎，
          而且要你先看清影响面、再点确认。
        </p>

        {llm.error ? (
          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
            <WarningCircleIcon size={15} weight="fill" className="mt-px shrink-0" />
            <span>{llm.error}</span>
          </div>
        ) : null}

        {llm.statusError ? (
          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
            <WarningCircleIcon size={15} weight="fill" className="mt-px shrink-0" />
            <span>读不到引擎状态：{llm.statusError}</span>
          </div>
        ) : null}

        {/* ── 1. 密钥来源 ── */}
        <section className="mt-8 rounded-xl border border-studio-line bg-studio-2/70 p-5">
          <SectionLabel
            right={
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
                <KeyIcon size={13} />
                {configured ? '已配置' : '未配置'}
              </span>
            }
          >
            1 · 密钥来源
          </SectionLabel>

          <p className="text-[12.5px] leading-relaxed text-studio-ink-2">
            {status ? SOURCE_TEXT[status.source] : '正在读取引擎状态…'}
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <TextField
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void submitKey();
              }}
              placeholder="粘贴 API Key（只送到本机引擎，不落盘）"
              className="min-w-[260px] flex-1"
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
            {configured && status?.source === 'session' ? (
              <ActionButton onClick={() => void llm.clearKey()} disabled={llm.isBusy('key')}>
                清除
              </ActionButton>
            ) : null}
          </div>

          <ul className="mt-4 space-y-1.5 text-[12px] leading-relaxed text-studio-ink-3">
            <li>· 粘贴的密钥只存在于引擎进程内存里，引擎一关就没了</li>
            <li>· 想长期保存：用 scripts/set-key.ps1 写进本机 DPAPI 密文（%LOCALAPPDATA%\cartouche\llm-key.txt），磁盘上没有明文</li>
            <li>· 这个页面永远不回显密钥，也没有任何接口会把它返回给浏览器</li>
          </ul>
        </section>

        {/* ── 2. 模型 ── */}
        <section className="mt-4 rounded-xl border border-studio-line bg-studio-2/70 p-5">
          <SectionLabel
            right={
              modelsPayload ? (
                <span
                  className={`inline-flex items-center gap-1.5 text-[11.5px] ${
                    modelsPayload.source === 'api' ? 'text-accent' : 'text-amber'
                  }`}
                >
                  {modelsPayload.source === 'api' ? (
                    <CheckCircleIcon size={13} weight="fill" />
                  ) : (
                    <WarningCircleIcon size={13} weight="fill" />
                  )}
                  {modelsPayload.source === 'api'
                    ? '实时拉取'
                    : modelsPayload.source === 'stale'
                      ? '上次成功'
                      : '离线兜底'}
                </span>
              ) : null
            }
          >
            2 · 模型
          </SectionLabel>

          <p className="text-[12.5px] leading-relaxed text-studio-ink-2">
            模型上下线很频繁，写死在代码里的清单随时会过期 ——
            所以这里默认按官方实时返回的清单来选。
          </p>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <ActionButton
              onClick={() => void llm.pullModels()}
              disabled={!configured || llm.isBusy('models')}
            >
              {llm.isBusy('models') ? (
                <SpinnerGapIcon size={13} className="animate-spin" />
              ) : (
                <DownloadSimpleIcon size={13} />
              )}
              拉取模型列表
            </ActionButton>
            <span className="text-[12px] text-studio-ink-3">
              {configured ? '' : '先在上一步配置密钥'}
            </span>
          </div>

          {modelsPayload?.warning ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber">
              <WarningCircleIcon size={14} weight="fill" className="mt-px shrink-0" />
              <span>
                {modelsPayload.source === 'stale'
                  ? '本次拉取失败，下面是上一次拉到的清单（可能已经过期）：'
                  : '实时拉取没成功，下面是代码里的离线兜底清单：'}
                {modelsPayload.warning}
              </span>
            </div>
          ) : null}

          <div className="mt-4 flex flex-wrap gap-4">
            <label className="flex flex-col gap-1.5 text-[12px] text-studio-ink-3">
              <span>模型</span>
              <select
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={modelOptions.length === 0}
                className="rounded-lg border border-studio-line bg-studio/70 px-2.5 py-1.5 text-[12.5px] text-studio-ink disabled:opacity-40 focus:border-accent focus:outline-none"
              >
                {modelOptions.length === 0 ? (
                  <option value="">（先拉一次列表）</option>
                ) : null}
                {modelOptions.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-[12px] text-studio-ink-3">
              <span>思考深度</span>
              <select
                value={effort}
                onChange={(e) => setEffort(e.target.value)}
                className="rounded-lg border border-studio-line bg-studio/70 px-2.5 py-1.5 text-[12.5px] text-studio-ink focus:border-accent focus:outline-none"
              >
                {effortLevels.map((lv) => (
                  <option key={lv} value={lv}>
                    {lv}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <p className="mt-3 text-[12px] leading-relaxed text-studio-ink-3">
            深度思考官方默认开着且关不掉，想省 token 只能调低档位。
          </p>
        </section>

        {/* ── 3. 连通性测试 ── */}
        <section className="mt-4 rounded-xl border border-studio-line bg-studio-2/70 p-5">
          <SectionLabel
            right={
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
                <PlugsConnectedIcon size={13} />
                连通性
              </span>
            }
          >
            3 · 试一句
          </SectionLabel>

          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={3}
            className="w-full resize-y rounded-lg border border-studio-line bg-studio/70 px-2.5 py-2 text-[12.5px] leading-relaxed text-studio-ink placeholder:text-studio-ink-3 focus:border-accent focus:outline-none"
            placeholder="发一句话过去，看看模型怎么回"
          />

          <div className="mt-3 flex items-center gap-2">
            <ActionButton
              variant="primary"
              onClick={() =>
                void llm.testConnection({ prompt, model, effort })
              }
              disabled={!configured || llm.isBusy('test') || !prompt.trim()}
            >
              {llm.isBusy('test') ? (
                <SpinnerGapIcon size={13} className="animate-spin" />
              ) : (
                <PaperPlaneTiltIcon size={13} />
              )}
              发一句试试
            </ActionButton>
            {!configured ? (
              <span className="text-[12px] text-studio-ink-3">先在上一步配置密钥</span>
            ) : null}
          </div>

          {llm.testResult ? (
            <div className="mt-4 rounded-lg border border-studio-line bg-studio/60 p-4">
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11.5px] text-studio-ink-3">
                <span>{llm.testResult.model}</span>
                <span>·</span>
                <span>{llm.testResult.elapsedMs} ms</span>
              </div>
              <p className="whitespace-pre-wrap text-[13px] leading-relaxed text-studio-ink">
                {llm.testResult.reply}
              </p>
            </div>
          ) : null}
        </section>

        {/* ── 4. 用一句话改图 ── */}
        <section className="mt-4 rounded-xl border border-studio-line bg-studio-2/70 p-5">
          <SectionLabel
            right={
              <span className="inline-flex items-center gap-1.5 text-[11.5px] text-studio-ink-3">
                <PaperPlaneTiltIcon size={13} />
                提议 → 预演 → 确认
              </span>
            }
          >
            4 · 用一句话改图
          </SectionLabel>

          <p className="text-[12.5px] leading-relaxed text-studio-ink-2">
            说一句想怎么改，模型只会给出**一份操作计划**（提议），不会碰你的文件。
            计划要过三道检查（合法性、引擎能不能做、影响多大），
            最后还得你点「确认执行」才会落盘。
          </p>

          <div className="mt-4 flex flex-col gap-1.5">
            <label className="text-[12px] text-studio-ink-3" htmlFor="ai-project-root">
              项目根目录（可选）
            </label>
            <TextField
              id="ai-project-root"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="例如 C:\...\workspace\演示项目"
              className="w-full"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-[11.5px] leading-relaxed text-studio-ink-3">
              填了才能把图层清单（名字、字段、要素数量）交给模型；不填就只有空上下文。
              这里填的是本机路径，只发给本机引擎，不会发给模型。
            </p>
          </div>

          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={3}
            className="mt-4 w-full resize-y rounded-lg border border-studio-line bg-studio/70 px-2.5 py-2 text-[12.5px] leading-relaxed text-studio-ink placeholder:text-studio-ink-3 focus:border-accent focus:outline-none"
            placeholder="例如：把底图右上角那片提亮一点，别动别的"
          />

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <ActionButton
              variant="primary"
              onClick={() => void sendPlan()}
              disabled={!configured || llm.planBusy || !instruction.trim()}
            >
              {llm.planBusy ? (
                <SpinnerGapIcon size={13} className="animate-spin" />
              ) : (
                <PaperPlaneTiltIcon size={13} />
              )}
              {llm.planBusy ? '模型正在想…' : '提议改动'}
            </ActionButton>
            <ActionButton onClick={() => void showContext()} disabled={llm.isBusy('status')}>
              <EyeIcon size={13} />
              看看会发送什么
            </ActionButton>
            {!configured ? (
              <span className="text-[12px] text-studio-ink-3">先在上一步配置密钥</span>
            ) : null}
          </div>

          {/* 失败：分类说清楚，并给重试 */}
          {llm.planFailure ? (
            <div className="mt-4 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
              <div className="flex items-start gap-2.5">
                <WarningCircleIcon size={15} weight="fill" className="mt-px shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{FAILURE_TITLE[llm.planFailure.kind]}</div>
                  <div className="mt-1 text-studio-ink-2">{llm.planFailure.message}</div>
                  {llm.planFailure.code !== null ? (
                    <div className="mt-1 font-mono text-[11.5px] text-studio-ink-3">
                      官方错误码 {llm.planFailure.code}
                    </div>
                  ) : null}
                  <div className="mt-2">
                    <ActionButton onClick={() => void sendPlan()} disabled={llm.planBusy}>
                      重试
                    </ActionButton>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* 闸门①：计划不合法 —— 指出是哪一条 */}
          {proposal && proposal.schemaIssues.length > 0 ? (
            <div className="mt-4 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
              <strong>闸门① · 计划不合法：</strong>
              <ul className="mt-1.5 space-y-1">
                {proposal.schemaIssues.map((issue, i) => (
                  <li key={`${issue.opIndex}-${i}`}>· {issue.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 闸门②：引擎还没做的操作 */}
          {proposal && proposal.unsupported.length > 0 ? (
            <div className="mt-4 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
              <strong>闸门② · 还没做的操作：</strong>
              <ul className="mt-1.5 space-y-1">
                {proposal.unsupported.map((item) => (
                  <li key={`${item.opIndex}-${item.op}`}>· {item.message}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* 计划预览：模型提议了什么 */}
          {proposal?.plan ? (
            <div className="mt-4 rounded-lg border border-studio-line bg-studio/60 p-3.5">
              <div className="mb-2 font-mono text-[11px] text-studio-ink-3">
                计划预览（模型只提议，文件还没动）
                {proposal.model ? ` · ${proposal.model}` : ''}
                {proposal.elapsedMs !== null ? ` · ${proposal.elapsedMs} ms` : ''}
              </div>
              {proposal.plan.intent ? (
                <p className="mb-2 text-[12.5px] leading-relaxed text-studio-ink-2">
                  {proposal.plan.intent}
                </p>
              ) : null}
              <ol className="flex flex-col gap-2">
                {proposal.plan.ops.map((op, index) => (
                  <li
                    key={`${op.op}-${index}`}
                    className="rounded border border-studio-line bg-studio/45 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-studio-ink">
                      <span className="font-mono text-[11px] text-studio-ink-3">#{index + 1}</span>
                      <strong className="font-medium">{opLabel(op.op)}</strong>
                      <span className="font-mono text-[11px] text-studio-ink-3">{op.op}</span>
                    </div>
                    <div className="mt-1 font-mono text-[11.5px] break-all text-studio-ink-2">
                      影响对象：{targetText(op.params)}
                    </div>
                    <pre className="mt-1.5 overflow-x-auto whitespace-pre-wrap rounded bg-studio/70 p-2 font-mono text-[11px] leading-relaxed text-studio-ink-2">
                      {JSON.stringify(op.params, null, 2)}
                    </pre>
                  </li>
                ))}
              </ol>

              {/* 闸门②：引擎前置校验的逐条结论 */}
              {proposal.precheck.length > 0 ? (
                <ul className="mt-3 space-y-1 text-[12px] leading-relaxed">
                  {proposal.precheck.map((entry) => (
                    <li
                      key={`${entry.opIndex}-${entry.op}`}
                      className={entry.status === 'pass' ? 'text-studio-ink-3' : 'text-warn'}
                    >
                      · {entry.op}：{PRECHECK_TEXT[entry.status] ?? entry.status}
                      {entry.message ? ` — ${entry.message}` : ''}
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {/* 闸门③：量化影响报告 */}
          {previews.length > 0 ? (
            <div className="mt-4 rounded-lg border border-studio-line bg-studio/60 p-3.5">
              <div className="mb-2 font-mono text-[11px] text-studio-ink-3">闸门③ · 量化影响</div>
              <ul className="space-y-2">
                {previews.map((preview, index) => {
                  const ratio =
                    preview.totalPixels > 0
                      ? preview.affectedRatio > 0
                        ? preview.affectedRatio
                        : preview.affectedPixels / preview.totalPixels
                      : 0;
                  return (
                    <li key={`${preview.op}-${index}`} className="text-[12.5px] text-studio-ink-2">
                      · {preview.op}：影响{' '}
                      <span className="font-mono text-studio-ink">
                        {preview.affectedPixels.toLocaleString('zh-CN')} /{' '}
                        {preview.totalPixels.toLocaleString('zh-CN')}
                      </span>{' '}
                      像元（{(ratio * 100).toFixed(1)}%）· 目标{' '}
                      <span className="font-mono">{preview.target}</span> · 备份{' '}
                      <span className="font-mono">
                        {preview.backupPath ?? preview.backupNamePattern ?? '执行时生成'}
                      </span>
                    </li>
                  );
                })}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-studio-ink-3">
                预演不写盘，只算影响面。真正落盘要等你点确认。
              </p>
            </div>
          ) : null}

          {previewError ? (
            <div className="mt-4 rounded-lg border border-warn/40 bg-warn/12 px-3 py-2.5 text-[12.5px] leading-relaxed text-warn">
              <strong>预演失败：</strong>
              {previewError}
              <div className="mt-1 text-studio-ink-3">影响面算不出来，这次先不执行。</div>
            </div>
          ) : null}

          {/* 执行结果 */}
          {execResult ? (
            <div className="mt-4 rounded-lg border border-studio-line bg-studio/60 p-3.5">
              <div className="mb-2 font-mono text-[11px] text-studio-ink-3">执行结果</div>
              {execResult.results.length > 0 ? (
                <ul className="space-y-1.5">
                  {execResult.results.map((result) => (
                    <li key={result.index} className="flex items-start gap-2 text-[12.5px]">
                      {result.ok ? (
                        <CheckCircleIcon
                          size={14}
                          weight="fill"
                          className="mt-0.5 shrink-0 text-accent"
                        />
                      ) : (
                        <WarningCircleIcon
                          size={14}
                          weight="fill"
                          className="mt-0.5 shrink-0 text-warn"
                        />
                      )}
                      <span className="min-w-0">
                        <span className="font-mono text-[11.5px]">{result.op}</span>
                        <span className="ml-1.5 text-studio-ink-2">
                          {result.ok ? '成功' : `失败：${result.error ?? '未知原因'}`}
                        </span>
                        {result.target ? (
                          <span className="ml-1.5 font-mono text-[11px] text-studio-ink-3">
                            {result.target}
                          </span>
                        ) : null}
                        {result.ok && result.impact ? (
                          <span className="ml-1.5 font-mono text-[11px] text-studio-ink-3">
                            影响 {Number(result.impact['affectedPixels'] ?? 0).toLocaleString('zh-CN')}{' '}
                            像元
                          </span>
                        ) : null}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[12.5px] text-studio-ink-2">{execResult.warning ?? '没有可报告的结果'}</p>
              )}
              <p className="mt-2 text-[12px] leading-relaxed text-studio-ink-3">
                {execResult.ok
                  ? '全部成功：改动已落盘，备份文件与留痕（history.jsonl）已写进项目目录。'
                  : execResult.completed > 0
                    ? `部分成功：${execResult.completed}/${execResult.results.length} 条完成，` +
                      '已完成的不会回滚，失败的条目原因如上。'
                    : '全部失败：文件没有被改动。'}
                {execResult.warning ? ` ${execResult.warning}` : ''}
              </p>
            </div>
          ) : null}

          {/* 上下文预览：本次到底发送了什么 */}
          <details className="mt-4 rounded-lg border border-studio-line bg-studio/45 px-3 py-2">
            <summary className="cursor-pointer text-[12px] text-studio-ink-2">
              本次将发送什么（裁剪后的上下文）
            </summary>
            <div className="mt-2">
              {contextPreview ? (
                <>
                  <div className="mb-1.5 font-mono text-[11px] text-studio-ink-3">
                    {contextPreview.bytes} 字节
                    {contextPreview.model ? ` · ${contextPreview.model}` : ''}
                    {contextPreview.effort ? ` · 思考深度 ${contextPreview.effort}` : ''}
                  </div>
                  <pre className="max-h-[320px] overflow-auto whitespace-pre-wrap rounded border border-studio-line bg-studio/70 p-2.5 font-mono text-[11.5px] leading-relaxed text-studio-ink-2">
                    {contextPreview.prompt}
                  </pre>
                </>
              ) : (
                <p className="text-[12px] text-studio-ink-3">
                  还没算。点上面的「看看会发送什么」就能看到发出去的那段原文。
                </p>
              )}
            </div>
          </details>
        </section>
      </main>

      {/* ── 闸门④：人工确认 ── */}
      {gateOpen && proposal?.plan ? (
        proposal.plan.ops.length === 1 ? (
          <ConfirmCard
            op={
              {
                op: proposal.plan.ops[0]?.op ?? '',
                params: proposal.plan.ops[0]?.params ?? {},
                label: opLabel(proposal.plan.ops[0]?.op ?? ''),
              } as EditOp
            }
            preview={(previews[0] ?? null) as OpPreview | null}
            previewing={previewing}
            previewError={previewError}
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
            previewError={previewError}
            executing={executing}
            onConfirm={() => void confirmExecute()}
            onCancel={cancelPlan}
          />
        )
      ) : null}
    </div>
  );
}
