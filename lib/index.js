import { VaultClient } from './client.js';
import { makeTools } from './tools.js';

/**
 * dsh-mimavault —— 把本机 MimaVault（密匣）密码库接进 DeepSeek Harness。
 *
 * 插件本身**不接触加密数据**：它只是 MimaVault 本地回环 API 的客户端，
 * 密钥始终留在 MimaVault 进程里。MimaVault 未解锁时，所有工具都会返回
 * "密匣已锁定"的可操作提示。
 *
 * @see README.md 安全模型与部署步骤
 */

/** cordis 插件名 */
export const name = 'dsh-mimavault';

/** 依赖的工具注册表 */
export const inject = ['tools'];

/**
 * 注册 6 个工具。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @param {{ apiJsonPath?: string, requestTimeoutMs?: number, maxResponseBytes?: number, allowedHosts?: string[] }} [config]
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
}
