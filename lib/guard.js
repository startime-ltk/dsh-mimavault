/**
 * 代理调用的安全护栏。
 *
 * 这是整个插件风险最高的一块：代理调用等于把一个"持有你令牌的 HTTP 客户端"交给模型。
 * 一旦被提示注入拐走，模型就可能让插件把 `Authorization: Bearer <真key>` 发到攻击者域名。
 *
 * 因此这里立三条硬规矩：
 *  1. **目标域名白名单**：默认只允许打到该条目 `api_endpoint` 里登记的域名，换域名直接拒绝。
 *  2. **不跟随跳转**：3xx 一律不自动跟随（否则白名单域名一个跳转就能把凭据送到别处）。
 *  3. **凭据只进不出**：注入后即从返回值中剔除，绝不回传给模型。
 */

/** 从 URL 取主机名；非法 URL 抛错 */
export function hostOf(rawUrl) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new Error(`URL 不合法: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`只允许 http/https，收到 ${u.protocol}`);
  }
  if (u.username || u.password) {
    throw new Error('URL 中不允许携带用户名/密码');
  }
  return u.hostname.toLowerCase();
}

/**
 * 汇总某个条目允许访问的主机名。
 *
 * 来源优先级：条目 `api_endpoint` 的 hostname → 插件配置里的全局 `allowedHosts`。
 * `platform` 字段是展示名（如 "OpenAI"），不参与白名单 —— 避免把任意字符串当域名。
 */
export function allowedHostsFor(entry, extraAllowed = []) {
  const hosts = new Set();

  const endpoint = entry?.extra?.api_endpoint;
  if (typeof endpoint === 'string' && endpoint.trim()) {
    try {
      hosts.add(new URL(endpoint).hostname.toLowerCase());
    } catch {
      // api_endpoint 不是合法 URL 就不贡献白名单
    }
  }

  for (const h of extraAllowed) {
    if (typeof h === 'string' && h.trim()) {
      hosts.add(h.trim().toLowerCase());
    }
  }
  return hosts;
}

/**
 * 判断目标主机是否被允许。
 * 支持精确匹配与 `*.example.com` 形式的前缀通配（通配需在配置里显式书写）。
 */
export function isHostAllowed(targetHost, allowedHosts) {
  const host = String(targetHost || '').toLowerCase();
  if (!host) return false;
  for (const rule of allowedHosts) {
    if (rule === host) return true;
    if (rule.startsWith('*.') && host.endsWith(rule.slice(1)) && host !== rule.slice(2)) {
      return true;
    }
  }
  return false;
}

/** 该条目该用哪个字段当凭据：优先 api_key，其次登录密码 */
export function pickCredentialField(entry) {
  const extra = entry?.extra || {};
  if (Object.prototype.hasOwnProperty.call(extra, 'api_key')) return 'api_key';
  if (entry?.hasPassword) return 'password';
  return null;
}

/**
 * 把凭据注入到出站请求。
 *
 * @param {Record<string,string>} headers 可变对象，直接写入
 * @param {URL} url 可变对象，query 模式会追加参数
 * @param {'bearer'|'header'|'query'} style
 * @param {string} value 凭据明文
 * @param {{ headerName?: string, queryParam?: string }} [names]
 */
export function injectCredential(headers, url, style, value, names = {}) {
  switch (style) {
    case 'header': {
      const name = names.headerName || 'X-API-Key';
      headers[name] = value;
      return `header:${name}`;
    }
    case 'query': {
      const param = names.queryParam || 'key';
      url.searchParams.set(param, value);
      return `query:${param}`;
    }
    case 'bearer':
    default:
      headers.Authorization = `Bearer ${value}`;
      return 'header:Authorization';
  }
}

/** 按字节上限截断响应体，避免把巨量内容灌进模型上下文 */
export function truncate(text, maxBytes) {
  const s = typeof text === 'string' ? text : '';
  if (maxBytes <= 0) return { text: '', truncated: s.length > 0 };
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated: true };
}
