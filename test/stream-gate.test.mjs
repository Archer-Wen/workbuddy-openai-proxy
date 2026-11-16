// 上游流首帧判定测试。
//
// 这一组锁定 v1.5 的两个关键语义：
//   1. **首个有效帧才算成功** —— 上游会把额度类业务错误放在 HTTP 200 的流里下发，
//      旧实现一拿到响应头就 markSuccess，坏号被记成健康号，状态在「耗尽 ↔ 健康」间反复横跳；
//   2. **HTTP 400 不该动账号状态** —— 那是请求内容的问题，换号只白烧一个账号的失败计数。
//
// 用真实 http 服务而不是 mock fetch：这些行为发生在「读响应流」这一步，
// mock 掉 fetch 就把要测的东西一起 mock 掉了。
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-streamgate-'));
const { authPathFor, setConfigDir } = await import('../src/config.mjs');
const restoreConfigDir = setConfigDir(tmpDir);

const CRED = JSON.stringify({
  site: 'cn-cli',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsImV4cCI6NDEwMjQ0NDgwMH0.x',
  refreshToken: 'rt',
  expiresAt: Date.now() + 86400_000,
  uid: 'u1',
}, null, 2);

function useOwnDir() {
  setConfigDir(tmpDir);
  const f = authPathFor('cn-cli');
  fs.writeFileSync(f, CRED);
  const t = Date.now() / 1000 + 1;
  fs.utimesSync(f, t, t);
}

const { openChat, openChatRotating } = await import('../src/upstream.mjs');
const pool = await import('../src/pool.mjs');

const PORT = 19_000 + Math.floor(Math.random() * 2000);

/** 直接按合法 SSE 帧写出一段流。 */
const sse = (res, frames) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const f of frames) res.write(`data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`);
  res.end('data: [DONE]\n\n');
};

let mode = 'ok';
const server = http.createServer((req, res) => {
  if (req.url.includes('/auth/token/refresh')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ code: 0, data: { accessToken: 'refreshed', refreshToken: 'rt2', expiresIn: 3600 } }));
  }
  switch (mode) {
    // 额度错误只出现在 200 的流里，响应头是正常的
    case 'credit-in-stream':
      return sse(res, [{ code: 14018, msg: '积分已耗尽' }]);
    case 'busy-in-stream':
      return sse(res, [{ code: 14003, msg: '模型繁忙，请稍后再试' }]);
    case 'normal':
      return sse(res, [
        { id: 'c1', choices: [{ delta: { role: 'assistant' } }] },
        { id: 'c1', choices: [{ delta: { content: '你好' } }] },
        { id: 'c1', choices: [{ delta: {}, finish_reason: 'stop' }] },
      ]);
    case 'empty':
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      return res.end();
    case '400':
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 11133, msg: 'model_param_invalid: bad temperature' }));
    case 'policy':
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ code: 400, msg: 'content policy violation' }));
    default:
      res.writeHead(500);
      return res.end('{}');
  }
});

const mkCfg = () => ({
  defaultSite: 'cn-cli',
  timeouts: { headerMs: 3000, idleMs: 3000, metaMs: 3000 },
  defaultSystemPrompt: 'You are a helpful AI assistant.',
  stripFields: [],
  sites: {
    'cn-cli': {
      label: 'T', enabled: true,
      apiBase: `http://127.0.0.1:${PORT}`,
      origin: 'https://x.test', userAgent: 'T/1',
    },
  },
});

const body = { messages: [{ role: 'user', content: 'hi' }], model: 'glm-test' };

before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
beforeEach(() => {
  useOwnDir();
  mode = 'ok';
  pool.clearLegacyState();
});
after(async () => {
  await new Promise((r) => server.close(r));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('openChat：200 流里的业务错误要当失败', () => {
  test('额度错误帧 → ok:false 且标记为来自流', async () => {
    mode = 'credit-in-stream';
    const up = await openChat(mkCfg(), 'cn-cli', { ...body });
    assert.equal(up.ok, false);
    assert.equal(up.fromStream, true, '应标明错误来自流内部，便于上层区分');
    assert.equal(up.status, 14018, '状态位带上业务码');
    assert.match(up.text, /积分已耗尽/);
  });

  test('额度错误帧不能让账号「被判成功」', async () => {
    mode = 'credit-in-stream';
    // 先把这个号标记成耗尽，再看一次 200 错误帧会不会把它洗白
    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID, '之前欠费');
    assert.equal(pool.usableCount('cn-cli'), 0);

    const up = await openChat(mkCfg(), 'cn-cli', { ...body, });
    assert.equal(up.ok, false);
    assert.equal(pool.usableCount('cn-cli'), 0, '200 里的错误帧不能解禁账号');
  });

  test('繁忙帧不被当成欠费', async () => {
    mode = 'busy-in-stream';
    const up = await openChat(mkCfg(), 'cn-cli', { ...body });
    assert.equal(up.ok, false);
    // 通过旋转层观察：繁忙不换号（模型级问题，换号只是去排队）
    const r = await openChatRotating(mkCfg(), 'cn-cli', { ...body });
    assert.equal(r.up.ok, false);
    assert.equal(r.tried.length <= 1, true, '繁忙不该连续烧多个账号');
  });

  test('HTTP 200 但空流 → 失败（既不算成功也不算账号级失败）', async () => {
    mode = 'empty';
    const up = await openChat(mkCfg(), 'cn-cli', { ...body });
    assert.equal(up.ok, false);
    assert.equal(up.empty, true);
    assert.match(up.text, /空流/);
  });
});

describe('openChat：正常流仍是逐帧透传', () => {
  test('首帧不会被偷看吃掉', async () => {
    mode = 'normal';
    const up = await openChat(mkCfg(), 'cn-cli', { ...body });
    assert.equal(up.ok, true);
    const got = [];
    for await (const p of up.frames) got.push(JSON.parse(p));
    up.close();
    assert.equal(got.length, 3, '三帧都要吐出来，包括被偷看的第一帧');
    assert.equal(got[0].choices[0].delta.role, 'assistant');
    assert.equal(got[1].choices[0].delta.content, '你好');
  });

  test('拿到有效帧后账号才算成功（清零失败计数）', async () => {
    mode = 'normal';
    pool.markFailure('cn-cli', pool.DEFAULT_ACCOUNT_ID, { status: 500 });
    const 失败后 = pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(失败后.failCount, 1);

    const up = await openChat(mkCfg(), 'cn-cli', { ...body });
    assert.equal(up.ok, true);
    for await (const _ of up.frames) { /* 消费到底 */ }
    up.close();

    assert.equal(pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID).failCount, 0);
  });
});

describe('openChatRotating：只有账号级失败才换号', () => {
  test('HTTP 400 不换号、不冷却', async () => {
    mode = '400';
    const r = await openChatRotating(mkCfg(), 'cn-cli', { ...body });
    assert.equal(r.up.ok, false);
    assert.equal(r.up.status, 400);
    const a = pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    // 兼容模式下账号对象由旧凭证文件 + 内存态覆盖拼出，没被写过的字段是 undefined 而不是 null，
    // 所以这里断言「假值」而不是严格 null。
    assert.ok(!a.exhaustedAt, '400 不是额度问题');
    assert.ok(!a.cooldownUntil, '400 不该产生冷却');
    assert.equal(pool.isUsable(a), true, '账号仍然可用');
  });

  test('内容策略拒绝同样不换号', async () => {
    mode = 'policy';
    const r = await openChatRotating(mkCfg(), 'cn-cli', { ...body });
    assert.equal(r.up.ok, false);
    assert.equal(pool.isUsable(pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID)), true);
  });
});
