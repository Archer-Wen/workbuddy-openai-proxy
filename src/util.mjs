// HTTP 小工具：请求体读取、响应写出（含背压）、SSE 帧写出、原子写盘。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_BODY = 16 * 1024 * 1024;

export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error('请求体过大（上限 16MB）'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

export function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  if (res.headersSent) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function sendError(res, status, message, type = 'upstream_error') {
  sendJson(res, status, { error: { message, type, code: status } });
}

/** 带背压的写出：客户端读得慢时等待 drain，避免内存堆积。 */
export function writeAsync(res, chunk) {
  if (res.destroyed || res.writableEnded) return Promise.resolve(false);
  return new Promise((resolve) => {
    const ok = res.write(chunk);
    if (ok) resolve(true);
    else res.once('drain', () => resolve(true));
  });
}

export function startSSE(res, extraHeaders = {}) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...extraHeaders,
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

export function writeSSE(res, payload) {
  return writeAsync(res, `data: ${payload}\n\n`);
}

export function writeSSEEvent(res, event, payload) {
  return writeAsync(res, `event: ${event}\ndata: ${payload}\n\n`);
}

export function estimateTokens(text) {
  if (!text) return 0;
  // 粗略估算：中英混排按 3 字符 ≈ 1 token
  return Math.max(1, Math.ceil(String(text).length / 3));
}

/**
 * 原子写 JSON：先写同目录下的临时文件，再 `rename` 覆盖目标。
 *
 * 为什么必须这样做：`writeFileSync` 不是原子的。它先截断目标文件再写入，
 * 中途被杀（Ctrl+C、崩溃、关机、安全软件拦截）就留下**半截 JSON**。
 * 而本项目所有状态文件（config / auth / pool / usage）在读取解析失败时
 * 都会「视作空」——于是半截池文件意味着**所有账号凭空消失**，
 * 半截 config.json 意味着用户配置被清空。rename 在 POSIX 与 NTFS 上都是原子的，
 * 目标文件要么是旧的完整内容，要么是新的完整内容，不会有第三种可能。
 *
 * 额外注意两点：
 *   - 临时文件名带 pid + 随机串，避免两个进程（服务 + login.mjs）同时写时互相覆盖；
 *   - 权限位在**创建临时文件时**就给出，而不是写完再 chmod —— 后者有一个
 *     短暂的时间窗口，凭证文件在此期间是可被同机其他用户读取的。
 */
export function writeJsonAtomic(file, data, { mode, trailingNewline = true } = {}) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  const text = JSON.stringify(data, null, 2) + (trailingNewline ? '\n' : '');
  const opts = { encoding: 'utf8' };
  if (mode !== undefined) opts.mode = mode;
  let fd;
  try {
    fd = fs.openSync(tmp, 'w', opts.mode);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd); // 确保内容已落盘，再 rename
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 忽略 */
      }
    }
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 忽略 */
    }
    throw e;
  }
  return file;
}
