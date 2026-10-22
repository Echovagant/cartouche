/**
 * 校验清单：把"一项检查 → 通过 / 失败"记下来，最后统一决定退出码。
 *
 * 为什么单独抽出来：脚本里 print 一个 ●/■ 很容易，但**忘了让失败影响退出码**，
 * 就等于没设门禁——CI 会一直绿，哪怕检查项早就挂了。
 *
 * 2026-10-22 之前 `npm run fixture` 就是这样：13 项检查一项不落地打印出来，
 * 却从不以非零码退出，于是"样本生成与写回往返校验"这道门禁形同虚设。
 * 现在由 finish() 统一把失败项变成 exitCode = 1。
 */

/**
 * @param {object} [options]
 * @param {string} [options.title]   汇总标题
 * @param {string} [options.okMark]   通过标记
 * @param {string} [options.badMark]  失败标记
 * @param {string} [options.dim]      次要信息前缀（ANSI）
 * @param {string} [options.reset]    ANSI 复位
 * @param {string[]} [options.hints]  失败时附带的排查提示
 */
export function createChecklist(options = {}) {
  const {
    title = '校验',
    okMark = '●',
    badMark = '■',
    dim = '',
    reset = '',
    hints = [],
  } = options;

  const results = [];

  return {
    results,

    /** 记录一项检查并打印一行；返回是否通过 */
    add(name, ok, detail = '') {
      const passed = Boolean(ok);
      results.push({ name, ok: passed, detail });
      console.log(`  ${passed ? okMark : badMark} ${name.padEnd(36, ' ')}${dim}${detail}${reset}`);
      return passed;
    },

    get total() { return results.length; },
    get passed() { return results.filter((r) => r.ok); },
    get failed() { return results.filter((r) => !r.ok); },

    /**
     * 打印汇总并决定退出码：有失败项就置 exitCode = 1。
     * 返回是否全部通过（便于测试断言）。
     */
    finish() {
      const failed = this.failed;
      if (failed.length === 0) {
        console.log(`\n  ${okMark} ${title}：${this.total} 项全部通过\n`);
        return true;
      }
      console.log(`\n  ${badMark} ${title}：${this.total} 项中 ${failed.length} 项未通过`);
      for (const f of failed) {
        console.log(`    · ${f.name}${f.detail ? `  ${dim}${f.detail}${reset}` : ''}`);
      }
      for (const h of hints) {
        console.log(`    ${dim}${h}${reset}`);
      }
      console.log('');
      // 不调 process.exit()：让事件循环自然排空，避免 Windows 上强退触发 libuv 断言
      process.exitCode = 1;
      return false;
    },
  };
}
