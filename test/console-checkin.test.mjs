import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const html = readFileSync(new URL('../console/index.html', import.meta.url), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
assert.equal(scripts.length, 2);
const consoleScript = scripts[1].split('// ---------- 启动 ----------')[0];

const account = { id: 'a', label: '测试', enabled: true, usable: true };
const site = (key, overrides = {}) => ({
  site: key, label: key, accounts: [account], account_usable: 1,
  checkin_supported: true, auto_checkin: false, checkin_running: false,
  ...overrides,
});
const state = (sites) => ({ sites, version: '1', node: 'x', default_model: 'x', uptime_ms: 0 });

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup(sites) {
  const elements = {};
  const document = {
    documentElement: { dataset: { theme: 'dark' } },
    getElementById(id) {
      return elements[id] ||= {
        innerHTML: '', textContent: '', dataset: {},
        classList: { toggle() {}, remove() {}, add() {} },
      };
    },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    document, window: {}, console, Map, Object, encodeURIComponent, decodeURIComponent,
    setTimeout() {}, setInterval() {},
  });
  vm.runInContext(consoleScript, context);
  context.fixture = state(sites);
  const run = (code) => vm.runInContext(code, context);
  run('STATE = fixture; renderAccounts()');
  return { context, run, markup: () => elements.accountCards.innerHTML };
}

test('按钮顺序以及不支持、空池和运行中的禁用状态', () => {
  const { markup } = setup([
    site('ok'), site('no', { checkin_supported: false }),
    site('empty', { accounts: [] }), site('busy', { checkin_running: true }),
  ]);
  const cards = markup().split('<div class="card">').slice(1);
  assert.ok(cards[0].indexOf('清空账号池') < cards[0].indexOf('一键签到'));
  assert.doesNotMatch(cards[0], /checkinSite[^>]*disabled/);
  assert.match(cards[1], /checkinSite[^>]*disabled/);
  assert.match(cards[1], /type="checkbox"[^>]*disabled/);
  assert.match(cards[1], /该站点暂不支持签到/);
  assert.match(cards[2], /checkinSite[^>]*disabled/);
  assert.match(cards[2], /请先添加账号/);
  assert.match(cards[3], /checkinSite[^>]*disabled/);
  assert.match(cards[3], /签到中…/);
});

test('请求期间重绘和状态刷新防止重复签到，逐账号展示结果并转义', async () => {
  const { context, run, markup } = setup([site('ok')]);
  const check = deferred();
  let calls = 0;
  context.fakeApi = (path) => {
    if (path === '/checkin') { calls++; return check.promise; }
    assert.equal(path, '/state');
    return Promise.resolve(context.fixture);
  };
  run('api = fakeApi');
  const request = run("checkinSite('ok')");
  run('renderAccounts()');
  await run('loadState()');
  assert.match(markup(), /checkinSite[^>]*disabled/);
  assert.match(markup(), /签到中…/);
  await run("checkinSite('ok')");
  assert.equal(calls, 1);

  check.resolve({ ok: false, results: [
    { id: '1', label: 'Alice', status: 'claimed', message: '完成' },
    { id: '2', label: 'Bob', status: 'already_signed', message: '已签到' },
    { id: '3', label: '<img>', status: 'failed', message: '<script>bad</script>' },
    { id: '4', label: 'Dave', status: 'unsupported', message: '不可用' },
    { id: '5', label: 'Eve', status: 'inactive', message: '签到活动未开启' },
  ] });
  await request;
  for (const text of ['签到成功', '今日已签到', '签到失败', '不支持', '活动未开启', 'Alice', 'Bob', '&lt;img&gt;', '&lt;script&gt;bad&lt;/script&gt;']) {
    assert.ok(markup().includes(text), text);
  }
  assert.doesNotMatch(markup(), /<script>bad<\/script>/);
  assert.doesNotMatch(markup(), /checkinSite[^>]*disabled/);
});

test('状态轮询能反映服务端签到开始和结束，不会一直卡在签到中', async () => {
  const { context, run, markup } = setup([site('ok')]);
  context.fakeApi = () => Promise.resolve(context.fixture);
  run('api = fakeApi');
  context.fixture = state([site('ok', { checkin_running: true })]);
  await run('loadState()');
  assert.match(markup(), /签到中…/);
  context.fixture = state([site('ok', { checkin_running: false })]);
  await run('loadState()');
  assert.doesNotMatch(markup(), /签到中…/);
});

test('自动签到保存失败后恢复真实值和可操作状态，错误安全显示', async () => {
  const { context, run, markup } = setup([site('ok')]);
  const save = deferred();
  context.fakeApi = (path) => path === '/site' ? save.promise : Promise.resolve(context.fixture);
  run('api = fakeApi');
  const request = run("setAutoCheckin('ok', true)");
  assert.match(markup(), /type="checkbox" checked disabled/);
  await run('loadState()');
  save.reject(new Error('<失败>'));
  await request;
  assert.doesNotMatch(markup(), /type="checkbox" checked/);
  assert.doesNotMatch(markup(), /type="checkbox"[^>]*disabled/);
  assert.match(markup(), /&lt;失败&gt;/);
  assert.equal(run('STATE.sites[0].auto_checkin'), false);
});

test('保存成功后旧 state 响应不覆盖刚保存的值', async () => {
  const { context, run, markup } = setup([site('ok')]);
  const oldState = deferred();
  let savedBody;
  context.fakeApi = (path, options) => {
    if (path === '/state') return oldState.promise;
    assert.equal(path, '/site');
    savedBody = options.body;
    return Promise.resolve({ ok: true });
  };
  run('api = fakeApi');
  const stale = run('loadState()');
  await run("setAutoCheckin('ok', true)");
  assert.equal(savedBody.site, 'ok');
  assert.equal(savedBody.auto_checkin, true);
  oldState.resolve(state([site('ok')]));
  await stale;
  assert.equal(run('STATE.sites[0].auto_checkin'), true);
  assert.match(markup(), /type="checkbox" checked/);
});
