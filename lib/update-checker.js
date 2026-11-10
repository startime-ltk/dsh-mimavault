import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 插件自身的检查更新（Host 半部，Node 环境）。
 *
 * 版本源只走 GitHub 直连 / 镜像 / Tags API，**不用 jsDelivr CDN 做主源** ——
 * MimaVault v8.35.4 实测 CDN 会把 version.txt 缓存成几个版本前的旧内容，
 * 加时间戳也无效，会让人"更新"回旧版。这里多源取**版本号最大者**。
 *
 * 版本清单（仓库根 version.txt，取第一个非空行）：
 *   版本|Release 页面 URL|一句话说明
 *   例：0.3.0|https://github.com/startime-ltk/dsh-mimavault/releases/tag/v0.3.0|双模式数据源
 */

const REPO = 'startime-ltk/dsh-mimavault';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const HOMEPAGE = `https://github.com/${REPO}`;

/** 本地版本号：读插件自己的 package.json */
export function localVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/** 版本源：不放 CDN，避免缓存旧版本 */
export const SOURCES = [
  { name: 'GitHub 直连', url: `https://raw.githubusercontent.com/${REPO}/main/version.txt` },
  { name: '镜像', url: `https://ghfast.top/https://raw.githubusercontent.com/${REPO}/main/version.txt` },
];

/**
 * 版本号比较：按 . - _ 分段，每段取首个连续数字块；无数字段按 0。
 * 支持 v 前缀（v0.3.0 == 0.3.0）；预发布段（含字母）按 0 处理，
 * 因此 0.3.0 > 0.3.0-rc.1 的粗略语义成立。
 */
export function compareVersions(a, b) {
  const parse = (s) => {
    const out = [];
    for (const part of String(s || '').trim().split(/[.\-_\s]+/)) {
      const m = /\d+/.exec(part);
      out.push(m ? parseInt(m[0], 10) : 0);
    }
    return out;
  };
  const va = parse(a), vb = parse(b);
  const n = Math.max(va.length, vb.length);
  for (let i = 0; i < n; i++) {
    const x = i < va.length ? va[i] : 0;
    const y = i < vb.length ? vb[i] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** 解析一行版本清单；非法返回 null */
export function parseVersionLine(line) {
  if (!line) return null;
  const parts = String(line).trim().split('|');
  if (parts.length < 2) return null;
  const version = parts[0].trim();
  const url = parts[1].trim();
  if (!version || !/\d/.test(version)) return null;
  return {
    version: version.replace(/^v/i, ''),
    url: url || RELEASES_URL,
    notes: (parts[2] || '').trim(),
  };
}

function firstNonEmptyLine(text) {
  for (const l of String(text || '').split(/\r?\n/)) {
    if (l.trim()) return l;
  }
  return null;
}

/** 从 GitHub tags API 构造一个兜底候选（无 token 时 60 次/小时，够用） */
async function tagsCandidate(fetchImpl, timeoutMs) {
  const res = await fetchImpl(`https://api.github.com/repos/${REPO}/tags?per_page=10`, {
    headers: { 'User-Agent': 'dsh-mimavault', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`tags API HTTP ${res.status}`);
  const tags = await res.json();
  if (!Array.isArray(tags) || tags.length === 0) throw new Error('tags 为空');
  let best = null;
  for (const t of tags) {
    const v = String(t.name || '').replace(/^v/i, '');
    if (!/\d/.test(v)) continue;
    if (!best || compareVersions(v, best.version) > 0) best = { version: v };
  }
  if (!best) throw new Error('没有可用的 tag');
  return {
    name: 'GitHub Tags API',
    candidate: {
      version: best.version,
      url: `${RELEASES_URL}/tag/v${best.version}`,
      notes: '来自 GitHub tags',
    },
  };
}

/**
 * 检查更新：多源（直连 / 镜像 / Tags API）取版本号最大者。
 *
 * @param {string} currentVersion 本地版本
 * @param {{ fetchImpl?: Function, timeoutMs?: number, now?: number }} [opts]
 */
export async function checkForUpdate(currentVersion, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? 8000;
  const checkedAt = opts.now ?? Date.now();
  const tried = [];
  const candidates = [];

  for (const s of SOURCES) {
    try {
      // 带时间戳绕过中间缓存；镜像与直连都加
      const sep = s.url.includes('?') ? '&' : '?';
      const res = await fetchImpl(`${s.url}${sep}t=${checkedAt}`, {
        headers: { 'User-Agent': 'dsh-mimavault', 'Cache-Control': 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = parseVersionLine(firstNonEmptyLine(await res.text()));
      if (!parsed) throw new Error('版本清单格式非法');
      candidates.push({ name: s.name, candidate: parsed });
      tried.push({ name: s.name, ok: true, version: parsed.version });
    } catch (e) {
      tried.push({ name: s.name, ok: false, error: String(e?.message || e) });
    }
  }

  // Tags API 兜底：只有两个文本源都失败时才问，避免无谓消耗 API 额度
  if (candidates.length === 0) {
    try {
      const t = await tagsCandidate(fetchImpl, timeoutMs);
      candidates.push(t);
      tried.push({ name: t.name, ok: true, version: t.candidate.version });
    } catch (e) {
      tried.push({ name: 'GitHub Tags API', ok: false, error: String(e?.message || e) });
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      currentVersion,
      hasUpdate: false,
      homepage: HOMEPAGE,
      releasesUrl: RELEASES_URL,
      checkedAt,
      sources: tried,
      message: '所有版本源均不可达，请检查网络后重试。',
    };
  }

  // 取版本号最大者（防镜像返回旧缓存）
  let best = candidates[0];
  for (const c of candidates.slice(1)) {
    if (compareVersions(c.candidate.version, best.candidate.version) > 0) best = c;
  }
  const latest = best.candidate;
  const hasUpdate = compareVersions(latest.version, currentVersion) > 0;

  return {
    ok: true,
    currentVersion,
    latestVersion: latest.version,
    hasUpdate,
    source: best.name,
    notes: latest.notes,
    releaseUrl: latest.url,
    releasesUrl: RELEASES_URL,
    homepage: HOMEPAGE,
    checkedAt,
    sources: tried,
    message: hasUpdate
      ? `发现新版本 ${latest.version}（当前 ${currentVersion}）`
      : `已是最新版本（${currentVersion}）`,
    // 本地 link 开发版不自动覆盖，给出可操作指引
    updateHint: hasUpdate
      ? '当前 profile 以 link: 挂的是本地开发目录，插件不会自动覆盖它。请到仓库拉取新版本后重启 DSH；或在 DSH 插件管理页用 install_bundle 重新安装。'
      : '',
  };
}
