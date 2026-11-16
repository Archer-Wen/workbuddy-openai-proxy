# 上游实现对照：与 `dsh-connect-workbuddy` 的异同

这一页回答一个问题：**同样是「用 WorkBuddy / CodeBuddy 的账号额度转发成 OpenAI 协议」，
本项目和 DSH 里的 `dsh-connect-workbuddy` 插件差在哪、哪些地方该学、哪些不该学。**

| 对照对象 | 版本 | 形态 |
|---|---|---|
| 本项目 | `1.4.0` | 零依赖 Node ESM 本地 HTTP 代理（`server.mjs` + `src/`） |
| `dsh-connect-workbuddy` | `5.24.2` | DSH 插件，编译产物在 `lib/`（可读未压缩） |

> **口径**：以下全部来自**静态源码阅读**，没有发起任何上游请求、没有读取本机真实凭证或账号池数据、
> 也没有跑测试。因此结论只到「机制层面」——能说明两者分别怎么写，不能说明上游今天怎么答。
> 插件是编译产物，注释与 README 偶有过期之处（例如 `cordis.patch.yml` 里「不需要独立 OAuth」的旧说法），
> 本文一律**以代码为准**。

---

## 一、骨架是一样的：两边都在打同一个上游

这部分不是「像」，而是**同一套协议**：

