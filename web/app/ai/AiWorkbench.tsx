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
import ValueTable from './ValueTable';
import { opLabel } from './opLabels';
import {
  describeExecuteFailure,
  describePlanFailure,
  describePreviewFailure,
  describeZeroImpact,
  findZeroImpactOps,
  type HumanFailure,
} from './failures';
import {
  EMPTY_ENTRY_CONTEXT,
  describeAiEntry,
  parseAiEntryQuery,
  type AiEntryContext,
} from './entryContext';
import { useLlm, type ContextPreview, type LlmSource, type PlanPayload } from './useLlm';
import { ENGINE_BASE } from '../engine-base';

/** 来源 → 一句人话 */
const SOURCE_TEXT: Record<LlmSource, string> = {
  none: '还没配置密钥',
  env: '来自本机加密存储',
  session: '会话内粘贴，引擎重启后失效',
};

export default function AiWorkbench() {
  const llm = useLlm();

  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('max');
  const [prompt, setPrompt] = useState('用一句话说：这张图适合用来做什么？');

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

  // 思考深度档位由**接入线**给：认这个参数的才有（MiniMax）。
  // 别家给一份兜底档位等于发一个它不认的参数 —— 整次请求会失败。
  const effortLevels = llm.status?.effortLevels ?? [];
  const status = llm.status;
  const configured = status?.configured ?? false;
  const activeProvider = useMemo(
    () => status?.providers.find((p) => p.id === status.provider) ?? null,
    [status],
  );
  const [endpoint, setEndpoint] = useState('');
  useEffect(() => {
    setEndpoint(activeProvider?.baseUrl ?? '');
  }, [activeProvider?.baseUrl]);

  const modelsPayload = llm.models;
  const modelOptions = useMemo(
    () => modelsPayload?.models ?? status?.models ?? [],
    [modelsPayload, status],
  );

  const submitKey = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key) return;
    // 带上当前接入线：密钥是**按厂商分开存**的，别家的不能被覆盖。
    const res = await llm.setKey(key, status?.provider);
    // 无论成败，输入框里的内容都不能留着
    setApiKey('');
    if (res.ok) void llm.pullModels();
  };

  /** 「记住这台电脑」：写入本机 DPAPI 密文，同时立即使会话生效（免二次粘贴） */
  const rememberKey = async (): Promise<void> => {
    const key = apiKey.trim();
    if (!key || llm.isBusy('key')) return;
    try {
      const res = await fetch(`${ENGINE_BASE}/api/llm/persist-key`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: status?.provider, apiKey: key }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) throw new Error(body?.message ?? `HTTP ${res.status}`);
      // 写盘成功后立刻让会话也生效，用户不用再贴一次
      await llm.setKey(key, status?.provider);
      setApiKey('');
      void llm.pullModels();
    } catch (err) {
      setApiKey('');
      // 记住失败不静默：key 还在输入框里，用户没损失，但要知道为什么
      setLlmError(`没能记住密钥：${(err as Error).message}（key 仍在输入框，可改用「仅本次会话使用」）`);
    }
  };

  /** 清除：会话密钥必清；这台电脑上有记住的密文就一并删 */
  const forgetKey = async (): Promise<void> => {
    const provider = status?.provider;
    if (provider) await llm.clearKey(provider);
    try {
      await fetch(`${ENGINE_BASE}/api/llm/persist-key`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ providerId: provider }),
      });
    } catch {
      /* 删除失败不打断：会话密钥已经清了 */
    }
    void llm.refreshStatus();
  };

  /** llm.error 之外的本页错误（记住失败等），一条通道显示 */
  const [llmError, setLlmError] = useState<string | null>(null);

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
        </h1>
        <p className="mt-2 max-w-xl text-[13px] leading-relaxed text-studio-ink-2">
          粘贴密钥 → 挑模型 → 试通不通。
  用一句话改图：进画布，右侧的 AI 面板。
        </p>

        {/* 隐私承诺压成两行：发送清单对着 server/src/llm-plan.ts 的白名单写，
            改白名单时这里的文案必须跟着改。 */}
        <p className="mt-3 max-w-xl text-[12px] leading-relaxed text-studio-ink-3">
          发送给模型的只有图层清单、视窗内要素摘要和你的原话（发前可逐字查看）；
          图件本体、绝对路径、用户名永不上传。
        </p>

        {llm.error ? (
          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
            <WarningCircleIcon size={15} weight="fill" className="mt-px shrink-0" />
            <span>{llm.error}</span>
          </div>
        ) : null}

        {llmError ? (
          <div className="mt-6 flex items-start gap-2.5 rounded-lg border border-warn/45 bg-warn/12 px-4 py-3 text-[12.5px] leading-relaxed text-warn">
            <WarningCircleIcon size={15} weight="fill" className="mt-px shrink-0" />
            <span>{llmError}</span>
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

          {/* 接入线（模型厂商）选择：密钥是用户自带的，不同的人手里是不同的厂商。
              不给选的话，别人贴自己的 key 只会看到一句「还没配置密钥」。 */}
          <div className="mt-4 flex flex-col gap-1.5">
            <label className="text-[12px] text-studio-ink-3" htmlFor="ai-provider">
              接入线（模型厂商）
            </label>
            <select
              id="ai-provider"
              value={status?.provider ?? ''}
              onChange={(e) => void llm.selectProvider(e.target.value)}
              className="rounded-lg border border-studio-line bg-studio/70 px-2.5 py-1.5 text-[12.5px] text-studio-ink focus:border-accent focus:outline-none"
            >
              {(status?.providers ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.configured ? '（已配置密钥）' : ''}
                </option>
              ))}
            </select>
            {activeProvider?.note ? (
              <p className="text-[12px] leading-relaxed text-studio-ink-3">{activeProvider.note}</p>
            ) : null}
          </div>

          {activeProvider?.customEndpoint ? (
            <div className="mt-3 flex flex-col gap-1.5">
              <label className="text-[12px] text-studio-ink-3" htmlFor="ai-endpoint">
                端点地址（OpenAI 兼容）
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <TextField
                  id="ai-endpoint"
                  value={endpoint}
                  onChange={(e) => setEndpoint(e.target.value)}
                  placeholder="https://example.com/v1"
                  className="min-w-[260px] flex-1"
                  autoComplete="off"
                  spellCheck={false}
                />
                <ActionButton
                  onClick={() => void llm.setCustomEndpoint(activeProvider.id, endpoint.trim())}
                  disabled={!endpoint.trim()}
                >
                  保存端点
                </ActionButton>
              </div>
            </div>
          ) : null}

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
            {/* 「记住这台电脑」：key 以 DPAPI 密文存本机（引擎写，前端只见状态），
                重启不用重填。与「仅本次会话」用同一把输入框里的 key。 */}
            <ActionButton
              onClick={() => void rememberKey()}
              disabled={!apiKey.trim() || llm.isBusy('key')}
              title="以 DPAPI 密文存本机（%LOCALAPPDATA%\cartouche\keys），重启后不用重填"
            >
              记住这台电脑
            </ActionButton>
            {configured ? (
              <ActionButton
                onClick={() => void forgetKey()}
                disabled={llm.isBusy('key')}
                title="清除会话密钥；如果这台电脑上有记住的密文，一并删除"
              >
                清除
              </ActionButton>
            ) : null}
          </div>

          {status?.hint ? (
            <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber/40 bg-amber/10 px-3 py-2.5 text-[12px] leading-relaxed text-amber">
              <WarningCircleIcon size={14} weight="fill" className="mt-px shrink-0" />
              <span>{status.hint}</span>
            </div>
          ) : null}

          <ul className="mt-4 space-y-1.5 text-[12px] leading-relaxed text-studio-ink-3">
            <li>· 密钥只在引擎内存里，重启即失效；本页永不回显</li>
            <li>· 想长期保存：scripts\set-key.ps1 -Provider deepseek（DPAPI 密文存本机，八条接入线都支持）</li>
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

          <div className="mt-4 flex flex-wrap items-center gap-2">
            {/* 端点明说没有清单接口的，就不给这个按钮 ——
                发一个必然失败的请求比没有这个按钮更糟。 */}
            {activeProvider?.modelsSupported === false ? (
              <span className="text-[12px] text-studio-ink-3">
                这条接入线没有模型清单接口，请手填模型名。
              </span>
            ) : (
              <>
                <ActionButton
                  onClick={() => void llm.pullModels(status?.provider)}
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
              </>
            )}
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

            {/* 只有认这个参数的接入线才有这一栏 */}
            {effortLevels.length > 0 ? (
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
            ) : null}
          </div>
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

      </main>
    </div>
  );
}
