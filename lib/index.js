import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VaultClient } from './client.js';
import { BuiltinStore, defaultStorePath } from './builtin-store.js';
import { externalBackend, builtinBackend } from './backend.js';
import { makeTools } from './tools.js';
import { writeBackup, readBackup, deleteBackup } from './clipboard.js';

/**
 * dsh-mimavault —— 把本机 MimaVault（密匣）密码库接进 DeepSeek Harness。
 *
 * 两种模式（侧栏面板里切换，配置持久化到 mode.json）：
 *  - external（默认，更安全）：读 PC 密匣的 loopback API，密钥不出密匣进程；
 *  - builtin：插件自带一份**明文**库，无需安装 PC 密匣，但不加密。
 *
 * ⚠️ builtin 是用户明确选择「不设密码」后的形态：条目明文存盘，
 * 界面文案必须如实说明，不得写成"加密/安全存储"。
 *
 * 宿主路由供侧栏面板（lib/client-panel.js，浏览器半部）使用：
 *   GET  /plugins/dsh-mimavault/status      当前模式与状态
 *   POST /plugins/dsh-mimavault/launch      external：尝试拉起密匣
 *   GET  /plugins/dsh-mimavault/config     读模式配置
 *   POST /plugins/dsh-mimavault/mode       切换模式
 *   POST /plugins/dsh-mimavault/import     导入明文 CSV（只进内置库）
 *   GET  /plugins/dsh-mimavault/clear      查询是否有待确认的清除请求
 *   POST /plugins/dsh-mimavault/clear/request   生成清除请求（AI 或按钮）
 *   POST /plugins/dsh-mimavault/clear/confirm   人点确认后才真正清空
 *   POST /plugins/dsh-mimavault/clear/cancel    取消待确认请求
 *   GET  /plugins/dsh-mimavault/entries   内置库元数据列表（面板用）
 *   POST /plugins/dsh-mimavault/entries  内置库新增/修改/删除（面板用）
 */

export const name = 'dsh-mimavault';
export const inject = ['tools'];

const APP_EXE = '密匣 MimaVault.exe';

function modeConfigPath() {
  const base = process.env.APPDATA
    || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming');
  return path.join(base, 'MimaVault', 'mode.json');
}

function loadModeConfig() {
  try {
    const d = JSON.parse(fs.readFileSync(modeConfigPath(), 'utf8'));
    if (d && (d.mode === 'external' || d.mode === 'builtin')) return d;
  } catch {
    // 默认更安全的外置模式
  }
  return { mode: 'external' };
}

function saveModeConfig(d) {
  const p = modeConfigPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(d, null, 2), 'utf8');
}

function candidateAppPaths() {
  const out = [];
  if (process.env.LOCALAPPDATA) {
    out.push(path.join(process.env.LOCALAPPDATA, 'Programs', '密匣 MimaVault', APP_EXE));
  }
  if (process.env.USERPROFILE) {
    out.push(path.join(process.env.USERPROFILE, 'Programs', '密匣 MimaVault', APP_EXE));
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    out.push(`${drive}:\\Programs\\密匣 MimaVault\\${APP_EXE}`);
  }
  return out;
}

function resolveAppPath(configured) {
  if (configured && fs.existsSync(configured)) return configured;
  for (const p of candidateAppPaths()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // 盘符不存在
    }
  }
  return null;
}

function isAppRunning() {
  return new Promise((resolve) => {
    execFile('tasklist', ['/FI', `IMAGENAME eq ${APP_EXE}`, '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) return resolve(false);
        resolve(String(stdout || '').includes(APP_EXE));
      });
  });
}

