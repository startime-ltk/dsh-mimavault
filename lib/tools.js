import { defineTool } from '@deepseek-ai/dsh-tools';
import {
  allowedHostsFor,
  hostOf,
  injectCredential,
  isHostAllowed,
  pickCredentialField,
  truncate,
} from './guard.js';

/**
 * 6 个面向模型的工具。
 *
 * 设计红线（贯穿全部工具）：
 *  - 任何工具的返回值里**不得出现**密码明文、API Key 明文、TOTP 种子、备注内容。
 *  - "要明文"的两个合法出口是：`vault_copy`（由 MimaVault 写剪贴板）与
 *    `vault_call_api`（只在插件进程内注入出站请求，用完即弃）。
 */

const CATEGORIES = ['网站', '应用', '其他', 'WiFi', '银行卡', '证件', 'API Key'];

/** 输出统一为"宽松对象 + 文本渲染"，避免为每个工具重复写 schema */
function textOutput(title) {
  return {
    schema: { type: 'object', additionalProperties: true, properties: {} },
    render: (_args, value) => [
      {
        type: 'text',
        text: `【${title}】\n` + JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * @param {import('./client.js').VaultClient} client
 * @param {{ maxResponseBytes?: number, allowedHosts?: string[] }} opts
 */
export function makeTools(client, opts = {}) {
  const maxResponseBytes = opts.maxResponseBytes ?? 20000;
  const extraAllowedHosts = opts.allowedHosts ?? [];

  // ---------- 1. 检索 ----------
  const search = defineTool({
    name: 'vault_search',
    description:
      '检索本机 MimaVault 密码库中的条目（网站登录、API Key、动态令牌等）。' +
      '只返回元数据：分类/平台/账号/邮箱/是否有密码/是否绑定 TOTP/分类专属字段。' +
      '密码明文、备注内容、TOTP 种子一律不返回；api_key 之类会打码成 ***。' +
      '备注内容会参与关键词匹配，因此可以用它来"找得到但看不到"。' +
      '若密匣未解锁会返回明确提示。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '关键词：平台名、账号、邮箱、手机号、备注片段，或分类专属字段值（如接口地址）。',
      },
      category: {
        type: 'string',
        description: `分类过滤，留空为全部。可选：${CATEGORIES.join(' / ')}`,
      },
      limit: {
        type: 'integer',
        description: '返回条数上限，默认 20，最大 100。',
      },
    },
    output: textOutput('vault_search'),
    async execute(args) {
      const data = await client.search({
        query: args.query ?? '',
        category: args.category ?? '',
        limit: args.limit ?? 20,
      });
      return {
        total: data.total,
        returned: data.returned,
        items: data.items,
        hint: '要使用密码：vault_copy(id, "password") 复制到剪贴板；要动态验证码：vault_totp(id)；要用令牌调接口：vault_call_api。',
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `检索密码库: ${args.query}`, kind: 'read', rawInput: args }),
  });

  // ---------- 2. 单条元数据 ----------
  const entry = defineTool({
    name: 'vault_entry',
    description: '按 id 读取单条密码库条目的元数据（不含任何明文凭据）。',
    parameters: {
      id: { type: 'integer', required: true, description: 'vault_search 返回的条目 id。' },
    },
    output: textOutput('vault_entry'),
    async execute(args) {
      return await client.entry(args.id);
    },
    presentCall: (args) => ({ card: 'generic', title: `读取条目 #${args.id}`, kind: 'read', rawInput: args }),
  });

  // ---------- 3. 复制到剪贴板 ----------
  const copy = defineTool({
    name: 'vault_copy',
    description:
      '把条目的某个字段复制到系统剪贴板，由 MimaVault 自己完成（明文不经过本插件、也不进入对话）。' +
      '密码/API Key/备注复制后 30 秒自动清除剪贴板；普通字段不自动清除。' +
      '复制完成后请告诉用户：内容已在剪贴板，可以直接粘贴。',
    parameters: {
      id: { type: 'integer', required: true, description: '条目 id。' },
      field: {
        type: 'string',
        description:
          '要复制的字段：password（默认）/ account / email / phone / platform / note / api_key / ' +
          'bank_cvv / bank_card_no / id_number，或任意分类专属字段名。',
      },
    },
    output: textOutput('vault_copy'),
    async execute(args) {
      const field = args.field || 'password';
      const data = await client.copy(args.id, field);
      return {
        ...data,
        message:
          data.clearsInSeconds > 0
            ? `已把 ${field} 复制到剪贴板，${data.clearsInSeconds} 秒后自动清除。明文不会出现在对话里。`
            : `已把 ${field} 复制到剪贴板。`,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `复制条目 #${args.id} 的 ${args.field || 'password'}`,
      kind: 'other',
      rawInput: args,
    }),
  });

  // ---------- 4. 动态验证码 ----------
  const totp = defineTool({
    name: 'vault_totp',
    description:
      '获取条目绑定的 TOTP 动态验证码（6 位数字）及剩余有效秒数。' +
      '验证码是短时效值，可以安全展示给用户。',
    parameters: {
      id: { type: 'integer', required: true, description: '条目 id。' },
    },
    output: textOutput('vault_totp'),
    async execute(args) {
      return await client.totp(args.id);
    },
    presentCall: (args) => ({ card: 'generic', title: `动态验证码 #${args.id}`, kind: 'read', rawInput: args }),
  });

  // ---------- 5. 生成口令 ----------
  const generate = defineTool({
    name: 'vault_generate',
    description:
      '生成一个新的随机口令（与密码库中既有条目无关）。可直接返回明文给用户，' +
      '也可以顺带复制到剪贴板（copy=true，30 秒自动清除）。',
    parameters: {
      length: { type: 'integer', description: '长度，默认 24，范围 6-128。' },
      upper: { type: 'boolean', description: '包含大写字母，默认 true。' },
      lower: { type: 'boolean', description: '包含小写字母，默认 true。' },
      digits: { type: 'boolean', description: '包含数字，默认 true。' },
      symbols: { type: 'boolean', description: '包含符号，默认 true。' },
      excludeAmbiguous: { type: 'boolean', description: '排除易混淆字符 0/O/1/l/I，默认 true。' },
      copy: { type: 'boolean', description: '是否同时复制到剪贴板，默认 false。' },
    },
    output: textOutput('vault_generate'),
    async execute(args) {
      const body = {
        length: args.length ?? 24,
        upper: args.upper ?? true,
        lower: args.lower ?? true,
        digits: args.digits ?? true,
        symbols: args.symbols ?? true,
        excludeAmbiguous: args.excludeAmbiguous ?? true,
        copy: args.copy ?? false,
      };
      return await client.generate(body);
    },
    presentCall: () => ({ card: 'generic', title: '生成随机口令', kind: 'other' }),
  });

  // ---------- 6. 代理调用 ----------
  const callApi = defineTool({
    name: 'vault_call_api',
    description:
      '用密码库中某条目保存的 API Key/令牌，代替你向外部接口发起请求。' +
      '凭据在插件进程内注入，**不会出现在你的上下文里**，你只会拿到对方的响应。' +
      '出于安全：目标域名必须与该条目 api_endpoint 登记的域名一致，否则会被拒绝；' +
      '不自动跟随 HTTP 跳转（3xx 会把 Location 返回给你自行判断）。',
    parameters: {
      id: { type: 'integer', required: true, description: '提供凭据的条目 id（通常是 API Key 分类）。' },
      method: {
        type: 'string',
        description: 'HTTP 方法：GET/POST/PUT/PATCH/DELETE/HEAD，默认 GET。',
      },
      url: { type: 'string', required: true, description: '完整请求地址（http/https）。' },
      body: { type: 'string', description: '请求体原文（字符串）。' },
      contentType: { type: 'string', description: '请求体 Content-Type，默认 application/json。' },
      auth: {
        type: 'string',
        description: '凭据注入方式：bearer（默认，Authorization: Bearer xxx）/ header / query。',
      },
      headerName: { type: 'string', description: 'auth=header 时的头名，默认 X-API-Key。' },
      queryParam: { type: 'string', description: 'auth=query 时的参数名，默认 key。' },
    },
    output: textOutput('vault_call_api'),
    async execute(args) {
      const method = String(args.method || 'GET').toUpperCase();
      const allowedMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
      if (!allowedMethods.includes(method)) {
        throw new Error(`不支持的 HTTP 方法: ${method}`);
      }

      // 1) 取元数据：既用于确认条目存在，也用于推导域名白名单
      const meta = await client.entry(args.id);
      const targetHost = hostOf(args.url);
      const allowed = allowedHostsFor(meta, extraAllowedHosts);
      if (allowed.size === 0) {
        throw new Error(
          '该条目没有登记 api_endpoint，无法确定允许访问的域名。请先在密匣里填写该条目的「接口地址」。',
        );
      }
      if (!isHostAllowed(targetHost, allowed)) {
        throw new Error(
          `拒绝访问：目标域名 ${targetHost} 不在该条目允许的范围内（${[...allowed].join(', ')}）。` +
            '如需放行其它域名，请修改该条目的 api_endpoint，或在插件配置的 allowedHosts 中显式添加。',
        );
      }

      // 2) 取凭据并注入（值只在本次请求内存在）
      const field = pickCredentialField(meta);
      if (!field) {
        throw new Error('该条目既没有 api_key 也没有密码，无法作为凭据使用。');
      }
      const secret = await client.secret(args.id, field);

      const url = new URL(args.url);
      const headers = { Accept: 'application/json' };
      if (args.body !== undefined && method !== 'GET' && method !== 'HEAD') {
        headers['Content-Type'] = args.contentType || 'application/json';
      }
      const injectedInto = injectCredential(headers, url, args.auth || 'bearer', secret, {
        headerName: args.headerName,
        queryParam: args.queryParam,
      });

      // 3) 发请求：不跟随跳转，避免白名单域名把凭据"接力"到别处
      let res;
      try {
        res = await fetch(url.toString(), {
          method,
          headers,
          body: method === 'GET' || method === 'HEAD' ? undefined : args.body,
          redirect: 'manual',
          signal: AbortSignal.timeout(client.requestTimeoutMs),
        });
      } catch (err) {
        throw new Error(`出站请求失败: ${err?.message || err}`);
      }

      const raw = method === 'HEAD' ? '' : await res.text();
      const cut = truncate(raw, maxResponseBytes);
      const out = {
        status: res.status,
        ok: res.ok,
        contentType: res.headers.get('content-type') || '',
        credentialField: field,
        injectedVia: injectedInto,
        truncated: cut.truncated,
        body: cut.text,
      };
      if (res.status >= 300 && res.status < 400) {
        out.redirectTo = res.headers.get('location') || '';
        out.note = '目标返回了跳转，已按安全策略不自动跟随。如确需访问跳转目标，请确认其域名也在允许范围内后再发起。';
      }
      return out;
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `${String(args.method || 'GET').toUpperCase()} ${args.url}`,
      kind: 'other',
      rawInput: { id: args.id, method: args.method, url: args.url },
    }),
  });

  return [search, entry, copy, totp, generate, callApi];
}
