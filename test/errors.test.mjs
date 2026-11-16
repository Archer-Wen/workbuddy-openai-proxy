// 业务错误分类器测试。
//
// 这一层是「一次限流不再锁账号半天」的地基，所以每条分支都要有正例和反例：
// 只测「429 → soft_rate」是不够的，真正容易错的是把某种 4xx/文案错误分类成欠费。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyError,
  isQuotaError,
  isAccountScopedError,
  parseRetryAfterMs,
  describeKind,
  KIND,
} from '../src/errors.mjs';

describe('分类：欠费只认「真的没钱」', () => {
  test('402 直接是欠费', () => {
    assert.equal(classifyError(402, '').kind, KIND.HARD_CREDIT);
    assert.equal(classifyError(402, '').credit, true);
  });

  test('英文欠费文案', () => {
    for (const msg of [
      'insufficient credits',
      'Insufficient quota',
      'credit exhausted',
      'balance is not enough',
      'you are out of credit',
      'no available credits',
      'quota exceeded',
    ]) {
      assert.equal(classifyError(429, msg).kind, KIND.HARD_CREDIT, `应识别为欠费：${msg}`);
    }
  });

  test('中文欠费文案', () => {
    for (const msg of ['积分不足', '额度不足', '余额不足', '积分已用完', '额度已用尽', '欠费']) {
      assert.equal(classifyError(429, msg).kind, KIND.HARD_CREDIT, `应识别为欠费：${msg}`);
    }
  });

  test('「超出频率限制」绝不能被当成欠费（旧实现的误判）', () => {
    // 旧正则里有 /超出/，于是这句被判成欠费并冻结账号 6 小时。
    assert.equal(classifyError(429, '使用量已超出频率限制').kind, KIND.SOFT_RATE);
  });

  test('普通的 429 就是限流，不是欠费', () => {
    const v = classifyError(429, 'Too Many Requests');
    assert.equal(v.kind, KIND.SOFT_RATE);
    assert.equal(v.credit, false, '限流不该被当作没钱');
    assert.equal(v.accountLevel, true, '但仍值得换号试一次');
  });
});

describe('分类：先排除「换号/等待都没用」的类别', () => {
  test('内容策略拒绝', () => {
    assert.equal(classifyError(400, 'content policy violation').kind, KIND.POLICY);
    assert.equal(classifyError(400, '内容不合规').kind, KIND.POLICY);
  });

  test('渠道/客户端身份被拒', () => {
    assert.equal(classifyError(400, 'Illegal API invocation from an unapproved channel').kind, KIND.CHANNEL);
    assert.equal(classifyError(403, 'channel rejected').kind, KIND.CHANNEL);
  });

  test('账号受限（含 11140）', () => {
    assert.equal(classifyError(403, 'request illegal').kind, KIND.ACCOUNT_RESTRICTED);
    assert.equal(classifyError(403, 'code=11140 请求非法').kind, KIND.ACCOUNT_RESTRICTED);
    assert.equal(classifyError(403, '账号已被风控').kind, KIND.ACCOUNT_RESTRICTED);
  });

  test('模型不存在', () => {
    assert.equal(classifyError(400, 'service info not found').kind, KIND.MODEL_NOT_FOUND);
    assert.equal(classifyError(404, 'model [glm-5] not found').kind, KIND.MODEL_NOT_FOUND);
  });

  test('模型繁忙 / 排队', () => {
    assert.equal(classifyError(429, 'model is busy').kind, KIND.MODEL_BUSY);
    assert.equal(classifyError(429, '模型繁忙').kind, KIND.MODEL_BUSY);
    assert.equal(classifyError(429, 'queued, please wait').kind, KIND.MODEL_QUEUE);
    assert.equal(classifyError(429, '正在排队中').kind, KIND.MODEL_QUEUE);
  });

  test('业务码 14003 是繁忙、14018 是欠费', () => {
    assert.equal(classifyError(200, '{"code":14003}').kind, KIND.MODEL_BUSY);
    assert.equal(classifyError(200, '{"code":14018}').kind, KIND.HARD_CREDIT);
  });
});

