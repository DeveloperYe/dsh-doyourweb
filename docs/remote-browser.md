# 远程浏览器（另一台电脑上的页面）

## 零配置：插件生成已配对的扩展

DSH 插件一启动就会按当前配置，在 `<DSH_HOME>/browser-tabs/extensions/` 下生成可直接加载的扩展包：

- 一个 `zip` + 一个同名目录，每个端点一份（本机、绑定地址、`hosts` 里的每个域名）；
- 里面已经写好了协议、主机、端口，**以及配对令牌**，所以在浏览器里「加载解压的扩展」之后
  就是已连接状态，不需要配对码、不需要手填任何东西；
- 每次改动 `port/hosts/extensionScheme` 或令牌轮换后，插件会自动重建（`/manage` → 浏览器扩展 →
  「重新生成全部」可强制重建）。

获取方式（三选一）：

1. DSH 里输入 `/browser` 打开连接页 → 第 1 步里的「下载 … 扩展 zip」；
2. `/apps` 或 `/manage` → **浏览器扩展** 标签页 → 下载 / 复制目录；
3. 直接取目录：`<DSH_HOME>/browser-tabs/extensions/ws-127.0.0.1-43187/`。

解压后打开 `edge://extensions` / `chrome://extensions` → 开发者模式 → 「加载解压的扩展」→ 选中目录。

> 生成的目录里带着配对令牌，等同于密码：不要提交仓库、不要放进网盘或共享目录。
> 想手工控制时，仓库里的模板目录 `extension/` 仍然可用，走第 2 步的 4 位验证码配对。


## 三条落地方式怎么选

| 方式 | 主机要装什么 | 被控机要做什么 | 需要 DNS | 需要 NAT |
|---|---|---|---|---|
| 插件内 TLS（本文件第一节之后） | **什么都不用装** | 装一次 CA 证书 | 不需要 | 1 个端口 |
| Cloudflare 橙云 | 什么都不用装 | 什么都不用做 | 需要（橙云） | 1 个端口 |
| 自建 Caddy + Let's Encrypt | Caddy | 什么都不用做 | 需要（灰云） | 2 个端口 |

## 方向：浏览器必须主动出站

桥（CDP 中继 + 配对）运行在 DSH 进程里，扩展是 WebSocket 客户端。所以**永远是浏览器那台
机器去连 DSH**，被控端不需要公网 IP、不需要端口映射、不需要进来的入站规则。

三条可用通道，按推荐顺序：

| 通道 | 被控端需要 | DSH 侧需要 | 传输加密 | 适用 |
|---|---|---|---|---|
| **A. SSH `-L` 转发** | 只要 `ssh` 客户端（Win10+ 自带） | 一个可达的 SSH 端口 | SSH 自带 | 首选；零代码暴露、零新端口 |
| **B. 端口映射 / 局域网直连** | 只有浏览器 | `bind` + `hosts` + `remote: true` | 无（明文 ws） | 仅可信内网 |
| **C. 隧道 + TLS（Cloudflare Tunnel / Tailscale / Caddy）** | 只有浏览器（Tailscale 需装客户端） | 隧道客户端 | wss | 跨公网 |

## 通道 A：SSH 本地转发（推荐）

在被控端电脑上执行（把地址换成你的 DSH 机器）：

```powershell
ssh -N -L 43187:127.0.0.1:43187 -p 8022 administrator@<DSH-IP> `
    -o ServerAliveInterval=30 -o ExitOnForwardFailure=yes
```

- 扩展用生成的 **「本机」** 那一份：它指向 `127.0.0.1:43187`，正好走隧道。把 zip 拷到被控端解压加载即可。
- 桥仍然只监听 `127.0.0.1`，管理面不出本机，防火墙不用动。
- 想开机自动保持，可用 `autossh` 或计划任务重连；断线后扩展会按 1s→30s 退避自动重连，
  不必重新配对，但浏览器**重启**后要重新用 `@` 选一次标签页。

## 通道 B：端口映射 / 局域网直连

DSH 侧配置（`cordis.patch.yml` 的 `browser-tabs` 段，或在 DSH 插件设置里改）：

```yaml
config:
  port: 43187
  bind: 0.0.0.0          # 或具体网卡地址，如 192.168.1.5
  hosts: ["192.168.1.5", "browser.example.com"]   # 扩展会用的 Host，必须逐条列出
  remote: true           # 非环回 bind 必须显式打开
