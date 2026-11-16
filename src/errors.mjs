// 上游业务错误分类：把「HTTP 状态码 + 报文」翻译成**语义**，而不是只看 429。
//
// 为什么需要这一层：上游的 429 至少混着四种东西 —— 真欠费、模型繁忙、排队、临时限流。
// 旧实现一律 `status === 429 → 额度耗尽`，于是一次临时限流会把账号冻结 6 小时，
// 用户看到的现象是「明明还有额度，号却被判死半天」。
// 更麻烦的是中文文案「使用量已超出频率限制」里的「超出」命中了旧的额度正则，
// 一次普通的限流被误判成欠费 —— 这不是理论风险，是旧正则的直接后果。
//
// 设计原则：
//   1. **只做分类，不做决策**。谁该冷却多久、要不要换号，由调用方（pool / upstream）决定；
//   2. **不硬编码未经验证的业务码**。14018 / 14003 / 6004 这类码只作为「线索」参与判断，
//      真正起作用的是状态码与文案；遇到未知码一律记日志而不是猜；
//   3. 纯函数、无 IO、无全局状态，便于单测覆盖。

/** 语义分类结果。命名与上游插件保持一致，便于两边对照排查。 */
export const KIND = {
  /** 积分/额度真的耗尽（欠费）。这类失败不会因为你等一会儿就恢复。 */
  HARD_CREDIT: 'hard_credit',
  /** 凭证失效：token 过期/被吊销，必须重新登录。 */
  CREDENTIAL: 'credential_rejected',
  /** 账号被风控/受限：换号通常有用，等一会儿没用。 */
  ACCOUNT_RESTRICTED: 'account_restricted',
  /** 内容策略拒绝：换号、等一会儿都没用，是请求内容的问题。 */
  POLICY: 'policy_reject',
  /** 渠道/客户端身份被拒（例如未经批准的客户端指纹）。 */
  CHANNEL: 'channel_reject',
  /** 模型繁忙：分钟级冷却即可。 */
  MODEL_BUSY: 'model_busy',
  /** 排队中：分钟级冷却即可。 */
  MODEL_QUEUE: 'model_queue',
  /** 临时限流：按 retryAt 或阶梯冷却，**不是欠费**。 */
  SOFT_RATE: 'soft_rate',
  /** 该站点没有这个模型：应换站点，不是换号。 */
  MODEL_NOT_FOUND: 'model_not_found',
  /** 请求本身有问题（400/422 等）：不该动账号状态。 */
  CLIENT: 'client',
  /** 上游服务端故障（5xx）：换号或换站点都可能有用。 */
  SERVER: 'server',
  /** 连接级失败（DNS/连接重置/超时）。 */
  TRANSPORT: 'transport',
  UNKNOWN: 'unknown',
};

/* ---------------- 文案标记 ----------------
 * 每条都是「实测/文档确认过」或「语义无歧义」的。宁可少列，
 * 也不要写 `/超出/` 这种会把「超出频率限制」一并算成欠费的模式。 */

/** 真欠费。注意：限额/限流的措辞不在这里。 */
const CREDIT_MARKERS = [
  /insufficient\s+(?:credit|credits|quota|balance|funds)/i,
  /no\s+available\s+(?:credit|credits|quota|balance)/i,
  /quota\s+(?:exceeded|exhausted|used\s+up)/i,
  /credit[s]?\s+(?:exhausted|used\s+up|not\s+enough)/i,
  /balance\s+(?:is\s+)?(?:not\s+enough|insufficient|zero)/i,
  /out\s+of\s+credit/i,
  /额度不足|积分不足|余额不足|额度已用完|积分已用完|余额已用完|额度已用尽|积分已用尽|余额已用尽|已用完额度|欠费|配额已用尽|额度用尽|积分用尽/,
];

/** 凭证失效（需要重新登录）。 */
const CREDENTIAL_MARKERS = [
  /invalid_grant|invalid_token|expired_token|token\s+expired|session\s+expired/i,
  /unauthorized|unauthenticated/i,
  /登录态.*(?:失效|过期)|未登录|请重新登录|重新登录/,
  /凭证.*(?:失效|过期)/,
];

