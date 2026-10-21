import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { CommandStack } = await import(
  pathToFileURL(join(root, 'src', 'engine', 'undo', 'command-stack.ts')).href
);

/** 记录执行顺序的命令，用于断言真实调用了 execute/undo */
function fakeCommand(label, log) {
  return {
    label,
    execute: async () => {
      log.push(`do:${label}`);
    },
    undo: async () => {
      log.push(`undo:${label}`);
    },
  };
}

test('空栈不能撤销也不能重做', () => {
  const stack = new CommandStack();
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, false);
  assert.equal(stack.undoLabel, null);
  assert.equal(stack.redoLabel, null);
});

test('执行命令后可以撤销，命令被真实执行过', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  assert.deepEqual(log, ['do:A']);
  assert.equal(stack.canUndo, true);
  assert.equal(stack.undoLabel, 'A');

  await stack.undo();
  assert.deepEqual(log, ['do:A', 'undo:A']);
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, true);
  assert.equal(stack.redoLabel, 'A');
});

test('撤销后可以重做，状态回到已执行', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.undo();
  await stack.redo();
  assert.deepEqual(log, ['do:A', 'undo:A', 'do:A']);
  assert.equal(stack.canUndo, true);
  assert.equal(stack.canRedo, false);
});

test('执行新命令会清空重做栈', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.undo();
  assert.equal(stack.canRedo, true);

  await stack.execute(fakeCommand('B', log));
  assert.equal(stack.canRedo, false, '执行新命令后不应还能重做旧命令');
  assert.equal(stack.undoLabel, 'B');
  assert.deepEqual(log, ['do:A', 'undo:A', 'do:B']);
});

test('多次执行按后进先出撤销', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.execute(fakeCommand('B', log));
  await stack.execute(fakeCommand('C', log));

  await stack.undo();
  await stack.undo();
  assert.deepEqual(log, ['do:A', 'do:B', 'do:C', 'undo:C', 'undo:B']);
  assert.equal(stack.undoLabel, 'A');
  assert.equal(stack.redoLabel, 'B');
});

test('撤销到底后不能再撤销', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.undo();
  await stack.undo();
  assert.deepEqual(log, ['do:A', 'undo:A']);
  assert.equal(stack.canUndo, false);
});

test('重做到底后不能再重做', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.undo();
  await stack.redo();
  await stack.redo();
  assert.deepEqual(log, ['do:A', 'undo:A', 'do:A']);
  assert.equal(stack.canRedo, false);
});

test('命令执行失败时不入栈', async () => {
  const stack = new CommandStack();
  const failing = {
    label: 'X',
    execute: async () => {
      throw new Error('写回失败');
    },
    undo: async () => {},
  };
  await assert.rejects(() => stack.execute(failing), /写回失败/);
  assert.equal(stack.canUndo, false, '失败的命令不应进入历史');
});

test('命令撤销失败时保持栈状态不变（不吞掉异常）', async () => {
  const stack = new CommandStack();
  const bad = {
    label: 'Y',
    execute: async () => {},
    undo: async () => {
      throw new Error('撤销失败');
    },
  };
  await stack.execute(bad);
  await assert.rejects(() => stack.undo(), /撤销失败/);
  assert.equal(stack.canUndo, true, '撤销失败后命令仍应留在历史里，便于重试');
});

test('clear 清空历史', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.execute(fakeCommand('B', log));
  stack.clear();
  assert.equal(stack.canUndo, false);
  assert.equal(stack.canRedo, false);
  assert.equal(stack.size, 0);
});

test('size 反映未撤销命令数', async () => {
  const log = [];
  const stack = new CommandStack();
  await stack.execute(fakeCommand('A', log));
  await stack.execute(fakeCommand('B', log));
  assert.equal(stack.size, 2);
  await stack.undo();
  assert.equal(stack.size, 1);
});
