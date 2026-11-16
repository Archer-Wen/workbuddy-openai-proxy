// 账号池测试：选号、额度耗尽、失败退避、轮换、旧单账号兼容。
//
// 隔离方式与 auth.test.mjs 一致：setConfigDir() 切到临时目录。
// 号池把「站点 → 账号列表」落盘到 auth.<site>.pool.json，
// 所以每个用例都要先切目录再操作，避免污染仓库。
import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-pool-'));

const { setConfigDir, authPathFor, getConfigDir } = await import('../src/config.mjs');
setConfigDir(tmpDir);
const pool = await import('../src/pool.mjs');

if (!pool.poolPathFor('cn-cli').startsWith(tmpDir)) {
  throw new Error(`测试隔离失败：号池路径 ${pool.poolPathFor('cn-cli')} 不在临时目录内`);
}

/** 造一个账号对象。 */
const acct = (n, extra = {}) => ({
  accessToken: `tok-${n}`,
  refreshToken: `rt-${n}`,
  uid: `uid-${n}`,
  nickname: `号${n}`,
  expiresAt: Date.now() + 3600_000,
  ...extra,
});

/**
 * 每个用例开始时切回本文件的临时目录并清空凭证。
 *
 * 为什么必须在「用例体内」调用，而不是只用 beforeEach：
 * 同一个进程里会跑多个测试文件，它们各自持有不同的临时目录，
 * 而 setConfigDir 是全局状态。挂在 beforeEach 上时，
 * 其他文件（如 auth.test.mjs）的钩子会在本文件的用例之间改走目录，
 * 于是本文件读到的是别人的凭证 —— 表现为「单独跑通过、全量跑失败」。
 */
function fresh() {
  setConfigDir(tmpDir);
  // 兼容模式的耗尽/冷却记在内存里（不落盘），切目录不会清掉它，
  // 必须显式清空，否则上一个用例的状态会漏到下一个用例。
  pool.clearLegacyState();
  fs.rmSync(pool.poolPathFor('cn-cli'), { force: true });
  fs.rmSync(authPathFor('cn-cli'), { force: true });
  fs.rmSync(path.join(tmpDir, 'auth.json'), { force: true });
}

describe('号池：旧单账号兼容', () => {
  test('没有池文件时，旧 auth.<site>.json 被当作唯一账号', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, pool.DEFAULT_ACCOUNT_ID);
    assert.equal(list[0].accessToken, 'tok-1');
    assert.equal(pool.hasPoolFile('cn-cli'), false, '不应因为读取就建池文件');
  });

  test('池文件不存在且没有旧凭证时，池为空', () => {
    fresh();
    assert.deepEqual(pool.listAccounts('cn-cli'), []);
    assert.equal(pool.pickAccount('cn-cli'), null);
  });

  test('cn-cli 还能回落到更老的 auth.json', () => {
    fresh();
    fs.writeFileSync(path.join(getConfigDir(), 'auth.json'), JSON.stringify(acct(9)));
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1);
    assert.equal(list[0].accessToken, 'tok-9');
  });

  test('加入第一个新账号时，旧账号会被并进池（不会丢）', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: '新号' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 2);
    assert.ok(list.some((a) => a.id === pool.DEFAULT_ACCOUNT_ID), '旧账号应保留');
    assert.ok(list.some((a) => a.label === '新号'));
    assert.equal(pool.hasPoolFile('cn-cli'), true);
  });
});