```

被控端：把生成的 **对应 `hosts` 那一份** zip 拷过去解压加载；它的主机/端口/令牌都已写好。
手工方式（不想用生成包时）：弹窗 → 连接设置里填协议 `ws`、主机 `192.168.1.5`、端口 `43187`，
再把 `/manage` → 设置 → 远程浏览器里复制的 `配对令牌` 粘贴进去。

要点：

- **远程连接不能配对**。配对（输入 4 位 PIN）只在 DSH 本机可用；远程浏览器必须先用令牌。
- 明文 `ws` 意味着同网段的嗅探者可以抓到令牌并接管你的浏览器。只要能不用就别用通道 B
  的明文形态；必须用就套一层 TLS 终结（通道 C）。
- 管理页 `/manage`、配对页 `/setup` 对非本机来源一律返回 404，即使端口被映射到公网。

## 通道 C：隧道 + TLS

以 Cloudflare Tunnel 为例（DSH 机器上）：

```powershell
cloudflared tunnel --url http://127.0.0.1:43187
# 得到 https://<name>.trycloudflare.com
```

- 桥保持 `bind: 127.0.0.1`，**不需要** `remote: true`；把隧道域名加进 `hosts` 即可
  （`hosts: ["<name>.trycloudflare.com"]`），因为 Host 头是域名。
- 扩展用生成的 **域名那一份**（配置 `extensionScheme: wss` + `hosts: ["<name>.trycloudflare.com"]`），
  它的协议是 `wss`、主机是域名；若隧道端口不是 443，再加 `extensionPort`。
- Tailscale 更简单：两端装好后 `bind` 填 tailscale 网卡地址（如 `100.x.y.z`），
  `hosts: ["100.x.y.z"]`，扩展直接 `ws://100.x.y.z:43187`，流量在 WireGuard 里。

## 端口全部可自定义

| 配置项 | 作用 | 默认 | 备注 |
|---|---|---|---|
| `port` | 本机明文监听（CDP 中继 + 本机管理页） | `43187` | 只绑环回，不对外 |
| `tlsPort` | HTTPS/wss 监听端口（NAT 打到的那一侧） | `8443` | 写 `0` 表示让系统挑空闲端口 |
| `extensionPort` | **扩展里写的端口 = NAT 外部端口** | 同 `tlsPort` | 外部 9443 → 内部 8443 就靠它 |
| `hosts` | Host 白名单（浏览器实际用的地址） | – | 白名单外一律 403 |
| `publicUrl` | 管理页/连接页的对外地址 | – | 远程运维时必须写公网地址 |

示例：外部 **9443** → 内网 **8443**

```yaml
- id: browser-tabs
  config:
    port: 43187
    bind: 0.0.0.0
    hosts: ["36.138.189.24"]
    tls: true
    tlsPort: 8443            # 进程在这里监听
    extensionPort: 9443      # 扩展去连这个（= 面板上的外部端口）
    publicUrl: "https://36.138.189.24:9443"
    remote: true
```

改完重载插件即生效，扩展会自动按新端口重新生成；浏览器里已装的旧扩展也可以在弹窗
「连接设置」里直接改协议/主机/端口，不必重新生成。端口被占用时：默认端口会**自动换一个空闲端口**
并在日志里说明，显式配置的端口则**直接报错**（可用 `portFallback`/`tlsPortFallback` 覆盖）。

## 同一台机器上同时跑 web 端和桌面版

两端共用同一个宿主实现（`dsh-base` 的 `tools`/`typert` + UI 的 `inputTriggers`/`remote`），
所以插件在两端的代码路径完全一致；真正的冲突只有一个——**默认端口 43187 只能被一个实例占用**。

- 用的是默认端口（配置里没写 `port`）时：第二个实例发现端口被占会**自动改用随机端口**，
  并在日志里说明，生成的扩展也随之写上新端口，所以 web 端和桌面版可以同时开着各连各的浏览器。
- 显式写了 `port` 时：端口被占就**直接报错**，不会悄悄漂移。
- 两个实例共用同一个 `<DSH_HOME>/browser-tabs`：配对令牌相同（好事），`extensions/` 里各端点的
  目录按端口区分，互不覆盖；但 `build.json` 指纹会被对方改写，导致下次启动重建一次，仅此而已。
  想彻底隔离就分别给两个 profile 设 `home`。

### 桌面版上要做什么

1. 把插件装进桌面版的 profile（和 web 端一样：`package.json` 加 `"dsh-doyourweb-remote": "link:<绝对路径>"`，
   再把它加进 `dsh.profile.bundles`，然后 `pnpm install`）；
2. 跑一次自检：`npm run verify:host -- --tls`（15 项：依赖可解析、桥可监听、扩展可生成、
   管理页鉴权、自签证书真握手）；
3. 打开 DSH，输入 `@` 应能看到「浏览器」来源，`/browser` 应有连接页入口。

桌面版若在 macOS/Linux：浏览器控制、扩展生成、TLS 全部可用；`app_*`（应用/桌面窗口枚举）是
Windows 专属能力，会返回明确错误而不是崩溃。

## 插件自己出证书（主机零安装）

不想装 Caddy、不想经 Cloudflare 时，让桥自己终结 TLS：

```yaml
- id: browser-tabs
  config:
    port: 43187
    bind: 0.0.0.0
    remote: true
    hosts: ["36.138.189.24"]
    tls: true                 # 在插件进程内起 https 监听
    tlsPort: 8443             # NAT 把外部 8443 打到 172.16.0.59:8443
    tlsIps: ["36.138.189.24"] # 证书 SAN 里要覆盖的公网地址
    publicUrl: "https://36.138.189.24:8443"
```

