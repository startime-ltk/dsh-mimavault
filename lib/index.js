import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { VaultClient } from './client.js';
import { makeTools } from './tools.js';

/**
 * dsh-mimavault —— 把本机 MimaVault（密匣）密码库接进 DeepSeek Harness。
 *
 * 插件本身**不接触加密数据**：它只是 MimaVault 本地回环 API 的客户端，
 * 密钥始终留在 MimaVault 进程里。MimaVault 未解锁时，所有工具都会返回
 * "密匣已锁定"的可操作提示。
 *
 * 除 6 个工具外，本插件还在宿主上暴露两条只读/启动用的 HTTP 路由，
 * 供侧栏面板（lib/client.js）使用：
 *   GET  /plugins/dsh-mimavault/status  —— 当前连接状态
 *   POST /plugins/dsh-mimavault/launch  —— 尝试拉起密匣（已运行则只回报状态）
 *
 * @see README.md 安全模型与部署步骤
 */

/** cordis 插件名 */
export const name = 'dsh-mimavault';

/** 依赖的工具注册表 */
export const inject = ['tools'];

/** 密匣启动器文件名 */
const APP_EXE = '密匣 MimaVault.exe';

/**
 * 候选安装路径：先看用户级安装目录，再扫各盘符的 Programs 目录。
 * 都找不到时由 status 回报 no_app，让用户用 appPath 配置指定。
 */
function candidateAppPaths() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    out.push(path.join(local, 'Programs', '密匣 MimaVault', APP_EXE));
  }
  const home = process.env.USERPROFILE;
  if (home) {
    out.push(path.join(home, 'Programs', '密匣 MimaVault', APP_EXE));
  }
  for (const drive of ['C', 'D', 'E', 'F', 'G', 'H', 'I']) {
    out.push(`${drive}:\\Programs\\密匣 MimaVault\\${APP_EXE}`);
  }
  return out;
}

/** 解析密匣可执行文件路径：配置优先，其次候选目录 */
function resolveAppPath(configured) {
  if (configured && fs.existsSync(configured)) {
    return configured;
  }
  for (const p of candidateAppPaths()) {
    try {
      if (fs.existsSync(p)) {
        return p;
      }
    } catch {
      // 盘符不存在等，忽略
    }
  }
  return null;
}

/**
 * 判断密匣进程是否在运行。
 *
 * tasklist 的过滤参数含中文，Windows 通过 UTF-16 命令行传递，不会乱码。
 * 任何异常都当作"未运行"处理 —— 这里只用于界面提示，不承担安全判断。
 */
function isAppRunning() {
  return new Promise((resolve) => {
    execFile(
      'tasklist',
      ['/FI', `IMAGENAME eq ${APP_EXE}`, '/NH'],
      { windowsHide: true, timeout: 5000 },
      (err, stdout) => {
        if (err) {
          resolve(false);
          return;
        }
        resolve(String(stdout || '').includes(APP_EXE));
      },
    );
  });
}

/**
 * 注册 6 个工具 + 侧栏面板用的宿主路由。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {{ apiJsonPath?: string, requestTimeoutMs?: number, maxResponseBytes?: number,
 *           allowedHosts?: string[], appPath?: string }} [config]
 */
export function apply(ctx, config = {}) {
  const requestTimeoutMs = config.requestTimeoutMs ?? 8000;
  const maxResponseBytes = config.maxResponseBytes ?? 20000;
  const allowedHosts = Array.isArray(config.allowedHosts) ? config.allowedHosts : [];

  const client = new VaultClient({
    apiJsonPath: config.apiJsonPath,
    requestTimeoutMs,
    maxResponseBytes,
    allowedHosts,
  });

  for (const tool of makeTools(client, { maxResponseBytes, allowedHosts })) {
    ctx.tools.register(tool);
  }

  /** 汇总一次状态：ready / locked / not_running / no_app */
  async function readStatus() {
    const appPath = resolveAppPath(config.appPath);
    let port = null;
    try {
      const health = await client.health();
      port = health?.port ?? null;
      return { ok: true, phase: 'ready', appPath, appRunning: true, port };
    } catch (err) {
      const code = err?.code;
      const running = await isAppRunning();
      if (code === 'locked') {
        return { ok: true, phase: 'locked', appPath, appRunning: running, port: null,
          message: '密匣已启动但未解锁：请登录后在托盘勾选「Local API (DSH)」' };
      }
      if (!running) {
        return { ok: true, phase: appPath ? 'not_running' : 'no_app', appPath, appRunning: false, port: null,
          message: appPath ? '密匣未运行' : '未找到密匣安装位置，请在插件配置里填 appPath' };
      }
      // 进程在跑但读不到凭据：多半是没开 Local API
      return { ok: true, phase: 'locked', appPath, appRunning: true, port: null,
        message: '未读到本地 API 凭据：请在托盘勾选「Local API (DSH)」' };
    }
  }

  /** 拉起密匣；已在运行则直接回报状态 */
  async function launch() {
    const before = await readStatus();
    if (before.phase === 'ready' || before.phase === 'locked') {
      return before;
    }
    const appPath = before.appPath;
    if (!appPath) {
      return before;
    }
    try {
      const child = spawn(appPath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: path.dirname(appPath),
      });
      child.unref();
    } catch (err) {
      return { ...before, ok: false, message: `启动失败：${err?.message ?? err}` };
    }
    // 给进程一点时间起来，再回报一次
    await new Promise((r) => setTimeout(r, 1500));
    return await readStatus();
  }

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      const disposeStatus = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-mimavault/status',
        handler: async (req, res) => {
          if (req.method !== 'GET') {
            res.writeHead(405);
            res.end();
            return;
          }
          try {
            const body = await readStatus();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, phase: 'error', message: String(e?.message ?? e) }));
          }
        },
      });

      const disposeLaunch = webCtx.webServer.register({
        kind: 'exact',
        path: '/plugins/dsh-mimavault/launch',
        handler: async (req, res) => {
          if (req.method !== 'POST') {
            res.writeHead(405);
            res.end();
            return;
          }
          try {
            const body = await launch();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(JSON.stringify(body));
          } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, phase: 'error', message: String(e?.message ?? e) }));
          }
        },
      });

      return () => {
        disposeStatus?.();
        disposeLaunch?.();
      };
    });
  });
}