// 兼容模式只有一个账号、没有池文件，所以 markFailure/markExhausted 刻意不落盘，
// 否则控制台轮询这类只读场景会凭空建出池文件。原实现的代价是**耗尽状态彻底丢失**：
// 账号被上游 429 之后 usableCount 仍恒为 1，路由把死站当健康站点，
// 每个请求都要先撞一次 429，连「降级」也照着同一个错误前提挑目标。
// 下面这组用例锁定「不落盘但状态可见」这个折中。
describe('号池：兼容模式的内存态状态（不落盘但可见）', () => {
  test('markExhausted 后 usableCount 归零，且不生成池文件', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L1')));
    assert.equal(pool.usableCount('cn-cli'), 1);

    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID, '额度已用尽');

    assert.equal(pool.usableCount('cn-cli'), 0, '耗尽后不应再算作可用');
    assert.equal(pool.hasPoolFile('cn-cli'), false, '记录状态不应建出池文件');
    const a = pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(pool.isUsable(a), false);
    assert.match(a.lastError, /额度已用尽/);
  });

  test('markFailure(429) 只冷却，不再判额度耗尽', () => {
    // 这条用例锁定的行为在 v1.5 变了，原因很重要：
    // 上游的 429 混着「真欠费 / 模型繁忙 / 排队 / 临时限流」四种。
    // 旧实现一律当欠费冻结 6 小时，而中文文案「使用量已超出频率限制」里的
    // 「超出」正好命中了旧的额度正则 —— 一次普通限流被判成欠费。
    // 现在 429 归类为 soft_rate，只产生冷却；真欠费要靠 402/欠费文案。
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L2')));
    pool.markFailure('cn-cli', pool.DEFAULT_ACCOUNT_ID, { status: 429, message: '使用量已超出频率限制' });
    const a = pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(pool.usableCount('cn-cli'), 0, '冷却中也算不可用');
    assert.equal(pool.hasPoolFile('cn-cli'), false, '记录状态不应建出池文件');
    assert.equal(a.exhaustedAt, null, '429 不该再被当成额度耗尽');
    assert.ok(a.cooldownUntil > Date.now(), '应该走冷却退避');
    assert.equal(a.lastErrorKind, 'soft_rate');
  });

  test('markFailure(500) 只冷却：非兜底挑不到，兜底仍能挑到', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L3')));
    pool.markFailure('cn-cli', pool.DEFAULT_ACCOUNT_ID, { status: 500 });

    assert.equal(pool.usableCount('cn-cli'), 0, '冷却中不算可用');
    assert.equal(pool.pickAccount('cn-cli'), null);
    // 兜底必须仍然返回账号：额度可能已重置，让上游给最终答案好过本地直接失败
    assert.ok(pool.pickAccount('cn-cli', { fallback: true }), '兜底应仍能挑到冷却中的账号');
    assert.equal(pool.usableCount('cn-cli'), 0, '挑到兜底账号不应把它变回可用');
  });

  test('markSuccess 解除耗尽标记（成功即证明额度可用）', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L4')));
    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(pool.usableCount('cn-cli'), 0);

    pool.markSuccess('cn-cli', pool.DEFAULT_ACCOUNT_ID);

    assert.equal(pool.usableCount('cn-cli'), 1);
    assert.equal(pool.hasPoolFile('cn-cli'), false, '仍然不落盘');
  });

  test('换了凭证（重新登录）后旧状态自动失效，新号不被连坐', () => {
    // 关键设计：覆盖层带 accessToken 指纹。少了它，用户重新登录拿到的新号
    // 会继承上一个号的耗尽标记并被冻结 6 小时。
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('old')));
    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(pool.usableCount('cn-cli'), 0);

    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('new')));

    assert.equal(pool.usableCount('cn-cli'), 1, '换了凭证就不该继承上一个号的耗尽标记');
    assert.equal(pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID).exhaustedAt, undefined);
  });

  test('迁移到池文件时耗尽状态随账号一起保留（不丢信息）', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L5')));
    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID, '配额用尽');

    pool.addAccount('cn-cli', acct('L6'), { label: '新号' }); // 触发迁移

    assert.equal(pool.hasPoolFile('cn-cli'), true);
    const 旧号 = pool.getAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.ok(旧号.exhaustedAt, '内存态应随账户一起落进池文件');
    assert.equal(旧号.lastError, '配额用尽');
    assert.equal(pool.usableCount('cn-cli'), 1, '迁移后只剩新号可用');
  });

  test('clearLegacyState 清空内存态', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct('L7')));
    pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(pool.usableCount('cn-cli'), 0);

    pool.clearLegacyState();

    assert.equal(pool.usableCount('cn-cli'), 1);
  });

  test('未登录时 mark* 不抛错，返回 null', () => {
    fresh();
    assert.equal(pool.markFailure('cn-cli', pool.DEFAULT_ACCOUNT_ID, { status: 429 }), null);
    assert.equal(pool.markExhausted('cn-cli', pool.DEFAULT_ACCOUNT_ID), null);
    assert.equal(pool.markSuccess('cn-cli', pool.DEFAULT_ACCOUNT_ID), null);
    assert.equal(pool.hasPoolFile('cn-cli'), false);
  });
});

