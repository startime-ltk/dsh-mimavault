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

> **v0.3.0 起支持两种数据源**（侧栏面板里切换）。上图画的是默认的 external 模式。
> builtin 模式不装 PC 密匣也能用，但**条目以明文存盘、不加密** —— 详见下方「两种模式」。

## 两种模式

| | **external（默认，更安全）** | **builtin（免安装，不加密）** |
|---|---|---|
| 数据在哪 | PC 密匣的加密库 | `%APPDATA%/MimaVault/builtin-vault.json`（**明文 JSON**） |
| 密钥在哪 | 密匣进程内，PBKDF2 派生 | **无主密码、无加密** |
| 要不要装密匣 | 要 | 不用 |
| 明文是否进 DSH 进程 | 否 | 是 |
| 谁能读库 | 需主密码解锁 | 任何能读该文件的程序 |
| `vault_call_api` | 正常（进程隔离 + 域名白名单） | **默认关闭**，需显式配置 `enableBuiltinCallApi: true` |

切换只影响本插件，**两套数据互相独立**：拨到内置库时，PC 密匣里的条目不会自动出现。

### 内置明文库的安全边界（务必知情）

内置模式是按「不设主密码」的要求实现的：条目**明文写入本地文件**，界面里也明确写着「明文存盘，不加密」。任何能读到该文件的进程（含 DSH 的 `pwsh`/`bash` 工具、同机程序、备份/同步软件）都能看到全部密码。

因此内置模式下：

- 插件**不再能**提供 external 模式那种「能力上拿不到明文」的架构保证，只剩「工具约定不返回」；
- `vault_copy` 改由 Host 写系统剪贴板（detached PowerShell，30 秒条件清除），明文会经过 DSH 所在的机器；
- `vault_call_api` 默认关闭（密钥与出站请求同处一个进程，少一层隔离）；
- 想更安全，装 PC 密匣并切回 external 即可，内置库数据保留不动。

### 内置库条目管理

内置库支持在侧栏面板里**手动新增 / 编辑 / 删除**条目：

- 点「新增条目」打开表单：分类、平台（必填）、账号、密码（可切明文显示）、邮箱、手机、TOTP、备注
- **分类专属字段**按所选分类动态出现（WiFi 的 SSID、银行卡的卡号/CVV、证件的证件号、API Key 的 Key/接口地址/模型）
- TOTP 可填完整 `otpauth://` 链接，也可直接粘 Base32 密钥（自动规范化；非法输入拒绝而不是静默写坏数据）
- 列表每行有「编辑」「删」按钮；编辑时预填完整字段（含明文，仅供浏览器面板，不经过模型工具）
- 删除前弹确认框

所有写操作由宿主 `POST /plugins/dsh-mimavault/entries` 完成，`POST /entry` 供编辑预填。
**仅内置库模式可用**，PC 密匣模式下这些入口会提示到密匣界面里管理。

### 数据互通（不经过 AI）

内置库通过**导入密匣导出的明文 CSV** 互通：在密匣里「导出 CSV（明文）」→ 侧栏面板粘贴 → 点「导入 CSV」。解析在 Host 里用 `builtin-store.js` 的 CSV 状态机完成，**不把明文发给模型、不进对话记录**。

支持 MimaVault `CsvUtil` 的表头别名（`name/username/password/notes/totp` 及 `api_key`/`wifi_ssid`/`bank_card_no` 等专属列）、UTF-8 BOM、引号转义、内嵌换行、空行跳过，并能从专属字段推断分类。

> 不要用「把明文贴给 AI 让它转格式」的方式：那会把整个库的明文一次性送进会话历史与模型服务商，而且模型容易改错密码里的 `0/O`、`1/l/I`。CSV 导入是纯机械映射，精确且不过模型。

### 清除（二次确认）

- 侧栏「清空内置库」按钮 → 生成清除请求 → 弹确认框 → **人点「确认清空」**才执行；
- AI 也可调 `vault_clear` 发起请求，但**不能直接删除**，必须等同一个人点确认；
- 执行前自动留一份备份（`builtin-vault.json.backup`），面板有「从备份恢复」；
- 请求 5 分钟过期，确认令牌不匹配会被拒。

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
| `vault_call_api` | 用库中令牌代理发起 HTTP 请求（builtin 模式默认关闭） | 否（只有对方响应） |
| `vault_clear` | **只发起**清空内置库的请求，须人工确认；不直接删数据 | 否 |

