import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 内置明文库（用户明确选择「不设主密码」，按明文 JSON 存盘）。
 *
 * ⚠️ 这个文件本身就是安全边界的全部：条目以**明文**写入磁盘，
 * 任何能读到该文件的进程都能看到全部密码。界面文案必须如实说明，
 * 不能写成"加密存储 / 本地安全存储"之类误导性说法。
 *
 * 设计约束：
 *  - 只由 Host 半部调用（client 半部在浏览器里，没有 fs 权限）；
 *  - 对外的元数据投影与 PC 密匣的 ApiEntryView 完全一致，
 *    这样 6 个工具不管切到哪个模式，行为都不变；
 *  - 敏感字段（password / note / totp 种子 / api_key 等）绝不出现在元数据里。
 *
 * 数据只放一份，位置：%APPDATA%/MimaVault/builtin-vault.json（Windows），
 * Web 界面一律通过宿主 HTTP 路由间接访问，不直接读文件。
 */

/** 分类专属字段里「值即凭据」的键，元数据里打码 */
const SECRET_EXTRA_KEYS = new Set(['api_key', 'bank_cvv', 'bank_card_no', 'id_number']);
const MASK = '***';

/** 会被 30 秒自动清除的字段 */
const SECRET_COPY_FIELDS = new Set([
  'password', 'note', 'totpUri',
  'api_key', 'bank_cvv', 'bank_card_no', 'id_number',
]);

/**
 * TOTP 输入规范化：
 *  - 完整 otpauth:// 链接 → 原样保留（重新规范化大小写）
 *  - 纯 Base32 密钥（如 JBSWY3DPEHPK3PXP）→ 包成标准 otpauth URI
 *  - 空 → 空
 *  - 非法输入 → 返回空并让上层提示（不静默写入解不开的字符串）
 */
export function normalizeTotpUri(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (/^otpauth:\/\//i.test(raw)) return raw;
  const secret = raw.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z2-7]+=*$/.test(secret) && secret.replace(/=+$/, '').length >= 8) {
    return `otpauth://totp/MimaVault?secret=${secret}&issuer=MimaVault&algorithm=SHA1&digits=6&period=30`;
  }
  return '';
}

const CATEGORIES = ['网站', '应用', '其他', 'WiFi', '银行卡', '证件', 'API Key'];

export function defaultStorePath() {
  const base = process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming');
  return path.join(base, 'MimaVault', 'builtin-vault.json');
}

/** 时间戳（毫秒） */
const now = () => Date.now();

/** 投影成可安全外泄的元数据（与 ApiEntryView 同形） */
function metadata(e) {
  const extraOut = {};
  for (const [k, v] of Object.entries(e.extra || {})) {
    if (v == null || v === '') continue;
    extraOut[k] = SECRET_EXTRA_KEYS.has(k) ? MASK : v;
  }
  return {
    id: e.id,
    category: e.category || '网站',
    platform: e.platform || '',
    account: e.account || '',
    email: e.email || '',
    phone: e.phone || '',
    hasPassword: !!(e.password),
    hasTotp: !!(e.totpUri),
    hasImage: !!(e.imagePath),
    favorite: !!e.favorite,
    noteLength: (e.note || '').length,
    updatedAt: e.updatedAt || 0,
    extra: extraOut,
  };
}

