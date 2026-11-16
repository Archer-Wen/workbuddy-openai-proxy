// 原子写回归测试。
//
// 背景：所有状态文件（config / auth / pool / usage）原先都用 writeFileSync 直接覆盖。
// 它不是原子的 —— 先截断再写入，中途被杀就留下半截 JSON。
// 而这些文件读不出来时一律「视作空」：半截池文件意味着所有账号凭空消失，
// 半截 config.json 意味着用户配置被清空。
import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { writeJsonAtomic } from '../src/util.mjs';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-atomic-'));
const tmpFile = (name = 'x.json') => path.join(tmpDir, name);

beforeEach(() => {
  for (const f of fs.readdirSync(tmpDir)) fs.rmSync(path.join(tmpDir, f), { recursive: true, force: true });
});
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

describe('writeJsonAtomic：内容与格式', () => {
  test('写出可被 JSON.parse 的完整内容，带结尾换行', () => {
    const f = tmpFile();
    writeJsonAtomic(f, { a: 1, b: [2, 3] });
    const text = fs.readFileSync(f, 'utf8');
    assert.deepEqual(JSON.parse(text), { a: 1, b: [2, 3] });
    assert.ok(text.endsWith('\n'), '保留结尾换行，避免与手改文件产生无谓 diff');
    assert.equal(text, `${JSON.stringify({ a: 1, b: [2, 3] }, null, 2)}\n`);
  });

  test('覆盖已有文件时内容完全替换', () => {
    const f = tmpFile();
    writeJsonAtomic(f, { big: 'x'.repeat(1000) });
    writeJsonAtomic(f, { small: 1 });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { small: 1 });
  });
});

describe('writeJsonAtomic：不留下临时文件', () => {
  test('成功后目录里只有目标文件', () => {
    writeJsonAtomic(tmpFile('a.json'), { ok: true });
    assert.deepEqual(fs.readdirSync(tmpDir), ['a.json']);
  });

  test('写入失败时不残留临时文件', () => {
    // 让 JSON.stringify 抛错（BigInt 不能序列化），模拟写入前的失败
    const f = tmpFile('b.json');
    assert.throws(() => writeJsonAtomic(f, { n: 1n }));
    assert.equal(fs.existsSync(f), false, '失败不该创建目标文件');
    assert.deepEqual(fs.readdirSync(tmpDir), [], '也不该残留临时文件');
  });
});

describe('writeJsonAtomic：权限位在创建时就生效', () => {
  test('mode 0600 的凭证文件不可被同机其他用户读取', { skip: process.platform === 'win32' }, () => {
    const f = tmpFile('secret.json');
    writeJsonAtomic(f, { accessToken: 't' }, { mode: 0o600 });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  });

  test('Windows 上至少能正常写出（权限位由 ACL 决定，不做 POSIX 断言）', () => {
    const f = tmpFile('win.json');
    writeJsonAtomic(f, { accessToken: 't' }, { mode: 0o600 });
    assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { accessToken: 't' });
  });

  test('覆盖已有 0600 文件后权限不回退', { skip: process.platform === 'win32' }, () => {
    const f = tmpFile('perm.json');
    writeJsonAtomic(f, { v: 1 }, { mode: 0o600 });
    writeJsonAtomic(f, { v: 2 }, { mode: 0o600 });
    assert.equal(fs.statSync(f).mode & 0o777, 0o600, 'rename 后仍应是 0600');
  });
});
