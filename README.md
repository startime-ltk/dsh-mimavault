# dsh-mimavault

把本机 [MimaVault（密匣）](https://github.com/startime-ltk/MimaVault) 密码库接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，让 DSH 能检索密码、API Key、动态令牌 —— **同时不让明文进入模型上下文**。

## 它是怎么工作的

```
DSH Host 进程                          MimaVault 进程（须已解锁）
┌───────────────────────┐              ┌──────────────────────────┐
│ dsh-mimavault 插件     │  HTTP+Token  │ LocalApiServer           │
│  vault_search          │ ───────────► │  只监听 127.0.0.1:随机端口 │
│  vault_entry           │              │  仅在解锁期间可用          │
│  vault_copy            │              │  AES 密钥始终留在本进程内  │
│  vault_totp            │ ◄─────────── │                          │
│  vault_generate        │   元数据/状态  │                          │
│  vault_call_api        │              │                          │
└───────────────────────┘              └──────────────────────────┘
```

**插件本身不碰任何加密数据**，它只是本地 API 的客户端。真正的解密发生在 MimaVault 进程里。

## 安全模型

| 关切 | 做法 |
|---|---|
| 明文会不会进对话？ | **不会。** `vault_search` / `vault_entry` 只返回元数据，密码、备注内容、TOTP 种子一律不外泄；`api_key` 之类打码为 `***` |
| 需要密码去填表单怎么办？ | `vault_copy` → **由 MimaVault 自己**写 Windows 剪贴板（复用 `ClipboardSafe`，30 秒自动清除），明文从未离开密匣进程 |
| 需要令牌去调 API 怎么办？ | `vault_call_api` → 凭据在插件进程内注入到出站请求，**只把对方响应回给模型** |
| 代理调用会不会被拐走？ | 三重限制：目标域名必须等于该条目 `api_endpoint` 的域名；**不自动跟随 3xx 跳转**；白名单外的域名直接拒绝 |
| 没登录时能用吗？ | 不能。MimaVault 未解锁时描述文件不存在，插件直接提示"未运行/未解锁" |
| 锁屏/离开时会怎样？ | MimaVault 3 分钟无操作自动登出，登出即吊销 API 并删除描述文件，插件立刻失效 |
| 别的程序能冒充吗？ | 需要 Bearer token（256 位随机，仅当前用户可读的描述文件）。**注意**：同用户下的恶意程序仍可读取该文件 —— 这层防护挡的是浏览器 CSRF 与误操作，边界是 Windows 用户隔离 |

## 工具

| 工具 | 作用 | 会返回明文吗 |
|---|---|---|
| `vault_search` | 按关键词/分类检索条目元数据（备注参与命中，但不返回内容） | 否 |
| `vault_entry` | 读取单条元数据 | 否 |
| `vault_copy` | 把指定字段复制到剪贴板（密匣侧执行） | 否 |
| `vault_totp` | 取 6 位动态验证码 + 剩余秒数 | 仅短时效验证码 |
| `vault_generate` | 生成新的随机口令 | 是（新生成，非库中秘密） |
| `vault_call_api` | 用库中令牌代理发起 HTTP 请求 | 否（只有对方响应） |

## 部署

### 1. MimaVault 侧

需要 MimaVault **v8.35.5 或更高**（本地 API 已合入 `main`）：

1. 启动 MimaVault 并用主密码登录；
2. 右键托盘图标 → 勾选 **Local API (DSH)**；
3. 确认提示里显示的凭据路径 `%APPDATA%\MimaVault\api.json` 已生成。

> 取消勾选、锁定、自动登出或退出程序，API 立即失效。

### 2. DSH 侧

把本包放进 profile。开发期用 `link:` 挂本地目录：

```jsonc
// %USERPROFILE%\.dsh\profiles\<profile>\package.json
{
  "dependencies": {
    "dsh-mimavault": "link:D:/path/to/dsh-mimavault"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …原有条目…
        "dsh-mimavault"
      ]
    }
  }
}
```

然后在 profile 目录执行 `pnpm install` 并重启 DSH。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖：

```yaml
- id: dsh-mimavault
  name: dsh-mimavault
  config:
    requestTimeoutMs: 8000      # 调本地 API 的超时
    maxResponseBytes: 20000     # vault_call_api 返回体上限
    allowedHosts:               # 额外放行的域名（默认只允许条目 api_endpoint 的域名）
      - "*.openai.com"
    apiJsonPath: ""             # 一般不用改
```

## 已知限制

- 必须先手动启动并登录 MimaVault，插件无法代为解锁（主密码永不经过 DSH 进程）。
- `vault_call_api` 只支持单次请求，不处理重定向与分页。
- 本插件不做写操作（新增/修改条目），库的维护仍在 MimaVault 界面里完成。

## 许可

MIT
