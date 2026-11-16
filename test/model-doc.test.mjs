// 模型目录解析测试。
//
// 这里的夹具不是编的：它按 2026-11 对 cn-cli 真实响应的结构裁剪而来
// （见 test/helpers/config-doc-cn-cli.json）。真实响应里 data.models 有 33 个模型，
// 但 CLI 真正能用的是 agents[name=cli].models 这 16 个 id 的白名单 ——
// "全量模型表 + CLI 白名单二次筛选" 是这两个端点共同的形状，也是最容易写错的地方。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseModelDocument } from '../src/upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'helpers', 'config-doc-cn-cli.json'), 'utf8'));

describe('parseModelDocument：CLI 白名单筛选', () => {
  test('只保留 agents[name=cli].models 里的模型', () => {
    const list = parseModelDocument(fixture);
    const ids = list.map((m) => m.id);
    assert.ok(ids.includes('deepseek-v4-pro'), '白名单内的应保留');
    assert.ok(ids.includes('minimax-m2.7'), '白名单内的应保留');
    assert.equal(ids.includes('no-whitelist-model'), false, '不在 CLI 白名单里的应被剔除');
    assert.equal(ids.includes('default'), false, '/v3/config 里有 default 但 CLI 白名单不含它');
  });

  test('disabled 的模型即使进了白名单也被剔除', () => {
    const ids = parseModelDocument(fixture).map((m) => m.id);
    assert.equal(ids.includes('disabled-one'), false, 'disabled 优先级高于白名单');
  });

  test('字段映射：倍率 / 上下文 / 输出上限 / 能力位', () => {
    const m = parseModelDocument(fixture).find((x) => x.id === 'deepseek-v4-pro');
    assert.equal(m.credits, 'x0.51 credits');
    assert.equal(m.contextWindow, 1000000);
    assert.equal(m.maxTokens, 128000);
    assert.equal(m.supportsImages, true);
    assert.equal(m.supportsToolCall, true);
    assert.equal(m.name, 'DeepSeek V4 Pro');
  });

  test('x0.00 的免费模型倍率原样保留（不能被当成 falsy 丢掉）', () => {
    const doc = {
      data: {
        models: [{ id: 'free', credits: 'x0.00 credits', maxInputTokens: 1000 }],
        agents: [{ name: 'cli', models: ['free'] }],
      },
    };
    const [m] = parseModelDocument(doc);
    assert.equal(m.credits, 'x0.00 credits', 'x0.00 表示不扣积分，是有意义的值');
  });
});

describe('parseModelDocument：结构缺失时的边界', () => {
  test('白名单为空时不做过滤（宁可多列，也不要清空整个目录）', () => {
    const doc = {
      data: {
        models: [{ id: 'a' }, { id: 'b' }],
        agents: [{ name: 'cli', models: [] }],
      },
    };
    assert.equal(parseModelDocument(doc).length, 2, '空白名单视作「不限」而不是「全禁」');
  });

  test('没有 agents 字段时同样不过滤', () => {
    const doc = { data: { models: [{ id: 'a' }] } };
    assert.equal(parseModelDocument(doc).length, 1);
  });

  test('agents 里没有 name=cli 的项时不过滤', () => {
    const doc = { data: { models: [{ id: 'a' }], agents: [{ name: 'app', models: ['zzz'] }] } };
    assert.equal(parseModelDocument(doc).length, 1, '只有 app 通道不应把 CLI 目录清空');
  });

  test('结构完全不对时返回空数组而不抛错', () => {
    for (const bad of [null, undefined, {}, { data: null }, { data: 'x' }, { data: {} }]) {
      assert.deepEqual(parseModelDocument(bad), [], `应安全返回空数组：${JSON.stringify(bad)}`);
    }
  });

  test('models 里的脏元素被跳过（缺 id / 为 null）', () => {
    const doc = { data: { models: [{ id: 'ok' }, null, {}, { name: '没有 id' }] } };
    assert.deepEqual(parseModelDocument(doc).map((m) => m.id), ['ok']);
  });
});

describe('parseModelDocument：两个端点结构相同', () => {
  test('同一份 data 结构既能解析 /v3/config 也能解析旧接口', () => {
    // 实测两个端点的 data.models / data.agents 形状完全一致，
    // 差别只在 v3 顶层多一个 requestId。这里锁住「同一解析器可用」这个事实。
    const v3 = { ...fixture, requestId: 'abc' };
    const legacy = { ...fixture };
    assert.deepEqual(parseModelDocument(v3), parseModelDocument(legacy));
  });
});