export class BuiltinStore {
  constructor(filePath = defaultStorePath()) {
    this.filePath = filePath;
    this.state = this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (data && data.schema === 1 && Array.isArray(data.entries)) {
        return data;
      }
    } catch {
      // 文件不存在或损坏，按空库处理
    }
    return { schema: 1, nextId: 1, entries: [] };
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf8');
    fs.renameSync(tmp, this.filePath);
  }

  count() {
    return this.state.entries.length;
  }

  /** 清空全部条目（不可恢复，调用方负责二次确认 + 可选备份） */
  clear() {
    const removed = this.state.entries.length;
    this.state = { schema: 1, nextId: 1, entries: [] };
    this.save();
    return { removed };
  }

  /** 导出明文快照，供清除前自动留备份用 */
  snapshot() {
    return JSON.stringify(this.state);
  }

  /** 从快照恢复（仅在库为空时允许，避免覆盖新数据） */
  restore(snapshotText) {
    if (this.state.entries.length > 0) {
      throw new Error('库非空，拒绝覆盖式恢复');
    }
    const data = JSON.parse(snapshotText);
    if (!data || data.schema !== 1 || !Array.isArray(data.entries)) {
      throw new Error('快照格式不正确');
    }
    this.state = data;
    this.save();
    return { restored: data.entries.length };
  }

  /** 追加一条（导入用）；返回新 id */
  insert(raw) {
    const id = this.state.nextId++;
    const e = {
      id,
      category: CATEGORIES.includes(raw.category) ? raw.category : '网站',
      platform: String(raw.platform || ''),
      account: String(raw.account || ''),
      password: String(raw.password || ''),
      phone: String(raw.phone || ''),
      email: String(raw.email || ''),
      note: String(raw.note || ''),
      imagePath: '',
      totpUri: normalizeTotpUri(raw.totpUri),
      extra: { ...(raw.extra || {}) },
      favorite: false,
      createdAt: now(),
      updatedAt: now(),
    };
    this.state.entries.push(e);
    return e;
  }

  /** 修改一条（面板编辑用；只改传入字段） */
  update(id, patch) {
    const e = this.byId(id);
    if (!e) throw new Error(`条目 #${id} 不存在`);
    for (const k of ['category', 'platform', 'account', 'password', 'phone', 'email',
      'note', 'favorite']) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) e[k] = patch[k];
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'totpUri')) {
      e.totpUri = normalizeTotpUri(patch.totpUri);
    }
    if (patch.extra && typeof patch.extra === 'object') e.extra = { ...patch.extra };
    e.updatedAt = now();
    return e;
  }

  /** 删除一条 */
  remove(id) {
    const before = this.state.entries.length;
    this.state.entries = this.state.entries.filter((e) => e.id !== id);
    return { removed: before - this.state.entries.length };
  }

  byId(id) {
    return this.state.entries.find((e) => e.id === Number(id)) || null;
  }

  /** 元数据投影 */
  metadata(id) {
    const e = this.byId(id);
    return e ? metadata(e) : null;
  }

  /**
   * 搜索：平台/账号/手机/邮箱/备注 + 分类专属字段值（备注可命中但不回内容）。
   * 与 PC 密匣的 includeNote 语义一致。
   */
  search({ query = '', category = '', limit = 20 } = {}) {
    const kw = String(query || '').trim().toLowerCase();
    const cat = String(category || '').trim();
    let hits = this.state.entries.filter((e) => {
      if (cat && cat !== '全部' && e.category !== cat) return false;
      if (!kw) return true;
      const fields = [e.platform, e.account, e.phone, e.email, e.note];
      for (const v of fields) {
        if (v && String(v).toLowerCase().includes(kw)) return true;
      }
      for (const v of Object.values(e.extra || {})) {
        if (v && String(v).toLowerCase().includes(kw)) return true;
      }
      return false;
    });
    hits.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const total = hits.length;
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    const page = hits.slice(0, n);
    return {
      query: String(query || ''),
      category: cat,
      total,
      returned: page.length,
      limit: n,
      items: page.map(metadata),
    };
  }

  /** 取某个字段的明文（内部使用，绝不直接回给模型） */
  field(id, name) {
    const e = this.byId(id);
    if (!e) return '';
    switch (name) {
      case 'password': return e.password || '';
      case 'note': return e.note || '';
      case 'platform': return e.platform || '';
      case 'account': return e.account || '';
      case 'email': return e.email || '';
      case 'phone': return e.phone || '';
      case 'totpUri': return e.totpUri || '';
      default: return (e.extra || {})[name] || '';
    }
  }

  isSecretField(name) {
    return SECRET_COPY_FIELDS.has(name) || SECRET_EXTRA_KEYS.has(name);
  }

  /** 生成随机口令（纯本地 crypto，不经过模型） */
  generate(opts = {}) {
    const length = Math.max(6, Math.min(128, Number(opts.length) || 24));
    const upper = opts.upper !== false;
    const lower = opts.lower !== false;
    const digits = opts.digits !== false;
    const symbols = opts.symbols !== false;
    let chars = '';
    if (upper) chars += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    if (lower) chars += 'abcdefghijklmnopqrstuvwxyz';
    if (digits) chars += '0123456789';
    if (symbols) chars += '!@#$%^&*-_=+?';
    if (opts.excludeAmbiguous !== false) {
      chars = chars.replace(/[0O1lI]/g, '');
    }
    if (!chars) chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    for (let i = 0; i < length; i++) {
      out += chars[crypto.randomInt(0, chars.length)];
    }
    return out;
  }

  /** 由 otpauth URI 生成当前 TOTP（RFC 6238，纯本地） */
  totp(id) {
    const e = this.byId(id);
    if (!e || !e.totpUri) return null;
    const cfg = parseOtpauth(e.totpUri);
    if (!cfg) return null;
    const t = now();
    const code = generateTotp(cfg, t);
    const period = cfg.period || 30;
    return {
      code,
      remainingSeconds: period - Math.floor((t / 1000) % period),
      period,
      digits: cfg.digits || 6,
    };
  }

  /**
   * 导入密匣导出的明文 CSV（本地解析，不经过 AI）。
   * 表头别名与 MimaVault 的 CsvUtil 对齐；支持 UTF-8 BOM、引号转义、内嵌换行。
   */
  importCsv(text) {
    const rows = parseCsv(text);
    if (rows.length === 0) throw new Error('CSV 为空');
    const header = rows[0].map(normalizeHeader);
    const idx = (...names) => {
      for (const n of names) {
        const i = header.indexOf(normalizeHeader(n));
        if (i >= 0) return i;
      }
      return -1;
    };
    const nameIdx = idx('name', 'title', '标题', '名称', '平台', '平台名称');
    const userIdx = idx('username', 'login', '登录名', '账号', '用户名', '用户', '帐号');
    const pwdIdx = idx('password', '密码');
    const noteIdx = idx('notes', 'note', '备注', '注释');
    const emailIdx = idx('email', '邮箱');
    const phoneIdx = idx('phone', '手机', '手机号');
    const totpIdx = idx('totp', 'otpauth', '2fa', '验证码');
    if (nameIdx < 0 && userIdx < 0 && pwdIdx < 0) {
      throw new Error('CSV 表头未找到可识别的名称/账号/密码列');
    }
    const extraCols = [
      ['wifi_ssid', 'wifi_ssid', 'network_name', '网络名'],
      ['wifi_encryption', 'wifi_encryption', 'encryption', '加密方式'],
      ['bank_card_no', 'bank_card_no', 'card_number', 'cardno', '卡号'],
      ['bank_holder', 'bank_holder', 'card_holder', 'holder', '持卡人'],
      ['bank_expiry', 'bank_expiry', 'card_expiry', 'expiry', '有效期'],
      ['bank_cvv', 'bank_cvv', 'card_cvv', 'cvv'],
      ['bank_name', 'bank_name', 'bank', '银行'],
      ['id_type', 'id_type', '证件类型'],
      ['id_number', 'id_number', 'idno', '证件号'],
      ['id_name', 'id_name', '姓名'],
      ['id_authority', 'id_authority', '签发机关'],
      ['id_expiry', 'id_expiry', '证件有效期'],
      ['api_key', 'api_key', 'apikey', 'key', '密钥'],
      ['api_endpoint', 'api_endpoint', 'endpoint', '接口地址'],
      ['api_model', 'api_model', 'model', '模型'],
    ].map(([key, ...aliases]) => ({ key, i: idx(...aliases) }));

    const cell = (row, i) => {
      if (i < 0 || i >= row.length) return '';
      return String(row[i] ?? '').trim();
    };
    let added = 0;
    let skipped = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const platform = cell(row, nameIdx);
      const account = cell(row, userIdx);
      const password = cell(row, pwdIdx);
      const note = cell(row, noteIdx);
      const extra = {};
      for (const c of extraCols) {
        if (c.i >= 0) {
          const v = cell(row, c.i);
          if (v) extra[c.key] = v;
        }
      }
      const totpUri = normalizeTotpUri(cell(row, totpIdx));
      if (!platform && !account && !password && !note && !totpUri && Object.keys(extra).length === 0) {
        skipped++;
        continue;
      }
      // 推断分类：有专属字段就归到对应分类，否则网站
      let category = '网站';
      if (extra.api_key || extra.api_endpoint || extra.api_model) category = 'API Key';
      else if (extra.wifi_ssid || extra.wifi_encryption) category = 'WiFi';
      else if (extra.bank_card_no || extra.bank_cvv || extra.bank_holder) category = '银行卡';
      else if (extra.id_number || extra.id_name) category = '证件';
      this.insert({
        category,
        platform,
        account,
        password,
        note,
        email: cell(row, emailIdx),
        phone: cell(row, phoneIdx),
        totpUri,
        extra,
      });
      added++;
    }
    if (added > 0) this.save();
    return { added, skipped };
  }
}