## 侧栏面板

插件在侧栏面板列表里注册了一行「密匣」（与 purge 同一槽位 `sidebar.panellist`，
`order` 取 31，紧排在其下方）。

**点这一行就会自动尝试拉起密匣**（页面挂载时调用宿主 `POST /plugins/dsh-mimavault/launch`），
面板显示四种状态：

| 状态 | 含义 |
|---|---|
| 已连接密匣 | 本地 API 可用，附端口号 |
| 密匣已启动，未就绪 | 进程在跑，但没登录或没勾 `Local API (DSH)` |
| 密匣未运行 | 点了会尝试启动可执行文件 |
| 未找到密匣 | 需要在插件配置里填 `appPath` |

可执行文件路径按「配置 `appPath` → `%LOCALAPPDATA%\Programs\密匣 MimaVault\` → 各盘符
`\Programs\密匣 MimaVault\`」依次探测，面板底部会显示实际解析到的路径。

面板在 external 模式只显示连接状态；builtin 模式额外提供模式切换、CSV 导入、条目列表、一键清除（二次确认）。面板只展示元数据，不展示任何密码明文。

## 检查更新

侧栏「关于插件」区块显示**当前版本**，点「检查更新」走多源查询：

| 源 | 说明 |
|---|---|
| GitHub 直连 | `raw.githubusercontent.com/.../main/version.txt`，带时间戳绕缓存 |
| 镜像 | `ghfast.top` 代理同一文件 |
| GitHub Tags API | 仅当上面两个文本源**都失败**时才问，从 tags 取最大版本 |

**多源取版本号最大者**，防止镜像返回旧缓存。**不用 jsDelivr CDN 做版本源** —— MimaVault v8.35.4 实测 CDN 会把 `version.txt` 缓存成几个版本前的旧内容，加时间戳也无效，会让人"更新"回旧版。

版本清单在仓库根 `version.txt`，格式 `版本|Release 页面 URL|一句话说明`。

结果 5 分钟缓存，点「检查更新」是强制刷新。发现新版时给出 Release 链接与「全部版本」链接，并提示：

> 当前 profile 以 `link:` 挂的是本地开发目录，插件**不会自动覆盖**它。请拉取新版本后重启 DSH，或在 DSH 插件管理页重新安装。

即：本功能只做**检查与提示**，不自动下载/替换插件代码。

## 部署

### 1. 选择模式

- **external**：需要 MimaVault **v8.35.5 或更高**，启动并登录后托盘勾选 `Local API (DSH)`，确认 `%APPDATA%\MimaVault\api.json` 已生成。取消勾选/锁定/自动登出/退出程序，API 立即失效。
- **builtin**：不需要安装任何东西，侧栏面板里点「内置明文库（免安装）」即可。数据从密匣导出的明文 CSV 导入。

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
    appPath: ""                 # 密匣 exe 路径（不填就自动探测各盘符）
    storePath: ""               # 内置库路径（默认 %APPDATA%/MimaVault/builtin-vault.json）
    enableBuiltinCallApi: false # 内置模式是否允许 vault_call_api（默认关闭，不建议开）
    updateTimeoutMs: 8000       # 检查更新时每个版本源的超时
```

## 已知限制

- external 模式必须先手动启动并登录 MimaVault，插件无法代为解锁（主密码永不经过 DSH 进程）。
- builtin 模式**不加密**，明文存盘；两套数据独立，切换不会自动迁移。
- `vault_call_api` 只支持单次请求，不处理重定向与分页；builtin 模式默认关闭。
- 清空内置库必须人工确认；备份文件本身也是明文。
- 内置库的剪贴板复制依赖 Windows PowerShell；非 Windows 环境不支持。
- 手动新增/编辑/删除仅在内置库模式可用；PC 密匣的维护仍在其桌面界面完成。
- 编辑表单会在浏览器面板里短暂显示明文（预填用），请留意周围环境。

## 许可

MIT