| 环节 | 本项目 | 插件 |
|---|---|---|
| 聊天端点 | `POST {apiBase}/v2/chat/completions`<br>[upstream.mjs:287](../src/upstream.mjs#L287) | `POST {chatBase}/v2/chat/completions` |
| 客户端身份 | UA `CLI/2.63.2 CodeBuddy/2.63.2`、`X-Product: SaaS`<br>[headers.mjs:13](../src/headers.mjs#L13)、[headers.mjs:24](../src/headers.mjs#L24) | 同款 UA |
| 鉴权头族 | `Authorization: Bearer` + `X-User-Id` / `X-Enterprise-Id` / `X-Domain`（或 `X-No-*`）<br>[headers.mjs:21](../src/headers.mjs#L21)–[29](../src/headers.mjs#L29) | 同族，加 `X-No-*` 兜底 |
| 刷新端点 | `POST /v2/plugin/auth/token/refresh`<br>[auth.mjs:213](../src/auth.mjs#L213) | 同一端点，同样只在该请求里带 `X-Refresh-Token` |
| 响应形态 | SSE `data:` 帧，`choices[].delta` | 同 |
| 工具执行位置 | 下游客户端 | 下游客户端 |

两个重要推论：

1. **协议兼容性问题可以互相抄答案。** 插件踩过的坑（业务错误放在 200 的流里、
   某些模型拒绝 `reasoning` 字段、工具调用可能以标记文本而不是 `tool_calls` 下发）
   在两边是同一批坑。
2. **但两边的产品边界不同，不能整体移植。** 插件要服务 DSH 的 PiAiAdapter，
   所以额外背了回环 shim、Turing SDK、设备指纹、区域双栈；
   本项目是「本机自用反代」，这些一点都用不上。

---

## 二、真正的差异（按影响排序）

| 维度 | 本项目 | 插件 | 影响 |
|---|---|---|---|
| **错误语义** | `status === 429` 直接判「额度耗尽」<br>[pool.mjs:459](../src/pool.mjs#L459)，耗尽 TTL **6 小时**<br>[pool.mjs:35](../src/pool.mjs#L35) | 先分 `hard_credit`（402 / 欠费文本 / 业务码 14018），再 `session_dead`、`account_restricted`、`policy_reject`、`channel_reject`、`model_busy`（14003）、`model_queue`，**剩下**的 429 才算 `soft_rate`<br>`classifyUpstreamError()` 见插件 `lib/host-heartbeat-*.js:4169` | 最大的一处。临时限流会被放大成半天不可用 |
| **成功判定时机** | HTTP 一通过就 `markSuccess()`<br>[upstream.mjs:394](../src/upstream.mjs#L394) | 读到首个有效帧才算可用，账号级拒绝直接回池 | 200 + 业务错误码的响应会把坏号记成健康号 |
| **200 里的业务错误** | `classifyFrame()` 认出错误帧后只是往客户端吐一条 `error`，然后 `break`<br>[upstream.mjs:450](../src/upstream.mjs#L450)、[openai.mjs:178](../src/openai.mjs#L178) | 首帧即分类，账号级失败触发换号 | 错误帧完全绕过了号池与站点降级 |
| **换号条件** | 任何非 ok 状态都 `markFailure` + 换号，**含 HTTP 400**<br>[upstream.mjs:720](../src/upstream.mjs#L720) | 客户端错误 / 模型繁忙 / 渠道拒绝**不换号** | 400 是请求内容问题，换号纯亏 |
| **模型目录来源** | `GET {apiBase}/console/enterprises/personal/models`，只取 `agents.name === 'cli'`<br>[upstream.mjs:571](../src/upstream.mjs#L571) | 国际区对同一 `/v3/config` 分别用 CLI 与 App 两套身份读、再合并；国内区失败才退旧接口 | CLI 通道的答复是 App 通道的子集，本项目只能看到 CLI 那份 |
| **目录缓存键** | 只按 `site` 缓存<br>[router.mjs:66](../src/router.mjs#L66) | 目录区分 live 与静态兜底，静态来源不冒充实测 | 多账号下 A 号的目录会命中给 B 号 |
| **SSE 解析** | 只认行首 `data:`，不支持空行分帧 / 多行事件<br>[upstream.mjs:413](../src/upstream.mjs#L413) | UTF-8 carry + 空行分帧 + 非法 JSON 透传 | 本项目够用但更脆 |
| **工具调用兜底** | 只依赖原生 `tool_calls`；仅做 developer→system、清指纹句、`tool_choice` 规整<br>[upstream.mjs:69](../src/upstream.mjs#L69) | 无 `tool_calls` 时做 DSML 标记恢复 + schema 推断 + 工具名模糊修复，且只在**尚未吐出内容**时补一次请求 | 思路可借鉴，但不能默认模糊执行 |
| **超时** | 头超时 90s / 空闲 300s / 元数据 30s，连接重试 3 次<br>[config.mjs:174](../src/config.mjs#L174) | `chatStream` 自身**无超时**，靠适配层 idle 300s | 这一项**本项目更完整** |
| **落盘** | `config` / `auth` / `pool` / `usage` 全是直接 `writeFileSync`<br>[config.mjs:580](../src/config.mjs#L580)、[auth.mjs:119](../src/auth.mjs#L119)、[pool.mjs:154](../src/pool.mjs#L154)、[usage.mjs:51](../src/usage.mjs#L51) | `writeFileAtomic()` + `withFileLock()`，无宿主时降级到 fallback 实现 | 进程被杀的瞬间可能写出半截 JSON |
| **凭据来源** | 自建 OAuth 设备码，不依赖桌面端<br>[device-login.mjs:24](../src/device-login.mjs#L24) | 自带登录/导入 + 桌面 auth 只读发现 + vault 加密 | 产品边界不同，**各有各的道理** |

---

## 三、值得借鉴的部分（按性价比排序）

> **落地状态（v1.5）**：3.1 / 3.2 / 3.3 / 3.4 **已实施**；
> 3.5 三项**全部已实施**，但第 1 条的结论与原先的建议**相反** ——
> 实测发现两个端点互不包含，正确做法是「取并集」而不是「换主源 + 兜底」，见该节。

### 3.1 统一「业务错误分类器」，同时覆盖 HTTP 层与首帧

现状是两个互相矛盾的判定并存：

- 号池把「任何 429」当额度耗尽，锁 6 小时（[pool.mjs:459](../src/pool.mjs#L459)、[pool.mjs:35](../src/pool.mjs#L35)）；
- 排障文档也据此写成「429 → 6 小时后自动重试」
  （[troubleshooting.md:185](troubleshooting.md#L185)）。

而上游的 429 至少混着四种东西：真欠费、模型繁忙、排队、临时限流。
把它们折叠成「6 小时」，用户看到的现象就是「明明还有额度，号却被判死半天」。

建议引入一个纯函数分类器，返回**语义**而不是 HTTP 状态码：

```
分类结果：欠费 / 凭据失效 / 账号受限 / 内容策略 / 渠道拒绝 / 模型繁忙 / 排队 / 临时限流 / 客户端错误 / 服务端错误
```

对应不同的恢复路径：

- **欠费** → 标记耗尽，但**不靠时钟自动解除**，只在额度查询读到正余额或成功请求后才解除；
- **模型繁忙 / 排队** → 短冷却（分钟级），不标记耗尽；
- **临时限流** → 有 `retryAt` 用 `retryAt`，没有就用阶梯冷却（本项目已有 `COOLDOWN_STEPS_MS`，
  [pool.mjs:38](../src/pool.mjs#L38)）；
- **凭据失效 / 账号受限** → 不进入「等一会儿会好」的队列，直接要求重新登录或禁用；
- **客户端错误（400/422）** → 完全不进号池。

插件那套判定顺序（先 `hard_credit`，再 session / restricted / policy / channel / busy / queue，
最后才 `soft_rate`）可以直接当顺序参考，但**业务码不要照抄魔数**——
14018 / 14003 这类码需要实测确认，本项目应在遇到时记日志而不是硬编码。

### 3.2 `markSuccess` 改到「首个有效帧之后」

现在 HTTP 200 就清空失败计数（[upstream.mjs:394](../src/upstream.mjs#L394)），
但上游把额度类错误放在 200 的流里下发是常态。
结果是：这个号刚被判死，一次 200 空流又把 `exhaustedAt` 抹掉，然后下一轮再判死，
状态在「耗尽」和「健康」之间反复横跳。

同时，业务错误帧应该能**回流号池**：由 `classifyFrame()` 归类后交给
`markFailure` / `markExhausted`，再由上层决定「换号重试一次」还是「原样返回给客户端」。
这正是插件在首帧就分类的目的。

> 边界：**已经开始向客户端输出内容之后**不能再换号——否则客户端会收到两段拼接的答案。
> 只有在「尚未输出任何可见内容」时才允许重试一次，插件对 DSML 恢复也守同一条线。

### 3.3 HTTP 400 不该换号

400 在本项目里会先走上下文压缩重试（[upstream.mjs:284](../src/upstream.mjs#L284)），
压缩用尽后仍然失败，说明是请求本身的问题，此时再 `markFailure` + 换号
（[upstream.mjs:720](../src/upstream.mjs#L720)）只是白白消耗下一个账号的失败计数。

例外是 `11133 model_param_invalid`：这个码既可能是「输入太长」，也可能是别的参数问题，
现有实现已经在用体积估算区分，这里不需要改，
只要把「压缩用尽后的 400」排除出换号路径即可。

### 3.4 请求级凭据快照，替掉全局「当前账号」

这是本次对照里**最值得改的架构问题**，因为它是一个潜在竞态，而不只是风格问题：

```
ensureToken() 里 setCurrentAccount(site, a)   → auth.mjs:334
      ↓（中间隔着 await 刷新）
openChat() 里 const auth = getAuth(site)      → upstream.mjs:233
```

两次读取之间隔着一个 `await`。并发请求 + 某账号正在刷新时，
第二次读到的可能是**另一个账号**的 token（或刷新后的新 token 配旧账号头）。

推荐改法：让 `ensureToken()` 直接返回 `{ accountId, token }`，
把 token 也一并交给 `chatHeaders()`，彻底取消「先设置全局状态、再读回来」的隐式约定。
`fetchModels()`（[upstream.mjs:571](../src/upstream.mjs#L571)）、`queryCredit()`
等调用点同样改成显式传参。

> 说明：这只是**源码层面的风险判断**，没有复现出线上错发。
> 但只要池里有两个号、且并发请求碰到刷新窗口，这条路径就是可达的。

### 3.5 目录：换来源、换缓存键、原子落盘

三件小事，收益独立：

1. **来源**：`/v3/config` 的信息量比 `console/enterprises/personal/models` 多
   （带 `modelPromotions` / `modelTiers`）。
   **已实施**，但**原建议「`/v3/config` 主源 + 旧接口兜底」是错的**，实测推翻了它：

   > 2026-11 用真实账号（`cn-cli`）各抓了一次响应，结构如下 ——
   > 两个端点的**模型部分完全同构**，顶层则只差一个 `requestId`：
   >
   > ```
   > /v3/config                         /console/enterprises/personal/models
   > { code, msg, requestId, data }     { code, msg, data }
   > data.models[]        ← 全量 33 个   data.models[]        ← 全量模型表
   > data.agents[]        ← CLI 通道     data.agents[]        ← CLI 通道
   >   └ name==='cli'                     └ name==='cli'
   >       └ models[] ← 16 个 id 白名单       └ models[] ← 16 个 id 白名单
   > ```
   >
   > 关键实测结果：**两者的 CLI 可用集合互不包含** ——
   > 旧接口独有 `auto`（虚拟自动路由，且是 `config.json` 里 `seedModels` 的默认项），
   > `/v3/config` 独有 `minimax-m2.7`，交集 15 个。
   >
   > 所以「主源 + 兜底」是错的：兜底意味着正常情况下旧接口根本不读，
   > 于是 `auto` 会从目录里直接消失。**正确做法是两路都读、取并集**，
   > 任何一路失败都不影响另一路（已按此实现，实测两路都在时 16 → 17 个模型）。
   >
   > 另一个原先没料到的点：`/v3/config` **不返回 `supportsReasoning` 字段**（旧接口返回）。
   > 并集策略下以先读到的为准，`/v3/config` 在前的模型该字段为 `false`；
   > 对本项目无实际影响（渲染 `/v1/models` 时只用 `supportsToolCall` 等），
   > 但如果将来要用这个能力位，需要改成「按字段分别取非空值」而不是整条记录取先到者。
2. **缓存键**：从 `site` 扩到 `site + accountId`。不同账号的可用模型集合本来就不同，
   现在 A 号拉到的目录会被 B 号直接命中（[router.mjs:66](../src/router.mjs#L66)）。
   **已实施**：`fetchModels` 现在返回 `{ models, accountId, sources }`，
   `getCatalog` 按「站点 + 账号」分键缓存，同时保留一个不带账号的键让默认路径一次命中。
   `sources` 记录这次用了哪些端点，出问题时光看控制台就知道是哪一路缺失。
3. **落盘**：`auth` / `pool` / `config` / `usage` 四处统一改成「写临时文件 + `rename`」。
   零依赖前提下这个很好写，不需要引入任何包。
   **已实施**：新增 `writeJsonAtomic()`（`src/util.mjs`），四处全部接入，
   权限位在创建临时文件时就给定，不留 chmod 窗口期。

---

## 四、明确不借鉴

| 插件做法 | 为什么不抄 |
|---|---|
| 同凭据换中性头重试 + 零宽字符扰动绕过渠道审核 | 属于对抗性规避，副作用不可控，也不符合本项目「本机自用反代」的定位 |
| Turing SDK / 设备指纹虚拟化、虚拟机会话 ID | 为了在 App 侧伪装成官方客户端；本项目走 CLI 身份，不需要 |
| 读中断后仍补发 `[DONE]` | 会**掩盖截断**：客户端以为正常结束，实际输出不完整，比直接报错更难查 |
| 模糊匹配工具名后直接执行 | 工具名错一个字符就可能调用到错误函数。要做也必须 opt-in + 严格 schema 校验 |
| 回环 shim + 进程内 secret | 那是为了不把 token 交给 PiAiAdapter；本项目本身就是那个边界，不存在这个问题 |

---

## 五、还没验证的部分

以下结论**本轮已用真实请求验证**（2026-11，仅 `cn-cli` 一个账号）：

- ✅ `/v3/config` 在 CLI 身份下可读，顶层是 `{code,msg,requestId,data}`，`code===0` 为成功；
- ✅ 模型清单在 `data.models`，CLI 筛选靠 `data.agents[name=cli].models` 白名单；
- ✅ 两个端点的 CLI 可用集合互不包含（差集：`auto` / `minimax-m2.7`）。

仍然**没有验证**的部分：

- **国际区**（`intl-cli` / `intl-work`）：本机没有这两个区域的账号，
  `/v3/config` 在国际网关下是否同样可用、返回结构是否一致，一律未测。
  代码按「两路都试、任一路成即可」写，所以即使国际区没有 `/v3/config` 也会自动退回旧接口；
- **各站点 429 的实际语义分布**（欠费 / 繁忙 / 排队各占多少）——
  新分类器按文案与状态码判定，需要跑一段时间统计日志里的 `lastErrorKind` 才能校准；
- **上述竞态是否已在真实并发下发生过**：已按请求级快照改掉，
  但没有复现过原始错误，因此属于「消除了一条可达路径」而非「修复了已观测的故障」。
