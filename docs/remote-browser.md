# 远程浏览器（另一台电脑上的页面）

默认安装只服务 DSH 所在的这一台机器。本 fork 增加了「远程浏览器」能力：另一台电脑上的
Chrome/Edge 可以把已登录的标签页交给这台 DSH。

## 最重要的方向：浏览器必须主动出站

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

- 扩展侧**什么都不用改**：主机 `127.0.0.1`、端口 `43187`（与被控端本地端口一致即可）。
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

被控端扩展（弹窗 → 连接设置）：

1. 协议 `ws`，主机 `192.168.1.5`（或映射后的公网地址），端口 `43187`。
2. 配对令牌：在 DSH 机器上打开 `/browser` → 应用管理 → **设置 → 远程浏览器**，复制
   `配对令牌`，粘贴到扩展的「配对令牌」框，点「应用令牌」。

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
- 扩展侧：协议 `wss`，主机 `<name>.trycloudflare.com`，端口 `443`，再粘贴令牌。
- Tailscale 更简单：两端装好后 `bind` 填 tailscale 网卡地址（如 `100.x.y.z`），
  `hosts: ["100.x.y.z"]`，扩展直接 `ws://100.x.y.z:43187`，流量在 WireGuard 里。

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