/** 账号被风控/受限。 */
const RESTRICTED_MARKERS = [
  /account\s+(?:is\s+)?(?:restricted|suspended|banned|blocked)/i,
  /request\s+illegal/i,
  /risk\s+control/i,
  /账号.*(?:受限|被封|封禁|风控)|被风控|请求非法/,
  /\b11140\b/,
];

/** 内容策略拒绝。 */
const POLICY_MARKERS = [
  /content\s+(?:policy|filter|moderation)/i,
  /sensitive\s+content/i,
  /content\s+rejected/i,
  /内容.*(?:不合规|违规|审核不通过|被拒绝)|违反.*(?:政策|规范)/,
];

/** 渠道/客户端身份被拒。 */
const CHANNEL_MARKERS = [
  /unapproved\s+channel/i,
  /illegal\s+api\s+invocation/i,
  /channel\s+(?:reject|denied|forbidden)/i,
  /渠道.*(?:拒绝|未授权|审核)/,
];

/** 模型繁忙。 */
const BUSY_MARKERS = [
  /model\s+(?:is\s+)?busy/i,
  /service\s+(?:is\s+)?busy/i,
  /too\s+many\s+(?:concurrent|pending)\s+requests/i,
  /模型繁忙|服务繁忙|系统繁忙|繁忙/,
];

/** 排队。 */
const QUEUE_MARKERS = [
  /\bqueu(?:e|ed|ing)\b/i,
  /waiting\s+in\s+line/i,
  /排队|队列中|等待队列/,
];

/** 模型不存在。 */
const NOT_FOUND_MODEL_MARKERS = [
  /service\s+info\s+not\s+found/i,
  /model\s*\[[^\]]+\]\s*.*not\s+found/i,
  /no\s+such\s+model/i,
];

const hit = (markers, text) => markers.some((re) => re.test(text));

/**
 * 报文里是否出现了某个业务码。
 * 上游可能写成 `code=14018`、`"code":14018`、`code: 14018` 三种形态，这里统一覆盖。
 */
function statesCode(text, code) {
  const n = String(code);
  return new RegExp(`(?:^|[^\\d])${n}(?:[^\\d]|$)`).test(text);
}

/**
 * 从报文里解析「多久之后可以重试」。
 *
 * 只在报文明确给出时长时才返回；解析不出来就让调用方用阶梯冷却，
 * 不做「猜一个数字」这种事。
 * 上限 30 分钟：比这更长的等待用阶梯退避更合适，也避免一个离谱的数字把号锁死。
 */
export function parseRetryAfterMs(message = '') {
  const text = String(message || '');
  const MAX = 30 * 60_000;
  let ms = null;

  let m = text.match(/retry[-\s]?after[:\s]*(\d+(?:\.\d+)?)\s*(ms|millisecond|s|sec|second|m|min|minute)?s?/i);
  if (m) {
    const n = Number(m[1]);
    const unit = String(m[2] || 's').toLowerCase();
    const factor = unit.startsWith('ms') || unit.startsWith('millisecond')
      ? 1
      : unit.startsWith('m') && !unit.startsWith('ms') ? 60_000 : 1000;
    if (Number.isFinite(n)) ms = n * factor;
  }
  if (ms === null) {
    m = text.match(/(\d+)\s*(?:秒|s)\s*(?:后|之后再)/i);
    if (m) ms = Number(m[1]) * 1000;
  }
  if (ms === null) {
    m = text.match(/(\d+)\s*(?:分钟|min(?:ute)?s?)\s*(?:后|之后再)/i);
    if (m) ms = Number(m[1]) * 60_000;
  }
  if (ms === null) return null;
  if (!(ms > 0)) return null;
  return Math.min(Math.round(ms), MAX);
}

/**
 * 分类一次上游失败。
 *
 * @param {number} status HTTP 状态码；连接级失败可传 0。
 * @param {string} message 上游报错原文（可能是 JSON 信封，也可能是纯文本）。
 * @returns {{
 *   kind: string,
 *   credit: boolean,        // 是否「真的没额度」
 *   accountLevel: boolean,  // 是否账号级问题（换号才有意义）
 *   retriable: boolean,     // 这件事换一个账号重试是否有意义
 *   retryAfterMs: number|null,
 *   code: string|null,
 * }}
 */