export function apply(ctx, config = {}) {
  const requestTimeoutMs = config.requestTimeoutMs ?? 8000;
  const maxResponseBytes = config.maxResponseBytes ?? 20000;
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];
  const enableBuiltinCallApi = config.enableBuiltinCallApi === true;

  const modeConfig = loadModeConfig();
  const storePath = config.storePath || defaultStorePath();

  const client = new VaultClient({
    apiJsonPath: config.apiJsonPath,
    requestTimeoutMs,
    maxResponseBytes,
    allowedHosts,
  });
  const store = new BuiltinStore(storePath);

  const extBackend = externalBackend(client);
  const intBackend = builtinBackend(store, { clearSeconds: 30 });

  /** 当前后端（可变引用）；切换模式时整体替换，工具层持有的是同一个 mutable holder */
  const holder = { backend: modeConfig.mode === 'builtin' ? intBackend : extBackend };

  /** 清除请求状态机：AI 只能 request，必须有人 confirm 才执行 */
  const clearState = {
    pending: null,
    lastResult: null,
    /** @returns {{token:string, expiresAt:number}} */
    request({ reason, source }) {
      const token = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 10);
      this.pending = {
        token,
        reason: String(reason || ''),
        source: String(source || 'panel'),
        createdAt: Date.now(),
        expiresAt: Date.now() + 5 * 60 * 1000, // 5 分钟有效
      };
      return { token, expiresAt: this.pending.expiresAt, reason: this.pending.reason };
    },
    info() {
      if (!this.pending) return { hasPending: false, lastResult: this.lastResult };
      if (Date.now() > this.pending.expiresAt) {
        this.pending = null;
        return { hasPending: false, expired: true, lastResult: this.lastResult };
      }
      return {
        hasPending: true,
        reason: this.pending.reason,
        source: this.pending.source,
        entries: store.count(),
        expiresAt: this.pending.expiresAt,
      };
    },
    confirm(token) {
      if (!this.pending) return { ok: false, message: '没有待确认的清除请求' };
      if (Date.now() > this.pending.expiresAt) {
        this.pending = null;
        return { ok: false, message: '请求已过期，请重新发起' };
      }
      if (token && token !== this.pending.token) {
        return { ok: false, message: '确认令牌不匹配' };
      }
      const backupPath = storePath + '.backup';
      let backupSaved = false;
      try {
        writeBackup(store.snapshot(), backupPath);
        backupSaved = true;
      } catch {
        // 备份失败仍允许清除，但结果里如实报告
      }
      const { removed } = store.clear();
      this.pending = null;
      this.lastResult = { ok: true, removed, backupSaved, backupPath: backupSaved ? backupPath : null };
      return this.lastResult;
    },
    cancel() {
      const had = !!this.pending;
      this.pending = null;
      return { ok: true, cancelled: had };
    },
    restore() {
      const backupPath = storePath + '.backup';
      try {
        const r = store.restore(readBackup(backupPath));
        this.lastResult = { ok: true, ...r, restoredFrom: backupPath };
        return this.lastResult;
      } catch (e) {
        return { ok: false, message: String(e?.message || e) };
      }
    },
  };

  // 工具注册：传入 mutable holder 的代理，让工具在运行时拿到当前后端
  const proxy = {
    get mode() { return holder.backend.mode; },
    search: (...a) => holder.backend.search(...a),
    entry: (...a) => holder.backend.entry(...a),
    copy: (...a) => holder.backend.copy(...a),
    totp: (...a) => holder.backend.totp(...a),
    generate: (...a) => holder.backend.generate(...a),
    secret: (...a) => holder.backend.secret(...a),
    health: (...a) => holder.backend.health(...a),
    status: (...a) => holder.backend.status(...a),
  };

  for (const tool of makeTools(proxy, {
    maxResponseBytes,
    allowedHosts,
    requestTimeoutMs,
    enableBuiltinCallApi,
    clearController: clearState,
  })) {
    ctx.tools.register(tool);
  }

  /** external 状态 */
  async function readStatus() {
    const appPath = resolveAppPath(config.appPath);
    if (holder.backend.mode === 'builtin') {
      const s = await intBackend.status();
      return { ok: true, ...s, appPath, appRunning: false, storePath, unencrypted: true };
    }
    try {
      const health = await client.health();
      return {
        ok: true, phase: 'ready', mode: 'external', appPath, appRunning: true,
        port: health?.port ?? null,
      };
    } catch (err) {
      const running = await isAppRunning();
      const code = err?.code;
      if (code === 'locked') {
        return { ok: true, phase: 'locked', mode: 'external', appPath, appRunning: running,
          port: null, message: '密匣已启动但未解锁：请登录并在托盘勾选 Local API (DSH)' };
      }
      if (!running) {
        return { ok: true, phase: appPath ? 'not_running' : 'no_app', mode: 'external',
          appPath, appRunning: false, port: null,
          message: appPath ? '密匣未运行' : '未找到密匣安装位置，请在插件配置里填 appPath' };
      }
      return { ok: true, phase: 'locked', mode: 'external', appPath, appRunning: true,
        port: null, message: '未读到本地 API 凭据：请在托盘勾选「Local API (DSH)」' };
    }
  }

  async function launch() {
    if (holder.backend.mode === 'builtin') return readStatus();
    const before = await readStatus();
    if (before.phase === 'ready' || before.phase === 'locked') return before;
    if (!before.appPath) return before;
    try {
      const child = spawn(before.appPath, [], {
        detached: true, stdio: 'ignore', windowsHide: false,
        cwd: path.dirname(before.appPath),
      });
      child.unref();
    } catch (err) {
      return { ...before, ok: false, message: `启动失败：${err?.message ?? err}` };
    }
    await new Promise((r) => setTimeout(r, 1500));
    return readStatus();
  }

  /** 统一 JSON 响应 */
  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  /** 读取请求体（带上限） */
  function readBody(req, maxBytes = 8 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          reject(new Error('请求体过大'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const routes = [
        ['GET', '/plugins/dsh-mimavault/status', async () => await readStatus()],
        ['POST', '/plugins/dsh-mimavault/launch', async () => await launch()],
        ['GET', '/plugins/dsh-mimavault/config', async () => ({
          ok: true,
          mode: holder.backend.mode,
          storePath,
          entries: store.count(),
          unencrypted: true,
          enableBuiltinCallApi,
          note: '内置库为明文存储，不加密。',
        })],
        ['POST', '/plugins/dsh-mimavault/mode', async (req) => {
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          const mode = body.mode === 'builtin' ? 'builtin' : 'external';
          holder.backend = mode === 'builtin' ? intBackend : extBackend;
          const cfg = loadModeConfig();
          cfg.mode = mode;
          saveModeConfig(cfg);
          return { ok: true, mode, message: mode === 'builtin'
            ? '已切换到内置明文库（明文存盘，不加密）'
            : '已切换到 PC 密匣模式（密钥不出密匣进程）' };
        }],
        ['POST', '/plugins/dsh-mimavault/import', async (req) => {
          if (holder.backend.mode !== 'builtin') {
            return { ok: false, message: '只有内置库模式可以导入 CSV；PC 密匣请在密匣界面里导入。' };
          }
          const raw = await readBody(req);
          const body = raw ? JSON.parse(raw) : {};
          if (typeof body.csv !== 'string' || !body.csv.trim()) {
            return { ok: false, message: '缺少 csv 内容' };
          }
          const r = store.importCsv(body.csv);
          return { ok: true, ...r, entries: store.count(),
            message: `已导入 ${r.added} 条（跳过 ${r.skipped} 空行），当前共 ${store.count()} 条。` };
        }],
        ['GET', '/plugins/dsh-mimavault/entries', async () => ({
          ok: true, mode: holder.backend.mode,
          items: store.search({ query: '', limit: 100 }).items,
          total: store.count(),
        })],
        ['POST', '/plugins/dsh-mimavault/entries', async (req) => {
          if (holder.backend.mode !== 'builtin') return { ok: false, message: '仅内置库模式可编辑' };
          const body = JSON.parse((await readBody(req)) || '{}');
          const action = String(body.action || '');
          if (action === 'add') {
            const e = store.insert(body.entry || {});
            store.save();
            return { ok: true, id: e.id, entries: store.count() };
          }
          if (action === 'update') {
            store.update(body.id, body.patch || {});
            store.save();
            return { ok: true, entries: store.count() };
          }
          if (action === 'delete') {
            const r = store.remove(body.id);
            store.save();
            return { ok: true, ...r, entries: store.count() };
          }
          return { ok: false, message: '未知 action' };
        }],
        ['GET', '/plugins/dsh-mimavault/clear', async () => ({ ok: true, ...clearState.info() })],
        ['POST', '/plugins/dsh-mimavault/clear/request', async (req) => {
          const body = JSON.parse((await readBody(req)) || '{}');
          const r = clearState.request({ reason: body.reason, source: body.source || 'panel' });
          return { ok: true, ...r, message: '清除请求已生成，等待人工确认' };
        }],
        ['POST', '/plugins/dsh-mimavault/clear/confirm', async (req) => {
          const body = JSON.parse((await readBody(req)) || '{}');
          return clearState.confirm(body.token);
        }],
        ['POST', '/plugins/dsh-mimavault/clear/cancel', async () => clearState.cancel()],
        ['POST', '/plugins/dsh-mimavault/clear/restore', async () => clearState.restore()],
      ];

      const disposers = [];
      for (const [method, routePath, handler] of routes) {
        disposers.push(webCtx.webServer.register({
          kind: 'exact',
          path: routePath,
          handler: async (req, res) => {
            if (req.method !== method) {
              res.writeHead(405);
              res.end();
              return;
            }
            try {
              const body = await handler(req);
              sendJson(res, 200, body);
            } catch (e) {
              sendJson(res, 400, { ok: false, message: String(e?.message || e) });
            }
          },
        }));
      }
      return () => disposers.forEach((d) => d?.());
    });
  });
}
