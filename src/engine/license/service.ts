/**
 * 商业版许可服务（架构预留）。
 *
 * 背景：2026-10-21 裁定商业模式为「开源 + 商业版双轨」。
 * 开源版功能全开；商业版通过本模块的门控提供企业特性
 * （多用户 / 私有部署 / 技术支持 / 长期维护等）。
 *
 * 设计原则（沿用 KeyProvider 的做法）：
 *  1. **引擎不感知许可**，只暴露"当前具备哪些能力"的查询接口
 *  2. 商业版的门控发生在**服务端**，前端拿到的只是能力清单
 *  3. 许可证是**离线文件**（不依赖联网激活）——目标用户在政务/内网环境
 *  4. 开源版实现恒为"全部能力可用"，不产生任何授权限制
 *
 * 本文件只定义契约与开源版实现，商业版实现另置。
 */

export type Capability =
  | 'core.edit'
  | 'core.export-image'
  | 'core.export-pdf'
  | 'core.export-report'
  | 'ai.assistant'
  | 'ai.byok'
  | 'ai.managed-keys'
  | 'project.multiuser'
  | 'project.history'
  | 'project.audit-export'
  | 'deploy.onprem'
  | 'support.sla';

export interface LicenseInfo {
  /** 许可证模式 */
  readonly edition: 'community' | 'commercial' | 'trial';
  readonly licensee?: string;
  /** 授权到期时间（ISO），社区版为 undefined */
  readonly expiresAt?: string;
  /** 当前可用能力清单 */
  readonly capabilities: readonly Capability[];
  /** 许可证指纹（用于审计与防篡改），社区版为 undefined */
  readonly fingerprint?: string;
}

export interface LicenseService {
  readonly mode: 'community' | 'commercial';
  /** 读取当前许可证；未安装商业许可证时返回社区版信息 */
  current(): Promise<LicenseInfo>;
  /** 某能力是否可用 */
  can(capability: Capability): Promise<boolean>;
  /** 安装/更新商业许可证（离线许可文件） */
  install(licenseFile: Uint8Array): Promise<LicenseInfo>;
  /** 移除商业许可证，回到社区版 */
  remove(): Promise<LicenseInfo>;
}

/** 社区版（开源）：全部能力开放，不做任何限制。 */
export const COMMUNITY_CAPABILITIES: readonly Capability[] = [
  'core.edit',
  'core.export-image',
  'core.export-pdf',
  'core.export-report',
  'ai.assistant',
  'ai.byok',
  'ai.managed-keys',
  'project.multiuser',
  'project.history',
  'project.audit-export',
  'deploy.onprem',
  'support.sla',
];

/** 开源版实现：恒为全能力，永不限制。 */
export class CommunityLicenseService implements LicenseService {
  readonly mode = 'community' as const;

  async current(): Promise<LicenseInfo> {
    return {
      edition: 'community',
      capabilities: COMMUNITY_CAPABILITIES,
    };
  }

  async can(capability: Capability): Promise<boolean> {
    return COMMUNITY_CAPABILITIES.includes(capability);
  }

  async install(): Promise<LicenseInfo> {
    throw new Error('开源版不支持安装商业许可证');
  }

  async remove(): Promise<LicenseInfo> {
    return this.current();
  }
}

/**
 * 商业许可证文件格式（v1）。
 *
 * 刻意设计成**自包含 + 可离线校验**，不依赖联网激活：
 *   - `payload`：业务信息（被授权人、能力清单、到期时间）
 *   - `signature`：用厂商私钥对 payload 的签名
 *   - 公钥内置在商业版实现里，公钥不需要联网分发
 *
 * 格式（JSON，便于人工排查与未来扩展）：
 * ```json
 * {
 *   "version": 1,
 *   "payload": { "licensee": "...", "capabilities": ["..."], "expiresAt": "..." },
 *   "signature": "<base64>"
 * }
 * ```
 */
export interface LicenseFileV1 {
  readonly version: 1;
  readonly payload: {
    readonly licensee: string;
    readonly capabilities: readonly Capability[];
    readonly expiresAt?: string;
  };
  readonly signature: string;
}

export function parseLicenseFile(bytes: Uint8Array): LicenseFileV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('许可证文件不是合法的 JSON');
  }
  const file = parsed as Partial<LicenseFileV1>;
  if (file.version !== 1 || !file.payload || typeof file.signature !== 'string') {
    throw new Error('许可证文件格式不正确（需要 version=1、payload、signature）');
  }
  return file as LicenseFileV1;
}