// ==================== 纯函数工具 ====================

function normalizeHeader(s) {
  return String(s || '').trim().toLowerCase().replace(/^﻿/, '').replace(/\s+/g, '');
}

/** CSV 状态机：支持双引号包裹、内部引号双写、逗号、CRLF/LF、内嵌换行 */
export function parseCsv(text) {
  let s = String(text || '');
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      row.push(cur);
      cur = '';
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
      row.push(cur);
      cur = '';
      if (row.some((v) => v !== '')) rows.push(row);
      row = [];
    } else {
      cur += c;
    }
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (cur !== '' || row.length > 0) {
    row.push(cur);
    if (row.some((v) => v !== '')) rows.push(row);
  }
  return rows;
}

/** 解析 otpauth://totp/... URI */
export function parseOtpauth(uri) {
  try {
    const u = new URL(uri);
    if (u.protocol !== 'otpauth:' || u.hostname !== 'totp') return null;
    const secret = (u.searchParams.get('secret') || '').replace(/\s+/g, '').toUpperCase();
    if (!secret) return null;
    const digits = Math.max(6, Math.min(8, Number(u.searchParams.get('digits')) || 6));
    const period = Math.max(1, Number(u.searchParams.get('period')) || 30);
    const algo = (u.searchParams.get('algorithm') || 'SHA1').toUpperCase();
    return {
      secret,
      digits,
      period,
      algorithm: ['SHA1', 'SHA256', 'SHA512'].includes(algo) ? algo : 'SHA1',
    };
  } catch {
    return null;
  }
}

/** RFC 4226/6238 HOTP 动态截断 */
export function generateTotp(cfg, timeMillis) {
  const key = base32Decode(cfg.secret);
  if (!key.length) throw new Error('TOTP 密钥无效');
  const counter = Math.floor(timeMillis / 1000 / (cfg.period || 30));
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const algoMap = { SHA1: 'sha1', SHA256: 'sha256', SHA512: 'sha512' };
  const mac = crypto.createHmac(algoMap[cfg.algorithm] || 'sha1', key).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24)
    | ((mac[offset + 1] & 0xff) << 16)
    | ((mac[offset + 2] & 0xff) << 8)
    | (mac[offset + 3] & 0xff);
  const mod = 10 ** (cfg.digits || 6);
  return String(bin % mod).padStart(cfg.digits || 6, '0');
}

/** Base32 (RFC 4648) 解码 */
export function base32Decode(input) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const i = alphabet.indexOf(ch);
    if (i < 0) continue;
    bits += i.toString(2).padStart(5, '0');
  }
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    out.push(parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(out);
}
