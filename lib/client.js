import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 本地 API 客户端。
 *
 * 对应 MimaVault 侧 `com.mimavault.api.LocalApiServer`：
 * 只在 MimaVault 已解锁期间可用，端口/token 从 `%APPDATA%\MimaVault\api.json` 读取。
 */

/** 客户端错误：带可判定的 code，便于工具层给出可操作提示 */
export class VaultError extends Error {
  /**
   * @param {string} code not_running | unauthorized | locked | http | timeout | bad_descriptor | network
   * @param {string} message 面向用户/模型的中文说明
   * @param {Record<string, unknown>} [detail]
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'VaultError';
    this.code = code;
    this.detail = detail ?? {};
  }
}

/** 默认描述文件位置，与 AppConfig.LOCATOR_FILE 同目录 */
export function defaultDescriptorPath() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.mimavault');
  return path.join(base, 'MimaVault', 'api.json');
}

export class VaultClient {
  constructor(options = {}) {
    this.apiJsonPath = options.apiJsonPath || defaultDescriptorPath();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 8000;
    this.maxResponseBytes = options.maxResponseBytes ?? 20000;
    this.allowedHosts = Array.isArray(options.allowedHosts) ? options.allowedHosts : [];
  }

  /** 读取并校验描述文件；密匣没开时抛 not_running */
  descriptor() {
    let raw;
    try {
      raw = fs.readFileSync(this.apiJsonPath, 'utf8');
    } catch {
      throw new VaultError(
        'not_running',
        `MimaVault 未运行或本地 API 未开启（读不到 ${this.apiJsonPath}）。` +
          '请在密匣托盘菜单中勾选「Local API (DSH)」，并保持程序登录状态。',
      );
    }
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      throw new VaultError('bad_descriptor', `描述文件不是合法 JSON: ${this.apiJsonPath}`);
    }
    if (!d || typeof d.port !== 'number' || typeof d.token !== 'string' || d.token.length === 0) {
      throw new VaultError('bad_descriptor', `描述文件缺少 port/token: ${this.apiJsonPath}`);
    }
    return d;
  }

  get baseUrl() {
    const d = this.descriptor();
    return { base: `http://127.0.0.1:${d.port}`, token: d.token, port: d.port };
  }

  /**
   * 调一次本地 API。
   * @param {string} method
   * @param {string} pathname 以 /v1 开头的路径，可含查询串
   * @param {{ body?: unknown, headers?: Record<string,string> }} [opts]
   */
  async call(method, pathname, opts = {}) {
    const { base, token } = this.baseUrl;
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) };
    let payload;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(opts.body);
    }

    let res;
    try {
      res = await fetch(base + pathname, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (err) {
      if (err?.name === 'TimeoutError') {
        throw new VaultError('timeout', `MimaVault 本地 API 响应超时（${this.requestTimeoutMs}ms）`);
      }
      throw new VaultError(
        'network',
        `无法连接 MimaVault 本地 API（${base}）。可能密匣刚被锁定或已退出。`,
        { cause: String(err?.message || err) },
      );
    }

    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // 非 JSON 响应，保留原文片段
    }

    if (!res.ok) {
      const code = data?.error || `http_${res.status}`;
      const msg = data?.message || text?.slice(0, 300) || `HTTP ${res.status}`;
      if (res.status === 401 && code === 'locked') {
        throw new VaultError('locked', '密匣已锁定，请打开 MimaVault 并重新登录后重试。');
      }
      if (res.status === 401) {
        throw new VaultError('unauthorized', '本地 API 凭据无效：密匣可能已重启，请重试一次。');
      }
      throw new VaultError(String(code), msg, { status: res.status });
    }
    return data;
  }

  /** 健康检查：可区分"没开"与"锁着" */
  async health() {
    return this.call('GET', '/v1/health');
  }

  /** 检索条目元数据（不含任何明文凭据） */
  async search({ query = '', category = '', limit = 20 } = {}) {
    const qs = new URLSearchParams();
    if (query) qs.set('q', query);
    if (category) qs.set('category', category);
    if (limit) qs.set('limit', String(limit));
    return this.call('GET', `/v1/search?${qs.toString()}`);
  }

  /** 单条目元数据 */
  async entry(id) {
    return this.call('GET', `/v1/entries/${encodeURIComponent(String(id))}`);
  }

  /** 让 MimaVault 自己把字段写入系统剪贴板（明文不经过本插件） */
  async copy(id, field) {
    return this.call('POST', `/v1/entries/${encodeURIComponent(String(id))}/copy`, { body: { field } });
  }

  /** 取当前动态验证码（短时效，可安全展示） */
  async totp(id) {
    return this.call('GET', `/v1/entries/${encodeURIComponent(String(id))}/totp`);
  }

  /** 生成新口令（非库中既有秘密） */
  async generate(options = {}) {
    return this.call('POST', '/v1/generate', { body: options });
  }

  /**
   * 取明文，**仅供代理调用注入出站请求**。
   * 调用方必须保证该值不进入工具返回值。
   */
  async secret(id, field) {
    const data = await this.call('POST', `/v1/entries/${encodeURIComponent(String(id))}/secret`, {
      body: { field },
      headers: { 'X-MimaVault-Purpose': 'proxy' },
    });
    return data?.value ?? '';
  }
}