describe('号池：增删账号', () => {
  test('addAccount 能加多个账号', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 2);
    assert.deepEqual(list.map((a) => a.label), ['A', 'B']);
  });

  test('同一个 uid 重复登录是覆盖，不是新增', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', { ...acct(1), accessToken: 'tok-1-new' }, { label: 'A2' });
    const list = pool.listAccounts('cn-cli');
    assert.equal(list.length, 1, '同 uid 不应出现两条');
    assert.equal(list[0].accessToken, 'tok-1-new');
    assert.equal(list[0].label, 'A2');
  });

  test('未登录（无 uid）的账号不会互相覆盖', () => {
    fresh();
    const noUid = { accessToken: 'x', refreshToken: 'y' };
    pool.addAccount('cn-cli', { ...noUid }, { label: 'A' });
    pool.addAccount('cn-cli', { ...noUid }, { label: 'B' });
    assert.equal(pool.listAccounts('cn-cli').length, 2);
  });

  test('removeAccount 删除指定账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.removeAccount('cn-cli', a.id), true);
    assert.deepEqual(pool.listAccounts('cn-cli').map((x) => x.label), ['B']);
  });

  test('删除不存在的账号返回 false', () => {
    fresh();
    assert.equal(pool.removeAccount('cn-cli', 'nope'), false);
  });

  test('删除默认账号时连带清掉旧凭证文件，避免又被兼容读回来', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: 'B' }); // 触发迁移，旧号进池
    pool.removeAccount('cn-cli', pool.DEFAULT_ACCOUNT_ID);
    assert.equal(fs.existsSync(authPathFor('cn-cli')), false);
    assert.deepEqual(pool.listAccounts('cn-cli').map((x) => x.label), ['B']);
  });
});

describe('号池：选号', () => {
  test('优先选从没被判耗尽的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('默认只返回可用账号；全耗尽时返回 null', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli'), null, '严格模式下不返回耗尽的号');
  });

  test('fallback:true 时，全耗尽也返回一个（让上游给最终答案，而非本地臆断）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli', { fallback: true }).id, a.id);
  });

  test('fallback:true 也不会返回被禁用的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.setAccountEnabled('cn-cli', a.id, false);
    pool.markExhausted('cn-cli', a.id);
    assert.equal(pool.pickAccount('cn-cli', { fallback: true }), null);
  });

  test('禁用账号不参与选择', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.setAccountEnabled('cn-cli', a.id, false);
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('exclude 里的账号会被跳过（换号重试用）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.pickAccount('cn-cli', { exclude: [a.id] }).id, b.id);
    assert.equal(pool.pickAccount('cn-cli', { exclude: [a.id, b.id] }), null);
  });

  test('负载摊开：连续选号会轮到不同的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const 第一次 = pool.pickAccount('cn-cli', { now: 1000 });
    pool.markSuccess('cn-cli', 第一次.id); // 会更新 lastUsedAt
    const 第二次 = pool.pickAccount('cn-cli');
    assert.notEqual(第一次.id, 第二次.id, '应该轮到另一个账号');
    assert.deepEqual(new Set([第一次.id, 第二次.id]), new Set([a.id, b.id]));
  });

  test('连续失败的账号排在后面', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    assert.equal(pool.pickAccount('cn-cli').id, b.id);
  });

  test('usableCount 会扣除 exclude', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    assert.equal(pool.usableCount('cn-cli'), 2);
    assert.equal(pool.usableCount('cn-cli', undefined, [a.id]), 1);
    assert.equal(pool.usableCount('cn-cli', undefined, [a.id, 'x']), 1);
  });
});