describe('分类：不该动账号状态的错误', () => {
  test('普通 400 是请求问题', () => {
    const v = classifyError(400, 'invalid parameter: temperature must be <= 2');
    assert.equal(v.kind, KIND.CLIENT);
    assert.equal(v.accountLevel, false, '换号解决不了参数错误');
    assert.equal(v.retriable, false);
  });

  test('5xx 与连接失败仍可重试', () => {
    assert.equal(classifyError(500, '').kind, KIND.SERVER);
    assert.equal(classifyError(502, 'openresty').kind, KIND.SERVER);
    assert.equal(classifyError(0, 'ECONNRESET').kind, KIND.TRANSPORT);
    assert.equal(classifyError(500, '').retriable, true);
  });

  test('凭证失效', () => {
    assert.equal(classifyError(401, '').kind, KIND.CREDENTIAL);
    assert.equal(classifyError(200, 'invalid_grant').kind, KIND.CREDENTIAL);
    assert.equal(classifyError(200, '登录态已失效').kind, KIND.CREDENTIAL);
  });
});

describe('parseRetryAfterMs：只在报文明确给时长时才返回', () => {
  test('标准 Retry-After', () => {
    assert.equal(parseRetryAfterMs('rate limited, retry after 120s'), 120_000);
    assert.equal(parseRetryAfterMs('Retry-After: 30'), 30_000);
    assert.equal(parseRetryAfterMs('retry after 500ms'), 500);
    assert.equal(parseRetryAfterMs('retry-after: 2 minutes'), 120_000);
  });

  test('中文时长', () => {
    assert.equal(parseRetryAfterMs('请 45 秒后重试'), 45_000);
    assert.equal(parseRetryAfterMs('3 分钟后重试'), 180_000);
  });

  test('解析不出来返回 null（交给阶梯冷却，不瞎猜）', () => {
    assert.equal(parseRetryAfterMs(''), null);
    assert.equal(parseRetryAfterMs('too many requests'), null);
    assert.equal(parseRetryAfterMs('retry after 0'), null);
  });

  test('离谱的数字被夹到 30 分钟上限', () => {
    assert.equal(parseRetryAfterMs('retry after 999999s'), 30 * 60_000);
  });
});

describe('对外便捷函数', () => {
  test('isQuotaError 收窄后仍覆盖「站点额度受限」语义', () => {
    assert.equal(isQuotaError(429, ''), true, '限流也算本站在额度层被挡住');
    assert.equal(isQuotaError(402, ''), true);
    assert.equal(isQuotaError(400, 'invalid param'), false, '400 不算');
    assert.equal(isQuotaError(400, 'service info not found'), false, '模型不存在不算');
    assert.equal(isQuotaError(200, '积分不足'), true);
  });

  test('isAccountScopedError 用于决定要不要换号', () => {
    assert.equal(isAccountScopedError(429, ''), true);
    assert.equal(isAccountScopedError(402, ''), true);
    assert.equal(isAccountScopedError(403, 'request illegal'), true);
    assert.equal(isAccountScopedError(401, ''), true);
    // 下面这些换号没用
    assert.equal(isAccountScopedError(400, 'invalid parameter'), false);
    assert.equal(isAccountScopedError(400, 'content policy'), false);
    assert.equal(isAccountScopedError(429, 'model is busy'), false, '繁忙是模型级，换号也是排队');
    assert.equal(isAccountScopedError(400, 'service info not found'), false);
  });

  test('describeKind 给出可读原因', () => {
    assert.equal(describeKind(KIND.HARD_CREDIT), '额度耗尽');
    assert.equal(describeKind(KIND.SOFT_RATE), '临时限流');
    assert.equal(describeKind(KIND.MODEL_BUSY), '模型繁忙');
    assert.equal(describeKind('something-new'), '未知错误', '未知 kind 不应抛错');
  });
});
