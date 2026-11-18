import { accountSnapshot, ensureToken } from './auth.mjs';
import { billingHeaders } from './headers.mjs';

// 三个内置站点使用同一套计费/签到协议，但 token 与网关必须按站点各自使用。
// 自定义站点不宣称支持：仅凭「有 billingBase」不能证明上游提供签到。
const CHECKIN_SITES = new Set(['cn-cli', 'intl-cli', 'intl-work']);

export function supportsCheckin(cfg, site) {
  const base = cfg.sites?.[site]?.billingBase;
  return CHECKIN_SITES.has(site) && typeof base === 'string' && Boolean(base.trim());
}

async function request(cfg, site, auth, endpoint, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeouts?.metaMs ?? 30000);
  try {
    const res = await fetchImpl(cfg.sites[site].billingBase.replace(/\/$/, '') + endpoint, {
      method: 'POST',
      // 与 DSH 的计费请求形态对齐：除通用计费头外，网关还看这两个客户端标记。
      headers: {
        ...billingHeaders(cfg.sites[site], auth),
        'X-Requested-With': 'XMLHttpRequest',
        'X-CodeBuddy-Request': '1',
      },
      body: '{}', signal: controller.signal,
    });
    if (!res.ok) throw new Error('HTTP failure');
    const json = await res.json();
    if (!json || json.code !== 0 || !json.data || typeof json.data !== 'object' || Array.isArray(json.data)) {
      throw new Error('invalid response');
    }
    return json.data;
  } finally {
    clearTimeout(timer);
  }
}

export async function queryCheckin(cfg, site, auth, fetchImpl = fetch) {
  const data = await request(cfg, site, auth, '/v2/billing/meter/checkin-activity-status', fetchImpl);
  if (typeof data.active !== 'boolean' || typeof data.today_checked_in !== 'boolean') throw new Error('invalid status');
  return data;
}

export async function claimCheckin(cfg, site, auth, fetchImpl = fetch) {
  return request(cfg, site, auth, '/v2/billing/meter/daily-checkin', fetchImpl);
}

const localDay = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** Both automatic and manual checks share this instance's per-site lock. */
export function createCheckinManager(cfg, options = {}) {
  const snapshot = options.accountSnapshot || accountSnapshot;
  const tokenFor = options.ensureToken || ensureToken;
  const query = options.query || queryCheckin;
  const claim = options.claim || claimCheckin;
  const supported = options.supported || supportsCheckin;
  const now = options.now || Date.now;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const setIntervalFn = options.setInterval || setInterval;
  const clearIntervalFn = options.clearInterval || clearInterval;
  const running = new Set();
  const completed = new Map(); // in-memory only: restart always rechecks remote state
  let timer = null;
  let stopped = true;

  async function run(site, { automatic = false } = {}) {
    if (!Object.hasOwn(cfg.sites || {}, site)) throw Object.assign(new Error('未知站点'), { status: 400 });
    if (!supported(cfg, site)) throw Object.assign(new Error('该站点不支持签到'), { status: 501 });
    if (running.has(site)) throw Object.assign(new Error('该站点签到正在进行，请稍后再试'), { status: 409 });
    running.add(site);
    const results = [];
    try {
      const day = localDay(now());
      const accounts = snapshot(site);
      const eligible = automatic ? accounts.filter((a) => completed.get(`${site}\0${a.id}`) !== day) : accounts;
      for (let i = 0; i < eligible.length; i++) {
        if (automatic && (stopped || cfg.sites[site]?.autoCheckin !== true)) break;
        if (i) await sleep(400);
        if (automatic && (stopped || cfg.sites[site]?.autoCheckin !== true)) break;
        const a = eligible[i];
        let status = 'failed';
        let message = '签到失败，请稍后重试';
        try {
          const credential = await tokenFor(cfg, site, { accountId: a.id });
          if (credential.accountId !== a.id || !credential.token) throw new Error('invalid identity');
          const auth = { ...credential.account, accessToken: credential.token };
          const state = await query(cfg, site, auth);
          if (typeof state?.active !== 'boolean' || typeof state?.today_checked_in !== 'boolean') throw new Error('invalid status');
          if (!state.active) {
            status = 'inactive'; message = '签到活动未开启';
          } else if (state.today_checked_in) {
            status = 'already_signed'; message = '今日已签到';
          } else {
            if (automatic && (stopped || cfg.sites[site]?.autoCheckin !== true)) break;
            await claim(cfg, site, auth);
            status = 'claimed'; message = '签到成功';
          }
        } catch {
          // Never expose exception messages or upstream response bodies.
        }
        results.push({ id: a.id, label: a.label, status, message });
        if (status === 'claimed' || status === 'already_signed') completed.set(`${site}\0${a.id}`, day);
      }
      return { ok: true, site, results };
    } finally {
      running.delete(site);
    }
  }

  async function tick() {
    if (stopped) return;
    await Promise.all(Object.keys(cfg.sites || {}).filter((site) => cfg.sites[site]?.enabled !== false
      && cfg.sites[site]?.autoCheckin === true && supported(cfg, site))
      .map(async (site) => { try { await run(site, { automatic: true }); } catch { /* retry on next tick */ } }));
  }
  function start() {
    if (!stopped) return;
    stopped = false;
    timer = setIntervalFn(() => { void tick(); }, options.intervalMs ?? 30 * 60 * 1000);
    timer?.unref?.();
    void tick();
  }
  function stop() {
    stopped = true;
    if (timer !== null) clearIntervalFn(timer);
    timer = null;
  }
  function enable(site) {
    for (const key of completed.keys()) if (key.startsWith(`${site}\0`)) completed.delete(key);
    void tick();
  }
  return { run, tick, start, stop, enable, isRunning: (site) => running.has(site), supports: (site) => supported(cfg, site) };
}