describe('号池：失败语义分类（429 不再一律判欠费）', () => {
  test('真欠费（402 / 欠费文案）→ 标记耗尽，不靠时钟恢复', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 402 });
    const got = pool.getAccount('cn-cli', a.id);
    assert.ok(got.exhaustedAt, '402 是欠费，应标记耗尽');
    assert.equal(got.cooldownUntil, null, '欠费不走冷却，走耗尽');
    assert.equal(got.lastErrorKind, 'hard_credit');
    // 关键：耗尽不会因为「等了一会儿」自己解除，只能靠成功请求或额度到账
    assert.equal(pool.isUsable(got), false);
    assert.equal(pool.isUsable(got, Date.now() + 60_000), false, '1 分钟后仍不可用');
  });

  test('模型繁忙 → 2 分钟冷却，不判耗尽', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const t0 = Date.now();
    pool.markFailure('cn-cli', a.id, { status: 429, message: 'model is busy' });
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null);
    assert.equal(got.lastErrorKind, 'model_busy');
    const 剩余 = got.cooldownUntil - t0;
    assert.ok(剩余 >= 110_000 && 剩余 <= 130_000, `繁忙冷却应约 2 分钟，实际 ${剩余}ms`);
  });

  test('HTTP 400 不动账号状态（换号解决不了请求本身的问题）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 400, message: 'invalid parameter: temperature' });
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null, '400 不是额度问题');
    assert.equal(got.cooldownUntil, null, '400 不该产生冷却');
    assert.equal(got.lastErrorKind, 'client');
    assert.equal(pool.isUsable(got), true, '账号仍然可用');
    assert.equal(got.failCount, 1, '失败次数仍要记，便于观测');
  });

  test('上游给了 retryAfter 时按它冷却，且不短于阶梯退避', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const t0 = Date.now();
    pool.markFailure('cn-cli', a.id, { status: 429, message: 'rate limited, retry after 120s' });
    const 剩余 = pool.getAccount('cn-cli', a.id).cooldownUntil - t0;
    assert.ok(剩余 >= 119_000 && 剩余 <= 121_000, `应按 retryAfter 冷却约 120s，实际 ${剩余}ms`);
  });

  test('额度不足的中文提示也识别为耗尽', () => {
    fresh();
    assert.equal(pool.isQuotaError(200, '积分不足'), true);
    assert.equal(pool.isQuotaError(200, 'insufficient credits'), true);
    assert.equal(pool.isQuotaError(200, '随便什么错误'), false);
  });

  test('「超出频率限制」不等于欠费（旧正则的误判，回归）', () => {
    // 旧实现用 /超出/ 匹配额度类错误，于是「使用量已超出频率限制」被判成欠费。
    fresh();
    assert.equal(pool.isQuotaError(429, '使用量已超出频率限制'), true, '算限流，站点级降级仍应触发');
    assert.equal(pool.explainFailure(429, '使用量已超出频率限制'), '临时限流', '但语义必须是限流，不是欠费');
  });

  test('业务错误帧（HTTP 200 里的错误信封）也能被正确归类', () => {
    // 上游会把额度类错误放在 200 的流里下发，此时 status=200，
    // 只能靠错误码/文案判断 —— 这是 openChat 偷看首帧后回传 status 的典型输入。
    assert.equal(pool.explainFailure(200, '{"code":14018,"msg":"积分已耗尽"}'), '额度耗尽');
    assert.equal(pool.explainFailure(200, '{"code":14003,"msg":"模型繁忙"}'), '模型繁忙');
    assert.equal(pool.explainFailure(0, 'ECONNRESET'), '连接失败');
  });
});

describe('号池：状态与退避', () => {
  test('普通错误走冷却退避，不是耗尽', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null, '5xx 不该判成额度耗尽');
    assert.equal(got.failCount, 1);
  });

  test('连续失败会拉长冷却时间', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const 一次 = pool.getAccount('cn-cli', a.id).cooldownUntil;
    pool.markFailure('cn-cli', a.id, { status: 500 });
    const 两次 = pool.getAccount('cn-cli', a.id).cooldownUntil;
    assert.ok(两次 > 一次, '第二次失败冷却应更长');
  });

  test('markSuccess 清掉失败计数、冷却与耗尽标记', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markFailure('cn-cli', a.id, { status: 429 });
    pool.markFailure('cn-cli', a.id, { status: 500 });
    pool.markSuccess('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.failCount, 0);
    assert.equal(got.cooldownUntil, null);
    assert.equal(got.exhaustedAt, null);
    assert.equal(got.lastError, null);
  });

  test('resetAccountState 能手动恢复', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    pool.setAccountEnabled('cn-cli', a.id, false);
    pool.resetAccountState('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(got.exhaustedAt, null);
    assert.equal(got.failCount, 0);
  });

  test('耗尽标记会随时间失效（额度可能已重置）', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.markExhausted('cn-cli', a.id);
    const got = pool.getAccount('cn-cli', a.id);
    assert.equal(pool.isUsable(got), false, '刚标记时不可用');
    // 7 小时后（超过 6 小时 TTL）应重新可用
    assert.equal(pool.isUsable(got, Date.now() + 7 * 3600_000), true);
  });

  test('updateTokens 按账号精确写回，不影响别的账号', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    const b = pool.addAccount('cn-cli', acct(2), { label: 'B' });
    pool.updateTokens('cn-cli', a.id, { accessToken: 'new-a', refreshToken: 'new-ra', expiresAt: 42 });
    assert.equal(pool.getAccount('cn-cli', a.id).accessToken, 'new-a');
    assert.equal(pool.getAccount('cn-cli', a.id).expiresAt, 42);
    assert.equal(pool.getAccount('cn-cli', b.id).accessToken, 'tok-2', 'B 不该被动');
  });

  test('setAccountLabel 改显示名', () => {
    fresh();
    const a = pool.addAccount('cn-cli', acct(1), { label: 'A' });
    pool.setAccountLabel('cn-cli', a.id, '小号甲');
    assert.equal(pool.getAccount('cn-cli', a.id).label, '小号甲');
  });
});