export function classifyError(status = 0, message = '') {
  const code = Number(status) || 0;
  const text = String(message || '');
  const lower = text.toLowerCase();

  const build = (kind, extra = {}) => ({
    kind,
    credit: kind === KIND.HARD_CREDIT,
    accountLevel: [KIND.HARD_CREDIT, KIND.CREDENTIAL, KIND.ACCOUNT_RESTRICTED, KIND.SOFT_RATE].includes(kind),
    retriable: [KIND.HARD_CREDIT, KIND.CREDENTIAL, KIND.ACCOUNT_RESTRICTED, KIND.SOFT_RATE, KIND.SERVER, KIND.TRANSPORT].includes(kind),
    retryAfterMs: parseRetryAfterMs(text),
    code: code || null,
    ...extra,
  });

  // 连接级失败没有 HTTP 状态码
  if (!code) return build(KIND.TRANSPORT);

  // 顺序很重要：先排除「看起来像限流其实不是」的类别，最后才轮到 429。
  if (code === 402) return build(KIND.HARD_CREDIT);
  if (hit(CREDIT_MARKERS, text)) return build(KIND.HARD_CREDIT);
  if (statesCode(text, 14018)) return build(KIND.HARD_CREDIT);

  if (code === 401 || hit(CREDENTIAL_MARKERS, text)) return build(KIND.CREDENTIAL);
  if (hit(RESTRICTED_MARKERS, text)) return build(KIND.ACCOUNT_RESTRICTED);
  if (hit(POLICY_MARKERS, text)) return build(KIND.POLICY);
  if (hit(CHANNEL_MARKERS, text)) return build(KIND.CHANNEL);
  if (hit(BUSY_MARKERS, text) || statesCode(text, 14003)) return build(KIND.MODEL_BUSY);
  if (hit(QUEUE_MARKERS, text) || statesCode(text, 6020) || statesCode(text, 6021) || statesCode(text, 6022)) {
    return build(KIND.MODEL_QUEUE);
  }

  if (code === 429) return build(KIND.SOFT_RATE);
  if (code === 404) {
    return hit(NOT_FOUND_MODEL_MARKERS, text) || /model/i.test(lower)
      ? build(KIND.MODEL_NOT_FOUND)
      : build(KIND.CLIENT);
  }
  if (code >= 500) return build(KIND.SERVER);
  if (code >= 400) {
    if (hit(NOT_FOUND_MODEL_MARKERS, text)) return build(KIND.MODEL_NOT_FOUND);
    return build(KIND.CLIENT);
  }

  // 200 里的业务错误：只能靠文案判断，判断不出就当作未知（不动账号状态）
  return build(KIND.UNKNOWN);
}

/**
 * 是否属于「这个账号现在拿不到额度」：真欠费，或临时限流。
 *
 * 保留这个函数名是为了兼容既有调用点（站点降级判断），
 * 但语义已收窄：普通 4xx、模型不存在、内容策略都不再算「额度类」。
 */
export function isQuotaError(status, message = '') {
  const { kind } = classifyError(status, message);
  return kind === KIND.HARD_CREDIT || kind === KIND.SOFT_RATE;
}

/**
 * 是否只影响「这个账号」，换个号值得一试。
 * 调用方据此决定「换号重试」还是「原样返回给客户端」。
 */
export function isAccountScopedError(status, message = '') {
  return classifyError(status, message).accountLevel;
}

/**
 * 描述分类结果，用于日志与错误提示。
 * 目标是让用户在日志里一眼看出「是欠费还是限流」，而不是只看到一个 429。
 */
export function describeKind(kind) {
  switch (kind) {
    case KIND.HARD_CREDIT: return '额度耗尽';
    case KIND.CREDENTIAL: return '凭证失效';
    case KIND.ACCOUNT_RESTRICTED: return '账号受限';
    case KIND.POLICY: return '内容策略拒绝';
    case KIND.CHANNEL: return '渠道拒绝';
    case KIND.MODEL_BUSY: return '模型繁忙';
    case KIND.MODEL_QUEUE: return '排队中';
    case KIND.SOFT_RATE: return '临时限流';
    case KIND.MODEL_NOT_FOUND: return '模型不存在';
    case KIND.CLIENT: return '请求无效';
    case KIND.SERVER: return '上游故障';
    case KIND.TRANSPORT: return '连接失败';
    default: return '未知错误';
  }
}
