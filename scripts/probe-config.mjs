// 上游配置端点探针（开发用，不参与运行时代码）。
//
// 用途：`/v3/config` 的响应结构目前**没有确认过**——
// 我们知道它存在（插件用同一端点读模型目录），但不知道模型清单在响应里的路径，
// 也不知道 CLI 通道如何被筛选。缺这两点就无法安全地写解析代码：
// 按猜的字段名写，读错时表现为「目录一直为空、静默退回内置清单」，比现状更难排查。
//
// 所以先抓一次真实响应，看清结构再下笔。这个脚本只做三件事：
//   1. 用本项目的账号（不是插件的）发一次 GET；
//   2. 打印结构骨架：键名、类型、数组长度，**不打印 token 与正文**；
//   3. 把「看起来像模型清单」的位置指出来，附每个模型对象的字段名。
//
// 用法：
//   node login.mjs --site cn-cli          # 先登录（一次性）
//   node scripts/probe-config.mjs         # 默认探 cn-cli
//   node scripts/probe-config.mjs intl-cli
//   node scripts/probe-config.mjs cn-cli --dump   # 额外把完整 JSON 存到 .probe-config.json
//
// 安全：输出里不出现 accessToken、不出现 cookie；--dump 的文件写在本项目目录内，
// 已在 .gitignore 里登记，且只含响应体（不含任何请求头）。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, paths, siteKeys } from '../src/config.mjs';
import { ensureToken } from '../src/auth.mjs';
import { chatHeaders } from '../src/headers.mjs';
import { log, warn } from '../src/log.mjs';

const args = process.argv.slice(2);
const dump = args.includes('--dump');
const siteArg = args.find((a) => !a.startsWith('--'));

const cfg = loadConfig();
const site = siteArg || cfg.defaultSite;

if (!cfg.sites?.[site]) {
  console.error(`未知站点：${site}\n可用站点：${siteKeys(cfg).join(', ')}`);
  process.exit(1);
}

const siteCfg = cfg.sites[site];
const TIMEOUT_MS = Number(cfg.timeouts?.metaMs) || 30_000;

/** 描述一个值的骨架，不展开长字符串内容。 */
function shape(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (typeof v === 'object') return `Object(${Object.keys(v).length} keys)`;
  if (typeof v === 'string') return v.length > 60 ? `string(${v.length} chars)` : `string "${v}"`;
  return `${typeof v} ${v}`;
}

/** 递归打印键路径，数组只展开第一个元素（看元素的字段就够）。 */
function walk(node, prefix = '', depth = 0, out = []) {
  if (depth > 6 || node === null || typeof node !== 'object') return out;
  const isArr = Array.isArray(node);
  if (isArr) {
    if (node.length === 0) {
      out.push(`${prefix} [] (空数组)`);
      return out;
    }
    out.push(`${prefix} Array(${node.length})`);
    walk(node[0], `${prefix}[0]`, depth + 1, out);
    return out;
  }
  for (const [k, v] of Object.entries(node)) {
    const p = prefix ? `${prefix}.${k}` : k;
    out.push(`${p} = ${shape(v)}`);
    if (v && typeof v === 'object') walk(v, p, depth + 1, out);
  }
  return out;
}

/** 判断某个数组「看起来像模型清单」：元素是对象且带 id / name。 */
function looksLikeModelList(v) {
  if (!Array.isArray(v) || v.length === 0) return false;
  const first = v[0];
  if (!first || typeof first !== 'object') return false;
  return typeof first.id === 'string' || typeof first.name === 'string' || typeof first.model === 'string';
}

/** 在整棵树里找「像模型清单」的数组，返回它们的位置与元素字段。 */
function findModelLists(node, prefix = '', depth = 0, hits = []) {
  if (depth > 6 || node === null || typeof node !== 'object') return hits;
  if (looksLikeModelList(node)) {
    hits.push({ path: prefix, count: node.length, keys: Object.keys(node[0] || {}) });
  }
  for (const [k, v] of Object.entries(node)) {
    findModelLists(v, prefix ? `${prefix}.${k}` : k, depth + 1, hits);
  }
  return hits;
}

async function main() {
  log(`探测 ${site} 的 /v3/config（只读 GET，不发聊天请求）`);

  let token, account;
  try {
    ({ token, account } = await ensureToken(cfg, site));
  } catch (e) {
    console.error('');
    console.error(`无法取得凭据：${e.message}`);
    console.error(`请先运行：node login.mjs --site ${site}`);
    process.exit(2);
  }

  const auth = account || { accessToken: token };
  const url = siteCfg.apiBase + '/v3/config';
  log(`GET ${url}`);
  log(`身份：uid=${String(auth.uid || '').slice(0, 8)}…  domain=${auth.domain || '（无）'}`);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('timeout')), TIMEOUT_MS);
  let res, text;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: { ...chatHeaders(siteCfg, auth), Accept: 'application/json' },
      signal: ac.signal,
    });
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    console.error(`请求失败：${e.message}`);
    process.exit(3);
  }
  clearTimeout(timer);

  console.log('');
  console.log(`HTTP ${res.status}    Content-Type: ${res.headers.get('content-type') || '（无）'}    ${text.length} 字节`);
  if (res.status !== 200) {
    console.log('');
    console.log('响应前 500 字符（排查用，不含请求头）：');
    console.log(text.slice(0, 500));
    console.log('');
    console.log('结论：该端点在这个站点/身份下不可用，3.5 第 1 条无法推进。');
    process.exit(4);
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    console.log('');
    console.log('响应不是 JSON（前 500 字符）：');
    console.log(text.slice(0, 500));
    process.exit(5);
  }

  console.log('');
  console.log('=== 顶层结构 ===');
  for (const line of walk(json)) console.log('  ' + line);

  console.log('');
  console.log('=== 看起来像模型清单的位置 ===');
  const hits = findModelLists(json);
  if (!hits.length) {
    console.log('  未找到。可能模型清单不在顶层对象里，或元素字段名与预期不同。');
    console.log('  请人工看下面的完整骨架，或加 --dump 存下来分析。');
  } else {
    for (const h of hits) {
      console.log(`  路径：${h.path || '（根）'}   元素数：${h.count}`);
      console.log(`  元素字段：${h.keys.join(', ')}`);
    }
  }

  // 信封判定：顶层有没有 code 字段，值是什么
  console.log('');
  console.log('=== 信封判定 ===');
  if ('code' in json) {
    console.log(`  顶层有 code = ${JSON.stringify(json.code)}（本项目约定 code===0 为成功）`);
  } else {
    console.log('  顶层没有 code 字段 —— 与旧接口 /v2/enterprises/personal/models 的信封不同，解析逻辑要分开写。');
  }

  if (dump) {
    const out = path.join(paths.root, '.probe-config.json');
    fs.writeFileSync(out, JSON.stringify(json, null, 2), 'utf8');
    console.log('');
    console.log(`完整响应已存到：${out}（已加入 .gitignore，不含任何请求头或凭证）`);
  } else {
    console.log('');
    console.log('提示：加 --dump 可把完整响应存到本项目内的 .probe-config.json 供逐字段核对。');
  }
}

main().catch((e) => {
  warn('探针异常：', e.message);
  process.exit(1);
});
