'use client';

/**
 * 水合后再抹几次地址栏里的访问令牌。
 *
 * 为什么不在 engine-auth 模块加载时一次搞定：实测 Next 的水合会把初始 URL
 * （含 `#t=…`）写回地址栏，模块加载时那次 replaceState 会被覆盖。
 * 这里在 hydrate 之后补几次，既不影响首帧取令牌，也不让令牌留在地址栏。
 */
import { useEffect } from 'react';
import { stripTokenFromAddress } from './engine-auth';

export function TokenBoot() {
  useEffect(() => {
    stripTokenFromAddress();
    const timers = [0, 300, 1500].map((ms) => window.setTimeout(stripTokenFromAddress, ms));
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, []);
  return null;
}
