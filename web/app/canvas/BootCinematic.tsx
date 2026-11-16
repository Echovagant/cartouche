'use client';

/**
 * 启动屏（v2 cinematic 移植）。
 *
 * 视觉语言来自 2026-11-15 的 preloader v2 demo（draft 工作区 preloader/demo.html）：
 * 三位独立滚轮数字（老虎机式）、文字 mask 揭示/换词、双幕布色块退场、
 * 内容页错峰入场。配色与品牌换成图签自己的：暖黑台面 + 测绘墨绿（深底亮档
 * accent-lit），**不保留** demo 的蓝紫 —— 设计系统明令禁止"AI 蓝紫"。
 *
 * 逻辑层与 demo 一致（已在那次会话实测过的坑全在此避开）：
 *   - 进度引擎**按时间增量**（帧率无关，dt 钳制 250ms）——每帧增量在低帧率
 *     环境会让进度失控（IAB 后台标签 rAF ~1fps 的教训）；
   - 结束补间/退场**必须有 setTimeout 兜底**，rAF 在节流环境会停摆，
 *     只靠它会把用户卡死在加载屏；
 *   - 回头客 12h 内自动加速（首访完整 ~2-4s，回头 ~1s，2026-11-16 裁定）；
 *   - prefers-reduced-motion 全量降级。
 *
 * 进度是"半真"的：结束时机由引擎健康检查（真实信号）驱动，健康检查 5 秒轮询
 * 直到 ready —— ready 一到立刻收尾；没到就按"突发-停顿-爬行"的节奏演，
 * 12s 兜底强制揭幕（引擎离线时露出的是 MapCanvas 的提示层，不白屏）。
 * 状态词是启动期真实并行发生的三件事（连引擎 / 装地图内核 / 准备图面）。
 */
import { useEffect, useRef } from 'react';
import {
  applyBootAttr,
  readBootAnimationMode,
  setBootAnimationMode,
  type BootAnimationMode,
} from './project/useBootAnimation';
import {
  fetchEngineSettings,
  isEngineSettingsSynced,
  markEngineSettingsSynced,
} from './project/engineSettings';
import {
  prefersReducedMotion,
  setReduceMotionOverride,
} from './project/useReducedMotion';

const STATUSES = ['连接图签引擎', '装载地图内核', '准备图面'] as const;
const READY_WORD = '就绪';
const LS_KEY = 'cartouche.boot.v1';
const MIN_DISPLAY = 1600;
const FAST_MIN_DISPLAY = 1000;
const MAX_DURATION = 12000;
/**
 * rAF 保险线：引擎还没就绪且进度引擎失速（后台标签节流）时，
 * 到这个时间点就强制收场。正常路径 ~2.4s 就走完了，这里只是"别卡死"的兜底。
 */
const FORCE_EXIT_AT = 4500;
const REVISIT_WINDOW = 12 * 3600 * 1000;

