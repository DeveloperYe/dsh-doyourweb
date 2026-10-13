# dsh-doyourweb

让 DeepSeek Harness 引用并操作你已经打开、保持登录的 Chrome 和 Edge 页面，用精简的页面上下文和批量操作减少重复读取。

[![CI](https://img.shields.io/github/actions/workflow/status/SheepofSheep/dsh-doyourweb/ci.yml?branch=main&label=CI)](https://github.com/SheepofSheep/dsh-doyourweb/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22-339933)](package.json)
[![Playwright](https://img.shields.io/badge/Playwright-1.64.0-2EAD33)](package.json)

[English](README.md) | 简体中文

[在线体验说明](#local-demo) · [快速开始](#quick-start) · [使用文档](#usage)

![浏览器扩展的本地配对页面](docs/setup-page.png)

*本地配对页面：将浏览器扩展连接到 DSH 插件，保留现有标签页和登录状态。*

---

## 01 · 项目介绍

网页任务常常依赖已经打开的页面和已经登录的账号。dsh-doyourweb 面向希望直接在 DeepSeek Harness 中处理这些页面的用户，不需要另开自动化浏览器，也不需要导出 Cookie。

项目由 DSH 插件和配套的 Manifest V3 浏览器扩展组成。插件接入原生 `@`、`/` 菜单，扩展提供标签页信息和控制通道。完成一次配对后，扩展会在后台重连，不必一直打开弹窗。

当前版本为 **ver0.1.0**，包和浏览器扩展中的数字版本为 `0.1.0`。

## 02 · 功能预览

1. 在 DSH 输入 `/browser`，打开连接页面并查看扩展目录。
2. 在 Chrome 或 Edge 加载扩展，核对并批准四位配对码。
3. 用 `@` 选择已经打开的页面，再向 DSH 描述任务。

首屏截图展示的是配对界面，不是自动化任务录像。

<a id="local-demo"></a>

### 在线体验说明

项目没有公共在线演示。启用 DSH 插件后，默认本地连接页面为 [http://127.0.0.1:43187/setup](http://127.0.0.1:43187/setup)。浏览器控制通过这个本地桥接服务和已安装的扩展完成。

## 03 · 核心功能

| 功能 | 当前实现 |
| --- | --- |
| 复用已有页面 | 连接 Chrome、Edge 的普通 HTTP/HTTPS 标签页，保留登录状态。 |
| 原生页面引用 | 在 DSH 的 `@`、`/` 菜单中展示页面标题、站点和图标。 |
| 精简读取 | 使用可访问性快照，支持选择器、查询过滤和游标分页；初始引用上下文默认共用 2,400 字符预算。 |
| 批量操作 | 单次最多执行 12 个结构化动作，失败或发生导航时停止。 |
| 结果提取 | 按需返回 `text`、`value`、`href` 字段，每次提取最多 20 行。 |
| 简短回执 | `observe: "summary"` 跳过下一次页面快照；动作结果有 1,600 字符输出预算。 |
| 页面截图 | 将 PNG 保存到本地，返回文件路径，不把 base64 塞进文本上下文。 |
| 后台连接 | 保存配对配置、自动重连，并在空闲时释放调试连接。 |

预算按 JavaScript 字符计算，包含 JSON 转义和元数据，不等于模型 token 数。它限制的是返回内容，不是 DOM 遍历耗时。项目目前没有经过测量的省 token 百分比或速度排名。

## 04 · 技术架构

| 层级 | 技术 |
| --- | --- |
| DSH 主机插件 | Node.js 22+、JavaScript ESM、Cordis 集成 |
| 原生客户端 UI | React、DSH UI primitives |
| 浏览器引擎 | Playwright Core 1.64.0、Chrome DevTools Protocol |
| 本地桥接 | WebSocket（`ws`）、Zod 校验 |
| 浏览器扩展 | Manifest V3、`chrome.tabs`、`chrome.debugger` |
| 构建与检查 | esbuild、Node.js 测试运行器、GitHub Actions |

```mermaid
flowchart LR
    subgraph DSH["DeepSeek Harness"]
        UI["原生 @ / 菜单"]
        Host["主机插件"]
        Grants["会话授权与上下文预算"]
        Engine["Playwright 引擎"]
        Bridge["本地 WebSocket / CDP 转发"]
    end
    subgraph Browser["已有 Chrome / Edge"]
        Extension["Manifest V3 扩展"]
        Tabs["已登录的 HTTP/HTTPS 页面"]
    end
    UI <-->|"Strict Remote RPC"| Host
    Host --> Grants --> Engine
    Engine <-->|"CDP"| Bridge
    Bridge <-->|"来源校验与配对令牌"| Extension
    Extension <-->|"标签页信息与调试接口"| Tabs
    Engine -->|"快照、回执、PNG 路径"| Host
```

模型的浏览器工具只能访问用户在当前会话中引用的标签页。网页内容是不可信数据，不会作为用户指令或操作授权。

<a id="quick-start"></a>

## 05 · 快速开始

### 安装要求

- Node.js 22+ 和 npm。
- DeepSeek Harness；插件 API 已对照 `0.2.0-rc.2` 检查兼容性。
- 基于 Chromium 的 Chrome 或 Edge 125+，允许开启开发者模式并加载解压后的扩展。

### 安装 DSH 插件

通过 npm 安装时，在 DSH 打开 **插件 > 添加插件**，安装源选择 **npm 官方源**，输入：

```text
dsh-doyourweb
```

这种方式需要包已经发布。若官方源返回 `404`，可用下面的本地安装方式。新版本在镜像源中的同步可能有延迟。

### 构建并安装本地版本

```sh
git clone https://github.com/SheepofSheep/dsh-doyourweb.git
cd dsh-doyourweb
npm ci
npm run build
```

在 DSH 中打开 **插件 > 添加插件**，填入**构建完成后的项目目录绝对路径**。插件启用时会启动桥接服务，不需要另开开发服务器。

### 连接浏览器

1. 在 DSH 输入 `/browser`，打开本地连接页面。
2. 打开 `edge://extensions` 或 `chrome://extensions`，开启开发者模式，将项目中的 `extension/` 目录作为解压后的扩展加载。
3. 核对扩展徽标上的四位码与连接页面中的待配对请求，然后批准。
4. 回到 DSH，用 `@` 选择标签页并发送任务。

配对页面和扩展弹窗都可以关闭。安装 DSH 插件不会自动安装浏览器扩展。

### 配置

默认配置位于 [cordis.patch.yml](cordis.patch.yml)：

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `port` | `43187` | 本地桥接端口 |
| `snapshotChars` | `2400` | 页面读取和初始引用上下文的字符预算 |
| `idleTimeoutMs` | `120000` | 空闲多久后释放调试连接，单位毫秒 |

数据目录为 `<DSH_HOME>/browser-tabs/`；未设置 `DSH_HOME` 时使用 `~/.dsh/browser-tabs/`。插件显式配置的 `home` 优先。环境变量需要设置给 DSH 进程，插件不需要单独配置模型 API Key。

<a id="usage"></a>

### 使用文档

引用页面后，可以这样描述任务：

> 读取这个页面的结果列表，整理标题和链接，不要提交表单。

| 模型工具 | 用法 |
| --- | --- |
| `browser_read` | 读取快照；用 `selector`、`query`、`depth` 缩小范围，用 `cursor` 获取剩余内容。`limit` 范围为 400～8,000 字符。 |
| `browser_act` | 使用最新快照 ID，执行点击、填入、按键、选择、勾选、悬停、滚动、导航、前进后退、等待或提取。 |
| `browser_capture` | 需要检查画面时，将截图保存到本地。 |

同时授权了多个标签页时，工具调用需要通过 `tab` 指定已引用的页面。

<details>
<summary>工具示例：读取页面，再提取简短的结果列表</summary>

仅有一个已授权标签页时，调用 `browser_read`：

```json
{
  "depth": 8,
  "limit": 2400
}
```

将返回的快照 ID 填入 `browser_act`，选择器需要替换为实际页面中的选择器：

```json
{
  "snapshot": "<latest snapshot ID>",
  "observe": "summary",
  "steps": [
    {
      "op": "extract",
      "selector": "a.result-title",
      "fields": ["text", "href"],
      "maxRows": 10
    }
  ]
}
```

这些是模型工具参数，不是终端命令。`summary` 不返回新快照，下次操作前需要重新读取。

</details>

## 06 · 项目结构与技术细节

```text
src/
  host.js            插件生命周期、工具和会话上下文
  client.js          原生 @ 和 / 菜单数据源
  client-entry.js    React UI 与图标
  bridge.js          配对、扩展连接和 CDP 转发
  engine.js          快照、操作、提取与截图
  grants.js          按会话管理标签页授权
  protocol.js        页面引用与 Remote RPC 描述
  output.js          序列化输出预算
  vendor/            适配后的 Playwright 浏览器模型
extension/           Manifest V3 扩展和弹窗
scripts/             构建、集成测试和兼容性检查
test/                单元测试与测试页面
docs/setup-page.png  配对页面截图
cordis.patch.yml     DSH 插件注册与默认配置
lib/                 生成的构建产物，不提交到 Git
```

**快照与操作。** 完整快照文本缓存在本地，供游标分页使用。元素引用需要有效快照；读取、操作和导航都可能让旧引用失效。同一标签页上的调用按顺序执行。取消操作会报告已完成或状态不确定的步骤，不承诺撤销已经发生的操作。

**连接生命周期。** 空闲时释放调试连接，但不关闭标签页；再次读取时重新连接。浏览器重启会更新页面引用所属的会话，需要重新用 `@` 选择页面。

**数据处理。** 配对凭据和授权记录保存在本地数据目录，截图保存在其中的 `captures/`。已引用页面的片段会进入 DSH 模型上下文，可能发送给你配置的模型服务。不要公开配对文件和私人截图。购买、删除和敏感提交需要用户明确授权；插件没有独立的交易确认弹窗。

<details>
<summary>开发检查命令</summary>

```sh
npm run build
npm test
npx playwright-core install chromium
npm run test:browser
npm run verify:dsh -- --asar "<path to DeepSeek Harness app.asar>"
```

CI 配置了 Windows、Linux 单元测试，以及 Linux 上隔离的无头 Chromium 集成测试。徽章指向实际工作流状态，不是固定的“构建通过”图片。无头测试不替代日常浏览器配置与 DSH 原生界面的端到端验证。

</details>

## 07 · Roadmap / FAQ / License

### Roadmap

本文只介绍已经实现的 `0.1.0` 版本，暂未公布后续版本的交付时间。问题反馈和功能讨论见 [Issues](https://github.com/SheepofSheep/dsh-doyourweb/issues)。

### FAQ

**每次都要打开扩展吗？** 不需要。配对一次后，扩展会在后台重连；更新扩展文件后需要重新加载。

**为什么有些页面不显示？** 只提供普通 HTTP/HTTPS 标签页，不包含浏览器内部页面和无痕页面。全部页面都不显示时，先检查扩展是否启用、是否完成配对。

**43187 端口被占用怎么办？** 不要让两份插件同时使用同一端口。停止重复的桥接服务，或修改插件的 `port` 配置，并让扩展重新连接到对应端口。

**目前有哪些限制？** 浏览器扩展通过加载解压目录安装，尚未上架扩展商店；不支持 Firefox 和 Safari。主机 API 已对照 DSH `0.2.0-rc.2` 检查，其他版本及原生界面流程仍需各自验证。

### 贡献与协议

欢迎提交 Issue 和 Pull Request。反馈时附上复现步骤、DSH 和浏览器版本；日志中请移除令牌、私人网页内容和账号数据。修改代码后，运行与改动相关的检查。

项目代码使用 [MIT 协议](LICENSE)。Playwright 衍生代码和 Lucide 图标保留各自协议，详见 [NOTICE](NOTICE)、[Apache-2.0](extension/APACHE-2.0.txt) 和 [ISC](extension/icons/LICENSE)。
