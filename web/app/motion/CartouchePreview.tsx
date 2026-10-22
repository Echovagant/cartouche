'use client';

/**
 * Hero 的制图视觉：一张正在被"扫描"的图幅。
 *
 * 全部是内联 SVG —— 不引外部图片，**离线可用、零网络请求**，
 * 而且比贴一张图库照片更贴产品本身（画的就是图签的图框、比例尺、图例）。
 */
export function CartouchePreview() {
  return (
    <svg
      viewBox="0 0 1440 760"
      className="h-full w-full"
      // 锚在**底部**：宽屏上 slice 会把上下裁掉一大截，
      // 锚底部才能保证图签框、比例尺这些"家具"始终留在画面里。
      preserveAspectRatio="xMidYMax slice"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#efe9dc" />
          <stop offset="55%" stopColor="#e6dfcd" />
          <stop offset="100%" stopColor="#ded5bf" />
        </linearGradient>
        <linearGradient id="parcel" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#2f6f5e" stopOpacity="0.20" />
          <stop offset="100%" stopColor="#2f6f5e" stopOpacity="0.05" />
        </linearGradient>
        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="#1c1a16" strokeOpacity="0.055" strokeWidth="1" />
        </pattern>
      </defs>

      <rect width="1440" height="760" fill="url(#sky)" />
      <rect width="1440" height="760" fill="url(#grid)" />

      {/* 等高线 */}
      <g fill="none" stroke="#1c1a16" strokeOpacity="0.13" strokeWidth="1.1">
        <path d="M-40 604C180 548 268 640 452 596s312-118 520-78 316 26 508-36" />
        <path d="M-40 556C188 500 280 592 462 548s308-114 512-74 312 24 506-38" />
        <path d="M-40 508C196 452 292 544 472 500s304-110 504-70 308 22 504-40" />
        <path d="M-40 460C204 404 304 496 482 452s300-106 496-66 304 20 502-42" />
        <path d="M-40 412C212 356 316 448 492 404s296-102 488-62 300 18 500-44" />
        <path d="M-40 364C220 308 328 400 502 356s292-98 480-58 296 16 498-46" />
        <path d="M-40 316C228 260 340 352 512 308s288-94 472-54 292 14 496-48" />
      </g>

      {/* 河流 */}
      <path
        d="M-20 250C260 214 400 330 640 300s380-142 620-108 260 92 300 84"
        fill="none"
        stroke="#4a463d"
        strokeOpacity="0.28"
        strokeWidth="2.4"
        strokeLinecap="round"
      />

      {/* 地块 */}
      <g>
        <path d="M470 392l232-26 30 178-244 20z" fill="url(#parcel)" stroke="#2f6f5e" strokeOpacity="0.5" strokeWidth="1.4" />
        <path d="M742 366l196-18 22 146-206 14z" fill="#a8874f" fillOpacity="0.12" stroke="#a8874f" strokeOpacity="0.55" strokeWidth="1.4" />
        <path d="M300 470l150-14 16 108-158 12z" fill="#2f6f5e" fillOpacity="0.08" stroke="#2f6f5e" strokeOpacity="0.32" strokeWidth="1.2" />
      </g>

      {/* 图框（cartouche） */}
      <g stroke="#1c1a16" strokeOpacity="0.3" fill="none">
        <rect x="36" y="36" width="1368" height="688" strokeWidth="1.4" />
        <rect x="48" y="48" width="1344" height="664" strokeWidth="0.7" />
      </g>

      {/* 标题栏 */}
      <g>
        <rect x="932" y="548" width="404" height="112" fill="#fcfaf5" fillOpacity="0.92" stroke="#1c1a16" strokeOpacity="0.32" />
        <line x1="932" y1="588" x2="1336" y2="588" stroke="#1c1a16" strokeOpacity="0.22" />
        <line x1="1132" y1="588" x2="1132" y2="660" stroke="#1c1a16" strokeOpacity="0.22" />
        <text x="952" y="576" fontFamily="ui-sans-serif, sans-serif" fontSize="19" fontWeight="600" fill="#1c1a16" fillOpacity="0.72">
          图签 Cartouche 出图
        </text>
        <text x="952" y="614" fontFamily="ui-monospace, monospace" fontSize="12" fill="#1c1a16" fillOpacity="0.42">
          2026-10-21 · 操作人 张三
        </text>
        <text x="952" y="646" fontFamily="ui-monospace, monospace" fontSize="12" fill="#1c1a16" fillOpacity="0.42">
          CGCS2000 / 3° 带
        </text>
      </g>

      {/* 比例尺 */}
      <g transform="translate(210 622)">
        <rect x="0" y="0" width="46" height="8" fill="#1c1a16" fillOpacity="0.72" />
        <rect x="46" y="0" width="46" height="8" fill="#fcfaf5" stroke="#1c1a16" strokeOpacity="0.72" />
        <rect x="92" y="0" width="46" height="8" fill="#1c1a16" fillOpacity="0.72" />
        <text x="0" y="26" fontFamily="ui-monospace, monospace" fontSize="12" fill="#1c1a16" fillOpacity="0.5">
          0
        </text>
        <text x="124" y="26" fontFamily="ui-monospace, monospace" fontSize="12" fill="#1c1a16" fillOpacity="0.5">
          150 m
        </text>
      </g>

      {/* 指北针：放在左侧中下方——锚底裁切时这块始终在画面里 */}
      <g transform="translate(120 452)">
        <circle r="34" fill="#fcfaf5" fillOpacity="0.62" stroke="#1c1a16" strokeOpacity="0.2" />
        <path d="M0-26L9 16 0 6-9 16z" fill="#1c1a16" fillOpacity="0.78" />
        <text x="-4" y="-38" fontFamily="ui-monospace, monospace" fontSize="13" fill="#1c1a16" fillOpacity="0.6">
          N
        </text>
      </g>

      {/* 扫描线：一直在图幅上走过 */}
      <g className="cartouche-sweep">
        <rect x="48" y="48" width="1344" height="3" fill="#2f6f5e" opacity="0.5" />
        <rect x="48" y="48" width="1344" height="46" fill="#2f6f5e" opacity="0.07" />
      </g>
    </svg>
  );
}
