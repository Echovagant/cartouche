/**
 * 把引擎的失败翻译成「人话 + 下一步」。
 *
 * 为什么单独一个文件：失败文案是这个工具里**最容易被写坏**的部分。
 * 同一件事散在三处（提议层、预演、执行），就会出现"提议失败"和"执行失败"
 * 各说各话，用户只能自己猜该干什么。收在一处之后：
 *
 *   - 每条文案都必须回答三件事：**出了什么事**、**为什么**、**我下一步该做什么**；
 *   - 单元测试可以逐条断言"这句话里有没有下一步"，不靠肉眼看界面；
 *   - 这个文件**不引 React**：它是纯函数，Node 直接 import 就能测。
 *
 * 密钥红线（与引擎侧 redactSecrets 呼应）：**任何**面向用户的文案里都不能出现密钥。
 * 引擎已经抹过一遍，但前端是最后一道关口 —— 它拿到的任何字符串都先过 redactKeyLike。
 */

/**
 * 失败的**类别**。
 *
 * 「连不上模型服务」与「密钥不对」必须分开说：前者查网络，后者换密钥，
 * 混成一句"出错了"等于让用户自己猜。
 */
export type PlanFailureKind =
  | 'not_configured'
  | 'key'
  | 'network'
  | 'bad_plan'
  | 'unsupported'
  | 'unknown';

export interface PlanFailure {
  readonly kind: PlanFailureKind;
  readonly message: string;
  /** 官方错误码（如 1004） */
  readonly code: number | null;
}

/** 提议层返回体里，分类用得到的那几个字段 */
export interface PlanFailurePayload {
  readonly error: string | null;
  readonly message: string | null;
  readonly code: number | null;
}

/** 一条面向用户的失败说明：结论 + 原因 + 下一步 */
export interface HumanFailure {
  /** 一句话结论（标题） */
  readonly title: string;
  /** 发生了什么（可带引擎的原始原因） */
  readonly detail: string;
  /** 用户下一步该做什么 */
  readonly next: string;
}

/**
 * 抹掉可能混进文案里的密钥。
 *
 * 引擎侧已经用 redactSecrets 抹过一遍，这里是**前端这一侧**的兜底：
 * 请求头、代理错误页、第三方 SDK 都可能把 Authorization 原样塞进异常消息，
 * 而这些消息最终会被人看见。
 *
 * 只抹"长得像密钥"的片段，不做全局乱替换 —— 把正常文字打成马赛克
 * 比漏掉一条更糟（用户会以为功能坏了）。
 */
export function redactKeyLike(text: string): string {
  if (!text) return '';
  return text
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '***REDACTED***')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '***REDACTED***')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/g, '$1***REDACTED***');
}

