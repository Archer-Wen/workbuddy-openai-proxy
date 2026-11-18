import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, setConfigDir, loadConfig } from '../src/config.mjs';
import { handleConsoleApi } from '../src/console-api.mjs';

test('控制台签到接口校验、持久化、状态和并发错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-checkin-api-'));
  const restore = setConfigDir(dir);
  try {
    const cfg = defaultConfig();
    let enabled = 0;
    const checkin = { supports: (s) => s !== 'intl-work', isRunning: (s) => s === 'cn-cli', enable: () => { enabled++; },
      run: async () => { throw Object.assign(new Error('secret'), { status: 409 }); } };
    async function call(endpoint, method = 'GET', body = null) {
      let status, text;
      const res = { writeHead(s) { status = s; }, end(s) { text = s; } };
      await handleConsoleApi({ cfg, checkin, req: { method }, res, url: new URL(`http://localhost/console/api${endpoint}`), body });
      return { status, body: JSON.parse(text) };
    }
    let r = await call('/state');
    const cn = r.body.sites.find((s) => s.site === 'cn-cli');
    assert.deepEqual([cn.auto_checkin, cn.checkin_supported, cn.checkin_running], [false, true, true]);
    r = await call('/site', 'POST', { site: 'cn-cli', auto_checkin: 'true', label: 'must not persist' });
    assert.equal(r.status, 400); assert.notEqual(cfg.sites['cn-cli'].label, 'must not persist');
    r = await call('/site', 'POST', { site: 'cn-cli', auto_checkin: true });
    assert.equal(r.status, 200); assert.equal(enabled, 1); assert.equal(loadConfig(dir).sites['cn-cli'].autoCheckin, true);
    r = await call('/site', 'POST', { site: 'cn-cli', auto_checkin: false });
    assert.equal(r.status, 200); assert.equal(loadConfig(dir).sites['cn-cli'].autoCheckin, false);
    assert.equal((await call('/checkin', 'POST', { site: 'missing' })).status, 400);
    assert.equal((await call('/checkin', 'POST', { site: 'intl-work' })).status, 501);
    r = await call('/checkin', 'POST', { site: 'cn-cli' });
    assert.equal(r.status, 409); assert.doesNotMatch(JSON.stringify(r), /secret/);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