- 首次启动时插件自建一个 10 年有效期的本地 CA，并签发 397 天（浏览器上限）的叶子证书，
  到期前 30 天或 SAN 变化时自动用同一 CA 重签——已信任的浏览器不用重装。
- **CA 证书随扩展一起打包**：生成的扩展里带 `ca.crt`，弹出页有「安装 CA 证书（下载）」按钮，
  点击即可导出 `dsh-doyourweb-ca.crt`（`/manage` 里的下载入口同样可用）。
- **为什么不能自动装**：浏览器扩展没有写系统信任库的 API——唯一的证书 API
  `chrome.certificateProvider` 是 ChromeOS 专属且只用于客户端证书；信任根是操作系统受保护存储，
  改它需要 Native Messaging 宿主（等于又装一个本地软件），而且 Windows 对安装根证书强制弹确认框。
  所以「最后一击」必须由人完成：双击下载到的 .crt →「安装证书」→ 本地计算机 → 受信任的根证书颁发机构。
- 若想彻底免掉这一步，只能用公有证书：Let's Encrypt（域名 + 80/443）或 Cloudflare 橙云（域名）。
- CA 下载地址同样受每次启动的密钥保护，公网拿不到。
- 依赖：纯 JS 的 `node-forge`（随插件 node_modules 分发），不需要 openssl、不需要系统证书工具。

## 隧道 / 反向代理

公网 NAT + Cloudflare 橙色云域名是最省事的一条：CF 终结 TLS，再以普通 HTTP 打回本机的桥。

```yaml
- id: browser-tabs
  config:
    port: 43187
    bind: 0.0.0.0          # NAT 要打到内网地址，所以不能再只绑环回
    remote: true
    hosts: ["browser.example.com"]
    extensionScheme: wss    # 生成 wss://browser.example.com:443/extension 那一份
    extensionPort: 443
    publicUrl: "https://browser.example.com"   # 管理页/连接页的真实地址
```

要点：

- `hosts` 必须写浏览器实际用的域名；桥按 Host 头白名单放行，并且同时接受监听端口与
  `extensionPort`（隧道终结在 443/8443，Host 里的端口与监听端口不同）。
- `publicUrl` 决定 DSH 打开管理页/连接页时用的地址——远程运维时它不能是 127.0.0.1。
- 管理面不再限定环回：真正的凭据是每次启动的密钥，没有密钥的请求（含从公网来的）一律 404。
- 浏览器侧零安装：装 CF 签证过的那份扩展即可，不需要 SSH、不需要在终端跑任何东西。

## 管理页怎么打开

管理页与连接页现在**只能从 DSH 内部打开**：在对话里输入 `/apps`（应用管理）或 `/browser`（连接页面），
DSH 会用本次启动的管理密钥打开它。直接用浏览器访问 `http://127.0.0.1:43187/manage` 会看到一个说明页——
这不是故障：环回端口任何人（含其它本地用户）都能连，所以光有 loopback 不构成身份。

由此带来两个操作约定：

- DSH 重启后管理密钥会变，旧的收藏链接失效，重新用 `/apps` 打开即可；
- **轮换令牌或改了 `port/hosts` 之后，浏览器里已加载的扩展需要到扩展页点一次「重新加载」**，
  否则它仍拿旧的地址/令牌重连（界面上表现为一直 OFF）。

## 安全边界（这个 fork 的改动）

- 管理面（`/manage`、`/manage/api`、`/setup`、`/setup/pair`）**只接受本机连接**（loopback
  判定基于 socket 对端地址，不看可伪造的 Host 头）。
- 管理页不再把管理密钥写进 HTML：改用 `HttpOnly; SameSite=Strict` cookie，本地进程无法
  通过 `GET /manage` 读回密钥。
- 配对码改成 PIN：页面不再列出待批准请求的验证码，用户必须从扩展图标上抄 4 位数字输入；
  连续 5 次错误会清空所有待批准请求。
- 远程浏览器只能用已签发的令牌连接；无令牌的远程 socket 直接断开，且不会登记配对请求。
- Host 头白名单：除 `127.0.0.1`/`localhost`/`::1`/绑定的地址外，其他域名必须写进 `hosts`。

## 排错

| 现象 | 原因 |
|---|---|
| 扩展一直 OFF，控制台 `403` | `hosts` 里没有写扩展使用的主机名 |
| 扩展「已连接」立刻变 OFF | 令牌不对，或远程试图配对（远程不允许配对） |
| 打开 `http://<DSH-IP>:43187/manage` 是 404 | 正常：管理面只在本机 |
| 本机能用、远程连不上 | `bind` 还是 `127.0.0.1`，或 `remote: false`，或防火墙挡了端口 |
| DSH 启动报 `Refusing to listen on 0.0.0.0` | 忘了 `remote: true` |
| 断线后要重新 `@` 选标签页 | 浏览器重启会换 `browserSession`，旧引用按设计失效 |