/** 把引擎给的原始原因收干净：去掉空行、限制长度、抹掉密钥 */
function clean(raw: string | null | undefined, max = 400): string {
  const text = redactKeyLike((raw ?? '').trim());
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把引擎返回的错误分类。
 *
 * 与引擎的 error 字段一一对应；官方把"密钥无效"报成 1004 / authorized_error 时，
 * 即便类别没对上也要认出来 —— 那是最常见的一种失败，认错了用户会白折腾。
 */
export function classifyPlanFailure(payload: PlanFailurePayload): PlanFailure {
  const message = clean(payload.message) || '提议失败';
  const code = payload.code ?? null;
  switch (payload.error) {
    case 'llm_not_configured':
      return { kind: 'not_configured', message, code };
    case 'llm_unauthorized':
      return { kind: 'key', message, code };
    case 'llm_unreachable':
      return { kind: 'network', message, code };
    case 'plan_schema_invalid':
    case 'plan_not_json':
      return { kind: 'bad_plan', message, code };
    case 'op_not_supported':
      return { kind: 'unsupported', message, code };
    default:
      if (code === 1004 || /authorized_error|invalid api key/i.test(message)) {
        return { kind: 'key', message, code };
      }
      return { kind: 'unknown', message, code };
  }
}

/**
 * 提议层失败的文案。
 *
 * 每一条都必须给出**可执行的下一步**，否则用户只能回头猜。
 */
export function describePlanFailure(failure: PlanFailure): HumanFailure {
  const reason = clean(failure.message);
  switch (failure.kind) {
    case 'not_configured':
      return {
        title: '还没配置模型密钥',
        detail: reason || '本机引擎没有可用的密钥，这次请求根本没发出去。',
        next: '回到第 1 步「密钥来源」粘贴一枚 API Key（只留在引擎内存里，引擎一关就没），再重试一次。',
      };
    case 'key':
      return {
        title: '模型服务拒绝了这枚密钥',
        detail: reason || '模型服务返回了鉴权失败。',
        next: '换一枚有效的 Key 再试；确认它属于当前这个接入点（国内版与国际版不是同一枚）。',
      };
    case 'network':
      return {
        title: '连不上模型服务',
        detail: reason || '本机引擎向模型服务发请求时网络中断了。',
        next: '先确认这台机器能出网（代理 / 防火墙），或换一个可访问的接入点，然后点「重试」。',
      };
    case 'bad_plan':
      return {
        title: '模型给的计划不合规矩',
        detail: reason || '模型回的内容不是一份合法的操作计划。',
        next: '把要求说得更具体一点（点名要改哪个图层、改成什么样）再试一次；急用就先在画布上用画笔、框选手工改。',
      };
    case 'unsupported':
      return {
        title: '这个操作引擎还没做',
        detail: reason || '模型提了一件事，但引擎目前实现不了。',
        next: '换一件引擎支持的操作，或等这一项做完再来。',
      };
    default:
      return {
        title: '提议失败',
        detail: reason || '引擎没有给出更具体的原因。',
        next: '点「重试」；反复失败就把上面的原因记下来，它决定该查网络还是该查密钥。',
      };
  }
}

/** 预演失败时给的文案 */
export function describePreviewFailure(input: {
  readonly op?: string | undefined;
  readonly index?: number | undefined;
  readonly message: string;
}): HumanFailure {
  const reason = clean(input.message);
  const where =
    typeof input.index === 'number'
      ? `第 ${input.index + 1} 条改动`
      : input.op
        ? `「${input.op}」这一步`
        : '这一步改动';

  // 引擎把"区域里一个像元都没变"也报成预演失败 —— 但它跟"算不出来"不是一回事：
  // 影响面算出来了，只是这块区域本来就已经是那样了。这种要给"0 像元"的说法，
  // 否则用户会以为是自己参数写错了。
  if (/一个像元都没改到|没有任何像素发生变化|没有像素发生变化/.test(reason)) {
    return describeZeroImpact({
      op: input.op,
      index: input.index,
      totalPixels: parseRasterSize(reason),
    });
  }

  return {
    title: `${where}算不出影响面`,
    detail: reason || '引擎没有给出具体原因。',
    next: '这次先不执行：确认目标文件还在项目里、改动区域落在影像范围内，然后重新提议一次。',
  };
}

/**
 * 从引擎的报错里捞出影像尺寸（"影像 40×30"）→ 总像元数。
 *
 * 拿不到就返回 0：宁可少一个数字，也不要显示错的数字。
 */
function parseRasterSize(reason: string): number {
  const m = reason.match(/影像\s*(\d+)\s*[×xX*]\s*(\d+)/);
  if (!m) return 0;
  const w = Number(m[1]);
  const h = Number(m[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h)) return 0;
  return Math.round(w * h);
}

/**
 * 执行失败时给的文案。
 *
 * 标题**不带 op 名**：界面在失败条目旁边已经把 op 显示出来了，
 * 再塞一遍就成了「raster.paint 「raster.paint」写不回去」。
 */
export function describeExecuteFailure(input: {
  readonly op?: string | undefined;
  readonly message: string;
}): HumanFailure {
  const reason = clean(input.message);
  // 文件被占用是最高频的写回失败：说清"关掉什么"，比说清"报了什么错"有用。
  if (/占用|permission denied|file is locked|being used by another process|EPERM|EBUSY|EACCES/i.test(reason)) {
    return {
      title: '文件正被别的程序占用，写不回去',
      detail: reason || '引擎读得到这个文件，但写回时被系统拒绝。',
      next: '关掉正在打开它的程序（在 ArcGIS Pro 里移除该图层，或关掉资源管理器预览窗口）后重新执行。原文件没有被改动。',
    };
  }
  if (/找不到|no such file|does not exist|not found/i.test(reason)) {
    return {
      title: '找不到要改的文件',
      detail: reason || '引擎在项目里没有找到这个文件。',
      next: '确认文件还在、路径与图层清单一致，然后在画布上重新载入项目再试。',
    };
  }
  if (/校验失败|checksum|hash/i.test(reason)) {
    return {
      title: '写回校验没通过',
      detail: reason || '引擎写完后回读校验对不上，为安全起见放弃了替换。',
      next: '这次原文件没有被改动。检查磁盘空间与项目目录权限后重试。',
    };
  }
  return {
    title: '没能写回磁盘',
    detail: reason || '引擎没有给出更具体的原因。',
    next: '确认项目目录可写、磁盘有空间，再执行一次。改动前的备份会留在原文件旁边。',
  };
}

/** 预演说"一个像元都没改到"时的文案 */
export function describeZeroImpact(input: {
  readonly op?: string | undefined;
  readonly index?: number | undefined;
  readonly totalPixels: number;
}): HumanFailure {
  const where =
    typeof input.index === 'number'
      ? `第 ${input.index + 1} 条改动`
      : input.op
        ? `「${input.op}」`
        : '这次改动';
  // 影像尺寸拿不到时就不写数字：写"整幅共 0 像元"比不写更糟
  const size =
    input.totalPixels > 0 ? `（整幅共 ${input.totalPixels.toLocaleString('zh-CN')} 像元）` : '';
  return {
    title: `${where}一个像元都没改到`,
    detail: `预演算出来影响像元是 0${size} —— 多半是区域落在影像之外、掩膜没盖住任何像元，或者那块区域本来就是这个颜色。`,
    next: '把要改的范围对齐到影像上（在画布上框选出一块范围，让模型照着改）再重新提议一次。',
  };
}

/** 一条预演结果里影响像元的最小字段 */
export interface PreviewLike {
  readonly op: string;
  readonly affectedPixels: number;
  readonly totalPixels: number;
}

/**
 * 找出"一个像元都没改到"的那几条。
 *
 * 这种改动**什么都不会发生**：引擎会把它判成失败，界面也不能给执行按钮 ——
 * 不然用户看到的还是「0 / 1,200 像元（0.0%）」，像是最轻松的一次改动。
 */
export function findZeroImpactOps(previews: readonly PreviewLike[]): number[] {
  return previews
    .map((p, index) => (p.affectedPixels === 0 ? index : -1))
    .filter((index) => index >= 0);
}