describe('号池：getAuth 必须跟着池走（回归）', () => {
  // 曾经的 bug：loadAuth 只读 auth.<site>.json，忽略了池文件，
  // 于是 chatHeaders 用的是旧文件的 token，而请求本身却是池里选出的账号 ——
  // 表现为「禁用/换号后行为完全没变」，很难察觉。
  test('有池文件时 getAuth 返回池里的账号，而不是旧文件', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify({ ...acct(1), accessToken: 'legacy-file-token' }));
    pool.addAccount('cn-cli', { ...acct(2), accessToken: 'pool-token' }, { label: 'PoolA' });
    const got = authMod.getAuth('cn-cli');
    assert.notEqual(got.accessToken, 'legacy-file-token', '不能再用旧文件的 token');
  });

  test('池里账号全部禁用时，不会退回旧文件的凭证', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify({ ...acct(1), accessToken: 'legacy-file-token' }));
    pool.addAccount('cn-cli', acct(2), { label: 'A' });
    for (const a of pool.listAccounts('cn-cli')) pool.setAccountEnabled('cn-cli', a.id, false);
    const got = authMod.getAuth('cn-cli');
    assert.notEqual(got.accessToken, 'legacy-file-token', '旧文件不该再被使用');
    assert.equal(got.accessToken, undefined, '全禁用时应没有可用凭证');
  });

  test('ensureToken 选中的账号会成为 getAuth 的结果', async () => {
    fresh();
    const authMod = await import('../src/auth.mjs');
    pool.addAccount('cn-cli', { ...acct(1), accessToken: 'tok-A', expiresAt: Date.now() + 3600_000 }, { label: 'A' });
    const b = pool.addAccount('cn-cli', { ...acct(2), accessToken: 'tok-B', expiresAt: Date.now() + 3600_000 }, { label: 'B' });
    // 让 A 显得「刚用过」，这样选出来的必然是 B
    const a = pool.listAccounts('cn-cli').find((x) => x.label === 'A');
    pool.markSuccess('cn-cli', a.id);
    const r = await authMod.ensureToken({ sites: { 'cn-cli': {} }, defaultSite: 'cn-cli' }, 'cn-cli');
    assert.equal(r.accountId, b.id, 'A 刚被用过，应轮到 B');
    assert.equal(r.token, 'tok-B');
    assert.equal(authMod.getAuth('cn-cli').accessToken, 'tok-B');
  });
});

describe('号池：文件读写', () => {
  test('写出的池文件不含内部字段 legacyFile', () => {
    fresh();
    fs.writeFileSync(authPathFor('cn-cli'), JSON.stringify(acct(1)));
    pool.addAccount('cn-cli', acct(2), { label: 'B' });
    const raw = JSON.parse(fs.readFileSync(pool.poolPathFor('cn-cli'), 'utf8'));
    for (const a of raw.accounts) {
      assert.equal('legacyFile' in a, false, 'legacyFile 是内部字段，不应落盘');
    }
  });

  test('池文件损坏时视作空池，不抛异常', () => {
    fresh();
    fs.writeFileSync(pool.poolPathFor('cn-cli'), '{ 这不是 json');
    assert.deepEqual(pool.listAccounts('cn-cli'), []);
  });

  test('池文件权限为 600（含凭证，不能被同机其他用户读）', () => {
    fresh();
    pool.addAccount('cn-cli', acct(1), { label: 'A' });
    if (process.platform === 'win32') return; // Windows 不支持 POSIX 权限位
    const mode = fs.statSync(pool.poolPathFor('cn-cli')).mode & 0o777;
    assert.equal(mode, 0o600);
  });
});
