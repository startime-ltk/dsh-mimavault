import { copyToClipboard } from './clipboard.js';

/**
 * 统一后端接口：把「PC 密匣」和「内置明文库」包装成同一组方法，
 * 6 个工具完全不关心当前是哪个模式。
 *
 * 方法契约（与 VaultClient 对齐）：
 *   search / entry / copy / totp / generate / secret / health
 *
 * 差异点被收敛在这里：
 *  - external：明文从不进入本进程，copy 由密匣自己写剪贴板；
 *  - builtin：明文就在本进程的内存/磁盘里，copy 由 clipboard.js 写系统剪贴板。
 *
 * ⚠️ builtin 模式下 secret() 会返回明文，但**仅供 vault_call_api 注入出站请求**，
 * 工具层绝不可以把它放进返回值。
 */

/** external 后端：原样代理 VaultClient */
export function externalBackend(client) {
  return {
    mode: 'external',
    async search(args) { return client.search(args); },
    async entry(id) { return client.entry(id); },
    async copy(id, field) { return client.copy(id, field); },
    async totp(id) { return client.totp(id); },
    async generate(opts) { return client.generate(opts); },
    async secret(id, field) { return client.secret(id, field); },
    async health() { return client.health(); },
    async status() {
      try {
        const h = await client.health();
        return { phase: 'ready', mode: 'external', port: h.port ?? null };
      } catch (err) {
        const code = err?.code;
        if (code === 'locked') {
          return { phase: 'locked', mode: 'external', message: '密匣已启动但未解锁：请登录并在托盘勾选 Local API (DSH)' };
        }
        return { phase: 'not_running', mode: 'external', message: err?.message || '密匣未运行或本地 API 未开启' };
      }
    },
  };
}

/** builtin 后端：包装 BuiltinStore */
export function builtinBackend(store, opts = {}) {
  const clearSeconds = opts.clearSeconds ?? 30;

  function notFound(id) {
    return { error: 'not_found', message: `条目 #${id} 不存在` };
  }

  return {
    mode: 'builtin',
    async search(args) { return store.search(args); },
    async entry(id) {
      const m = store.metadata(id);
      if (!m) throw Object.assign(new Error(notFound(id).message), { code: 'not_found' });
      return m;
    },
    async copy(id, field) {
      const e = store.byId(id);
      if (!e) throw Object.assign(new Error(notFound(id).message), { code: 'not_found' });
      const value = store.field(id, field || 'password');
      if (!value) return { copied: false, field, clearsInSeconds: 0, message: '该字段为空' };
      const secret = store.isSecretField(field);
      const res = copyToClipboard(value, { autoClearSeconds: secret ? clearSeconds : 0 });
      if (!res.ok) {
        return { copied: false, field, clearsInSeconds: 0, message: `剪贴板不可用：${res.reason}` };
      }
      return { copied: true, field, clearsInSeconds: secret ? clearSeconds : 0 };
    },
    async totp(id) {
      const t = store.totp(id);
      if (!t) throw Object.assign(new Error('该条目未绑定动态验证码'), { code: 'no_totp' });
      return t;
    },
    async generate(opts2 = {}) {
      const password = store.generate(opts2);
      let copied = false;
      if (opts2.copy) {
        const res = copyToClipboard(password, { autoClearSeconds: clearSeconds });
        copied = res.ok;
      }
      return {
        password,
        length: password.length,
        copied,
        clearsInSeconds: copied ? clearSeconds : 0,
      };
    },
    /** 仅供代理调用：返回明文，调用方不得把它写进工具返回值 */
    async secret(id, field) {
      const e = store.byId(id);
      if (!e) throw Object.assign(new Error(notFound(id).message), { code: 'not_found' });
      return store.field(id, field);
    },
    async health() {
      return { ok: true, app: 'dsh-mimavault-builtin', locked: false, port: null, entries: store.count() };
    },
    async status() {
      return {
        phase: 'ready',
        mode: 'builtin',
        port: null,
        entries: store.count(),
        message: `内置明文库：${store.count()} 条（不加密）`,
      };
    },
    // 内置模式专有能力（面板用，不暴露给模型）
    store,
  };
}
