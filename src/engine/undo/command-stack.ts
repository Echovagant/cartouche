/**
 * 撤销 / 重做命令栈。
 *
 * 设计要点：
 *  - 命令自己负责 execute / undo，栈只管顺序
 *  - 执行失败 → 不入栈（历史里不留半截状态）
 *  - 撤销失败 → 命令留在原位（用户可重试），不吞异常
 *  - 重做按"原始顺序"回放：先撤销 C 再撤销 B，重做时应先做 B
 */
export interface Command {
  readonly label: string;
  execute(): Promise<void>;
  undo(): Promise<void>;
}

/**
 * 撤销 / 重做栈。
 *
 * 三条不变量：
 *  - 执行失败 → 不入栈（历史里不留半截状态）
 *  - 撤销失败 → 命令留在原位（用户可重试），异常不吞
 *  - 重做按**原始顺序**回放：先撤 C 再撤 B，重做时先做 B
 */
export class CommandStack {
  /** 尚未撤销的命令，末尾为最近执行的 */
  #undo: Command[] = [];
  /** 已撤销、可重做的命令，队首为下一个要重做的 */
  #redo: Command[] = [];

/** 有没有可撤销的命令。 */
  get canUndo(): boolean {
    return this.#undo.length > 0;
  }

/** 有没有可重做的命令。 */
  get canRedo(): boolean {
    return this.#redo.length > 0;
  }

/** 最近一步的名字（给"撤销 XXX"按钮用）；没有则 null。 */
  get undoLabel(): string | null {
    return this.#undo[this.#undo.length - 1]?.label ?? null;
  }

/** 下一步要重做的名字；没有则 null。 */
  get redoLabel(): string | null {
    return this.#redo[0]?.label ?? null;
  }

/** 可撤销的命令条数。 */
  get size(): number {
    return this.#undo.length;
  }

  /** 执行一个新命令；执行成功后入栈，并清空重做栈 */
  async execute(command: Command): Promise<void> {
    await command.execute();
    this.#undo.push(command);
    this.#redo.length = 0;
  }

  /** 撤销最近一个命令 */
  async undo(): Promise<void> {
    const command = this.#undo[this.#undo.length - 1];
    if (!command) return;
    await command.undo(); // 失败会抛出，命令保持在原位
    this.#undo.pop();
    this.#redo.unshift(command);
  }

  /** 重做下一个命令（按原始执行顺序） */
  async redo(): Promise<void> {
    const command = this.#redo[0];
    if (!command) return;
    await command.execute(); // 失败会抛出，命令保持在重做栈里
    this.#redo.shift();
    this.#undo.push(command);
  }

/** 清空两个栈（换项目、重新加载时用）。 */
  clear(): void {
    this.#undo.length = 0;
    this.#redo.length = 0;
  }
}