export function BootCinematic({
  engineReady,
  onReveal,
}: {
  /** 引擎健康检查通过（真实结束信号）：一到就收尾，不等模拟进度演完 */
  engineReady: boolean;
  /** 幕布开始揭开的瞬间：CanvasBoot（面板滑入/图纸显影）从这里接力 */
  onReveal: () => void;
}) {
  const screenRef = useRef<HTMLDivElement | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  const statusTextRef = useRef<HTMLElement | null>(null);
  const statusRvRef = useRef<HTMLDivElement | null>(null);
  const startedRef = useRef(false);
  const engineReadyRef = useRef(engineReady);
  engineReadyRef.current = engineReady;
  const onRevealRef = useRef(onReveal);
  onRevealRef.current = onReveal;

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // 定时器挂到外层：effect 主体现在是异步的（要先问引擎），cleanup 才清得掉它们
    let readyTimer = 0;
    let statusTimer = 0;

    /**
     * 决定这次播不播、怎么播。
     *
     * 引擎是**权威**（机器级设置，换浏览器、换访问地址都一致）；
     * localStorage 是**缓存**（负责首帧零闪屏）。
     *
     * **总是问一次引擎**（本机毫秒级响应，感知不到；引擎没起则超时回落本地）：
     * 设置可能在另一个浏览器里被改过，只信本地缓存会读到旧值
     * （2026-11-16 实测：引擎把减弱动效关掉后，本地缓存还停在"减弱"，
     *   启动屏就一直不播）。
     *
     * 一次请求拿两件事：播不播（加载动画）+ 减不减弱动效。
     */
    const decide = async (): Promise<{ mode: BootAnimationMode; reduced: boolean }> => {
      const settings = await fetchEngineSettings(isEngineSettingsSynced() ? 500 : 800);
      if (!settings) {
        return { mode: readBootAnimationMode(), reduced: prefersReducedMotion() };
      }
      const mode = settings.bootAnimation ?? readBootAnimationMode();
      let reduced = prefersReducedMotion();
      if (typeof settings.reduceMotion === 'boolean') {
        reduced = settings.reduceMotion;
        setReduceMotionOverride(settings.reduceMotion);
      }
      setBootAnimationMode(mode);
      markEngineSettingsSynced();
      return { mode, reduced };
    };

    const run = async (): Promise<void> => {
      const { mode, reduced } = await decide();
      // 问完了：撤掉"待定"标记（首帧期间启动屏是藏着的，现在按结论亮相）
      applyBootAttr(mode, false);

      // 「从不播放」或「减弱动效」：启动屏本身就是动效 —— 两种情况都不播，
      // 直接把接力棒交给工作台。
      // 首帧的隐藏由 layout 的内联脚本 + CSS 完成（html[data-boot='off']），
      // 所以这里不会看到任何闪屏 —— 只是不播动画而已。
      if (mode === 'never' || reduced) {
        screenRef.current?.style.setProperty('display', 'none');
        document.getElementById('boot-curtain-1')?.style.setProperty('display', 'none');
        document.getElementById('boot-curtain-2')?.style.setProperty('display', 'none');
        onRevealRef.current();
        return;
      }

    const screen = screenRef.current;
    const bar = barRef.current;
    const statusText = statusTextRef.current;
    // 状态行的 mask 容器：优先用 ref，缺了就从文字元素的父级推 ——
    // ⚠️ 2026-11-16 实测事故：这里曾用 `statusRvRef.current` 直接判空早退，
    //    而那个 ref 忘了在 JSX 里挂 → 整个 effect 第一行就返回，
    //    启动屏**从未运行**，用户看到的是静态导出留下的浮空元素。
    //    现在任何单个 ref 缺失都不再让整段动画静默失效。
    const statusRv = statusRvRef.current ?? statusText?.parentElement ?? null;
    if (!screen || !bar || !statusText || !statusRv) return;
    // 提升函数声明（done/exit）不继承 null 收窄：收窄后的引用固定下来再用
    const root = screen;
    const odoCols = Array.from(screen.querySelectorAll<HTMLElement>('.boot-odo-col'));

    /* 回头客判定：12h 内来过 → 加速模式（进度 ×3、最短停留压到 1s）。
       「总是播放」模式下不做这个加速 —— 用户要的就是每次都完整看一遍。 */
    let fast = false;
    if (mode !== 'always') {
      try {
        const last = Number(localStorage.getItem(LS_KEY) || 0);
        fast = last > 0 && Date.now() - last < REVISIT_WINDOW;
      } catch {
        /* localStorage 不可用就当首访 */
      }
    }
    const minDisplay = fast ? FAST_MIN_DISPLAY : MIN_DISPLAY;
    const speed = fast ? 3 : 1;

    /* ---- 滚轮数字：每列 translateY 到目标数字，CSS transition 自动滚 ---- */
    const setOdo = (v: number): void => {
      const s = String(Math.min(100, Math.max(0, Math.floor(v)))).padStart(3, '0');
      odoCols.forEach((col, i) => {
        const stack = col.firstElementChild as HTMLElement | null;
        stack?.style.setProperty('transform', `translateY(${-(Number(s[i]) * 0.82)}em)`);
      });
    };

    /* ---- logo 顺序描边 ---- */
    const shapes = screen.querySelectorAll<SVGGeometryElement>('.boot-logo svg rect, .boot-logo svg path, .boot-logo svg circle');
    if (!reduced) {
      let i = 0;
      shapes.forEach((el) => {
        try {
          const len = el.getTotalLength();
          el.style.strokeDasharray = `${len} ${len}`;
          el.style.strokeDashoffset = `${len}`;
          el.style.transition = `stroke-dashoffset 1s cubic-bezier(.4,0,.2,1) ${i * 0.14 + 0.15}s`;
        } catch {
          /* getTotalLength 不可用就跳过描边，logo 原样显示 */
        }
        i += 1;
      });
      requestAnimationFrame(() =>
        shapes.forEach((el) => el.style.setProperty('stroke-dashoffset', '0')),
      );
    }

    /* ---- brand / status mask 揭示（错峰） ---- */
    screen.querySelectorAll<HTMLElement>('.boot-rv').forEach((el, i) => {
      window.setTimeout(() => el.classList.add('boot-in'), 120 + i * 140);
    });

    /* ---- 状态词 mask 换词：滚出上 → 换词 → 滚入下 ---- */
    const setStatus = (word: string): void => {
      if (reduced) {
        statusText.textContent = word;
        return;
      }
      window.clearTimeout(statusTimer);
      statusRv.classList.remove('boot-in');
      statusTimer = window.setTimeout(() => {
        statusText.textContent = word;
        statusRv.classList.add('boot-in');
      }, 380);
    };

    /* ---- 进度引擎：突发-停顿-爬行（按时间增量，帧率无关） ---- */
    let p = 0;
    let doneAt = false;
    let finished = false;
    let stallUntil = 0;
    const startedAt = performance.now();
    let lastNow = startedAt;

    const tick = (now: number): void => {
      if (finished) return;
      const dt = Math.min(250, now - lastNow);
      lastNow = now;
      const elapsed = now - startedAt;

      if (!doneAt) {
        const idx = Math.min(STATUSES.length - 1, Math.floor(elapsed / 900));
        const word: string = STATUSES[idx] ?? '连接图签引擎';
        if (statusText.textContent !== word) {
          setStatus(word);
        }
        const cap = 92;
        if (p >= cap && now >= stallUntil) {
          done(); // 模拟进度到顶：真实信号还没来也收尾，不吊人（demo 实测教训）
        } else if (now >= stallUntil) {
          if (Math.random() < (dt / 1000) * 0.3) stallUntil = now + 300 + Math.random() * 600;
          const decay = p < 88 ? 1 : Math.max(0.12, (94 - p) / 94);
          const inc = 30 * speed * (0.4 + Math.random() * 1.4) * decay * (dt / 1000);
          p = Math.min(cap, p + inc);
        }
      }
      setOdo(p);
      bar.style.transform = `scaleX(${p / 100})`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);

    /* ---- 结束：rAF 补间数字，setTimeout 兜底强制走完退场 ---- */
    function done(): void {
      if (finished || doneAt) return;
      doneAt = true;
      setStatus(READY_WORD);
      const from = p;
      const wait = Math.max(0, minDisplay - (performance.now() - startedAt));
      const DUR = reduced ? 200 : 700;
      const t0 = performance.now() + wait;
      const step = (now: number): void => {
        if (finished) return;
        const t = Math.min(1, Math.max(0, (now - t0) / DUR));
        p = from + (100 - from) * (1 - Math.pow(1 - t, 3));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.setTimeout(() => {
        if (!finished) {
          p = 100;
          exit();
        }
      }, wait + DUR + 80);
    }

    /* ---- 三段退场：数字滚出 → 双幕布盖住 → 幕布收缩露出工作台 ---- */
    function exit(): void {
      finished = true;
      try {
        localStorage.setItem(LS_KEY, String(Date.now()));
      } catch {
        /* 存不了就不记回头客 */
      }
      const curtain1 = document.getElementById('boot-curtain-1');
      const curtain2 = document.getElementById('boot-curtain-2');
      if (reduced || !curtain1 || !curtain2) {
        root.style.display = 'none';
        curtain1?.style.setProperty('display', 'none');
        curtain2?.style.setProperty('display', 'none');
        onRevealRef.current();
        return;
      }
      root.classList.add('boot-out'); // 1) 滚出
      window.setTimeout(() => curtain1.classList.add('boot-up'), 420); // 2) 幕布升起
      window.setTimeout(() => curtain2.classList.add('boot-up'), 580);
      window.setTimeout(() => {
        root.style.display = 'none'; // 盖满后撤掉启动屏
      }, 1350);
      window.setTimeout(() => {
        // 3) 幕布向上收缩：工作台从这里开始错峰入场（CanvasBoot 接力）
        curtain1.classList.add('boot-down');
        curtain2.classList.add('boot-down');
        onRevealRef.current();
      }, 1500);
      window.setTimeout(() => {
        curtain1.style.display = 'none';
        curtain2.style.display = 'none';
      }, 2400);
    }

    // 真实信号：引擎健康检查 ready → 立刻收尾（比模拟进度快就按它的来）
    if (engineReadyRef.current) {
      done();
      return;
    }
    readyTimer = window.setInterval(() => {
      if (finished) return;
      if (engineReadyRef.current) {
        done();
        return;
      }
      // ⚠️ rAF 保险：后台标签会把 rAF 节流到 ~1fps 甚至停摆，进度引擎随之失速。
      //    引擎没就绪时，超过 FORCE_EXIT_AT 就**按时间**强制收场 ——
      //    宁可动画短一点，也不能让人对着一屏残骸等 12 秒。
      if (performance.now() - startedAt > FORCE_EXIT_AT) done();
    }, 300);
    window.setTimeout(done, MAX_DURATION); // 兜底：引擎离线也不把人卡在加载屏
    };

    void run();

    return () => {
      window.clearInterval(readyTimer);
      window.clearTimeout(statusTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 编排器只跑一次，props 经 ref 读最新值
  }, []);

  return (
    <>
      <div
        ref={screenRef}
        className="boot-screen"
        role="status"
        aria-live="polite"
        aria-label="图签 Cartouche 正在启动"
      >
        <div className="boot-vignette" aria-hidden="true" />
        <div className="boot-logo" aria-hidden="true">
          <svg viewBox="0 0 120 72" width="120" height="72" fill="none" strokeWidth="2.5" strokeLinecap="round">
            {/* 图签母题：图框（外框 + 内框）+ 指北针 + 定位点 */}
            <rect x="14" y="10" width="92" height="52" rx="2" />
            <rect x="21" y="17" width="78" height="38" rx="1" />
            <path d="M60 45 L66 31 L60 34 L54 31 Z" />
            <circle cx="60" cy="41" r="2" />
          </svg>
        </div>

        <div className="boot-odo-wrap">
          <div className="boot-brand boot-rv">
            <span>CARTOUCHE · 图签</span>
          </div>
          <div className="boot-odo" aria-label="启动进度">
            {[0, 1, 2].map((col) => (
              <div className="boot-odo-col" key={col}>
                <div className="boot-odo-stack">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
                    <span key={n}>{n}</span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="boot-status">
          <div className="boot-rv boot-in" ref={statusRvRef}>
            <b ref={statusTextRef}>{STATUSES[0]}</b>
          </div>
        </div>

        <div className="boot-bar" aria-hidden="true">
          <div className="boot-bar-fill" ref={barRef} />
        </div>
      </div>

      {/* 双幕布：盖过启动屏，收缩时露出工作台 */}
      <div className="boot-curtain" id="boot-curtain-1" aria-hidden="true" />
      <div className="boot-curtain" id="boot-curtain-2" aria-hidden="true" />
    </>
  );
}
