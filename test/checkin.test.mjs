import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCheckinManager, queryCheckin, claimCheckin, supportsCheckin } from '../src/checkin.mjs';

const cfg = () => ({ sites: { 'cn-cli': { billingBase: 'https://fake.invalid', origin: 'https://fake.invalid', autoCheckin: true }, 'intl-cli': { billingBase: 'https://fake.invalid' }, custom: { billingBase: 'https://fake.invalid' } }, timeouts: { metaMs: 1000 } });
const accounts = () => [{ id: 'a', label: 'A', enabled: false }, { id: 'b', label: 'B', usable: false }, { id: 'c', label: 'C', exhausted: true }, { id: 'd', label: 'D' }];

test('严格查询后领取，锁定身份、顺序执行且失败不阻断后续账号', async () => {
  const events = [];
  const manager = createCheckinManager(cfg(), {
    accountSnapshot: accounts, sleep: async (ms) => events.push(`sleep:${ms}`),
    ensureToken: async (_cfg, _site, { accountId }) => { events.push(`token:${accountId}`); return { token: `secret-${accountId}`, accountId, account: { uid: accountId } }; },
    query: async (_cfg, _site, auth) => { events.push(`query:${auth.uid}:${auth.accessToken}`); if (auth.uid === 'c') throw Error('secret upstream'); return { active: true, today_checked_in: auth.uid === 'b' }; },
    claim: async (_cfg, _site, auth) => { events.push(`claim:${auth.uid}`); },
  });
  const result = await manager.run('cn-cli');
  assert.deepEqual(result.results.map((x) => x.status), ['claimed', 'already_signed', 'failed', 'claimed']);
  assert.deepEqual(events, ['token:a', 'query:a:secret-a', 'claim:a', 'sleep:400', 'token:b', 'query:b:secret-b', 'sleep:400', 'token:c', 'query:c:secret-c', 'sleep:400', 'token:d', 'query:d:secret-d', 'claim:d']);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test('状态字段不明确或活动未开启不会领取', async () => {
  let claims = 0;
  const manager = createCheckinManager(cfg(), { accountSnapshot: accounts, sleep: async () => {},
    ensureToken: async (_c, _s, { accountId }) => ({ token: 'x', accountId, account: { uid: accountId } }),
    query: async (_c, _s, a) => a.uid === 'a' ? { active: false, today_checked_in: false } : { active: true },
    claim: async () => { claims++; },
  });
  assert.deepEqual((await manager.run('cn-cli')).results.map((x) => x.status), ['inactive', 'failed', 'failed', 'failed']);
  assert.equal(claims, 0);
});

test('手动及自动共享互斥锁，未知和不支持站点明确拒绝', async () => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const manager = createCheckinManager(cfg(), { accountSnapshot: () => [accounts()[0]],
    ensureToken: async () => ({ accountId: 'a', token: 'x' }), query: async () => { await pending; return { active: true, today_checked_in: true }; },
    setInterval: () => 1, clearInterval: () => {} });
  manager.start();
  assert.equal(manager.isRunning('cn-cli'), true);
  await assert.rejects(manager.run('cn-cli'), (e) => e.status === 409);
  await assert.rejects(manager.run('missing'), (e) => e.status === 400);
  await assert.rejects(manager.run('custom'), (e) => e.status === 501);
  release();
  await new Promise(setImmediate);
  manager.stop();
});

test('启动、失败重试、增号、跨日、开关及重启都由远程状态判断', async () => {
  const config = cfg();
  let date = new Date(2026, 0, 1, 12).getTime();
  let list = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];
  const queries = [];
  let fail = true;
  const options = { now: () => date, accountSnapshot: () => list, sleep: async () => {},
    setInterval: () => 1, clearInterval: () => {},
    ensureToken: async (_c, _s, { accountId }) => ({ token: 'x', accountId, account: { uid: accountId } }),
    query: async (_c, _s, a) => { queries.push(a.uid); if (a.uid === 'b' && fail) throw Error(); return { active: true, today_checked_in: true }; },
  };
  const wait = () => new Promise(setImmediate);
  const manager = createCheckinManager(config, options);
  manager.start(); await wait();
  assert.deepEqual(queries, ['a', 'b']);
  fail = false; await manager.tick();
  assert.deepEqual(queries, ['a', 'b', 'b']);
  list = [...list, { id: 'c', label: 'C' }];
  await manager.tick(); assert.deepEqual(queries, ['a', 'b', 'b', 'c']);
  date = new Date(2026, 0, 2, 1).getTime();
  await manager.tick(); assert.equal(queries.length, 7);
  config.sites['cn-cli'].autoCheckin = false;
  date = new Date(2026, 0, 3, 1).getTime();
  await manager.tick(); assert.equal(queries.length, 7);
  config.sites['cn-cli'].autoCheckin = true;
  manager.enable('cn-cli'); await wait(); assert.equal(queries.length, 10);
  manager.stop(); await manager.tick(); assert.equal(queries.length, 10);
  config.sites['cn-cli'].enabled = false;
  manager.start(); await wait();
  assert.equal(queries.length, 10, '禁用的站点不应自动签到');
  manager.stop();
  config.sites['cn-cli'].enabled = true;
  const restarted = createCheckinManager(config, options);
  restarted.start(); await wait(); assert.equal(queries.length, 13);
  restarted.stop();
});

test('自动签到查询期间关闭开关不会领取或处理后续账号', async () => {
  const config = cfg();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  let queried = 0, claimed = 0;
  const manager = createCheckinManager(config, { accountSnapshot: accounts,
    setInterval: () => 1, clearInterval: () => {}, sleep: async () => {},
    ensureToken: async (_c, _s, { accountId }) => ({ token: 'x', accountId }),
    query: async () => { queried++; await pending; return { active: true, today_checked_in: false }; },
    claim: async () => { claimed++; },
  });
  manager.start();
  await new Promise(setImmediate);
  config.sites['cn-cli'].autoCheckin = false;
  release();
  await new Promise(setImmediate);
  assert.equal(queried, 1); assert.equal(claimed, 0);
  manager.stop();
});

test('真实协议路径、身份头、响应校验和站点范围', async () => {
  const config = cfg();
  const calls = [];
  const fetcher = async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ code: 0, data: { active: true, today_checked_in: false } }) }; };
  const auth = { accessToken: 'secret', uid: 'uid-a' };
  await queryCheckin(config, 'cn-cli', auth, fetcher);
  await claimCheckin(config, 'cn-cli', auth, fetcher);
  assert.deepEqual(calls.map((x) => new URL(x.url).pathname), ['/v2/billing/meter/checkin-activity-status', '/v2/billing/meter/daily-checkin']);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.headers['X-User-Id'], 'uid-a');
  assert.equal(calls[0].init.headers['X-Requested-With'], 'XMLHttpRequest');
  assert.equal(calls[0].init.headers['X-CodeBuddy-Request'], '1');
  assert.equal(calls[0].init.body, '{}');
  for (const response of [{ ok: false }, { ok: true, json: async () => ({ code: 1, data: {} }) }, { ok: true, json: async () => ({ code: 0, data: { active: true } }) }, { ok: true, json: async () => { throw Error('bad JSON'); } }]) {
    await assert.rejects(queryCheckin(config, 'cn-cli', auth, async () => response));
  }
  assert.equal(supportsCheckin(config, 'cn-cli'), true);
  assert.equal(supportsCheckin(config, 'intl-cli'), true);
  // 自定义站点即便有 billingBase 也不宣称支持，避免猜测未知上游协议
  assert.equal(supportsCheckin(config, 'custom'), false);
});
