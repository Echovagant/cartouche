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
  KeyIcon,
  PaperPlaneTiltIcon,
  PlugsConnectedIcon,
  SpinnerGapIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import { ActionButton, SectionLabel, TextField } from '../canvas/ui';
import { ThemeToggle } from '../canvas/ThemeToggle';
import { useLlm, type LlmSource } from './useLlm';

/** 来源 → 一句人话 */
const SOURCE_TEXT: Record<LlmSource, string> = {
  none: '还没配置密钥',
  env: '来自启动脚本注入的环境变量（磁盘上只有 DPAPI 密文）',
  session: '来自这次会话里粘贴的（只在引擎内存里，引擎退出即失效）',
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
          <span className="text-studio-ink-2">现在能用的是「模型接入」这一段：</span>
          配密钥、实时拉模型清单、发一句话测连通。
          <span className="text-studio-ink-2">「用一句话改图」还没做</span>
          —— 引擎侧的操作计划与四道闸门已就绪，界面还在做，所以这里先不承诺。
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
      </main>
    </div>
  );
}
