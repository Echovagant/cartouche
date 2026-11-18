/**
 * 模型端点地址的协议护栏。
 *
 * 为什么单独一个文件：`llm.ts` 与 `llm-plan.ts` 都要用，
 * 放进任何一边都会形成循环依赖。
 *
 * 规则只有一条：**只允许 https://；回环地址允许 http://**。
 * 自定义端点如果是 http:// 且不在本机，密钥与图层元数据会明文走局域网，
 * 这类配置必须在保存时就拒绝，而不是等到发送时才提醒。
 */

/** 用户填了一个明文或非法端点 */
export class UnsafeEndpointError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafeEndpointError';
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * 校验并返回可用的端点地址。
 *
 * @throws {UnsafeEndpointError} 协议不是 https，且主机不是回环地址
 */
export function assertSafeLlmBaseUrl(raw: string): string {
  const text = raw.trim();
  if (!text) throw new UnsafeEndpointError('端点地址不能为空。');

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeEndpointError('端点地址不是合法 URL，例如应为 https://api.example.com/v1。');
  }

  if (url.protocol === 'https:') return text;

  const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  if (url.protocol === 'http:' && loopback) return text;

  throw new UnsafeEndpointError(
    '自定义端点必须是 https://；只有本机回环地址（127.0.0.1 / localhost）允许 http://。' +
      '用 http:// 连外部地址会让密钥与图层信息明文经过局域网。',
  );
}
