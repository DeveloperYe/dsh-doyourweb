# WebMCP Experiment / WebMCP 实验

This feature is on branch `Trywebmcp`, not in the published `0.1.0` npm package. It discovers tools registered by the selected page through `document.modelContext.getTools()` and calls them through `executeTool()`. It does not inject website tools or use OpenAI's private runtime. The existing DOM tools remain available.

本功能位于 `Trywebmcp` 分支，尚未包含在已发布的 npm `0.1.0` 中。它沿用配套扩展和本地 CDP 通道，调用网站自己注册的 WebMCP 工具；没有工具的页面继续使用原来的读取、点击和输入功能。

## Try It / 试用

1. Check out this branch and run `npm ci` and `npm run build`.
2. Install this local directory in DSH, or use `npm pack` to build a local installable tarball. Keep the companion extension connected as before.
3. Open a website that actually registers compatible WebMCP tools. The browser must expose `document.modelContext.getTools` and `executeTool`.
4. Select that tab with `@` in DSH and ask it to discover the site's tools before using DOM automation.

在 DSH 中可以这样提问：

> 先列出这个页面提供的 WebMCP 工具。如果有适合当前任务的工具，就按它的参数格式调用；如果不支持或没有合适工具，再使用普通网页操作。

The model gets two additional native DSH tools:

| Tool | Behavior |
| --- | --- |
| `browser_webmcp_list` | Returns a fresh catalog, descriptions and complete input schemas. Optional `query` narrows discovery; `limit` controls the serialized response budget. |
| `browser_webmcp_call` | Calls a listed tool with a matching `catalog`, `name` and `arguments`. Optional `timeout` is 1-120,000 ms; default 15,000 ms. |

Example sequence after the user references the local test tab:

```json
{"query":"add_to_counter"}
```

Pass that discovery result's actual `catalog` into the call:

```json
{"catalog":"<catalog returned by discovery>","name":"add_to_counter","arguments":{"value":3}}
```

The call returns the site's serialized result, not an automatic DOM snapshot. Each catalog is single-use; discover again before the next execution.

## Scope / 范围

- Only tabs referenced by the user in the current conversation are eligible. Only tools owned by the top-level document are exposed; iframe tools are excluded.
- This experiment uses the current `document.modelContext` API, not legacy `navigator.modelContext` or a synthetic compatibility registry. A browser or page without compatible APIs reports unsupported, without modifying that page.
- JSON Schema draft-07 and draft-2020-12 arguments are validated with Ajv before invocation. Other unsupported schemas are marked unavailable.
- Discovery returns at most eight tools, normally within 4,000 serialized characters. A schema larger than 4,000 characters is unavailable rather than silently truncated. Use `query` or increase `limit` up to 8,000 to retrieve omitted entries.
- Navigation, a `toolchange` notification or idle debugger release invalidates the catalog. Execution invalidates old ARIA snapshots too.
- Site descriptions, results and safety hints are untrusted. Execution is presented as an action, even if the website claims `readOnlyHint`. Tools declaring `consequentialHint: true` are blocked in this experiment; they are not automatically approved by a model argument.
- Long-running calls are polled locally, without extra model turns. Timeout, cancellation or an execution error can leave uncertain effects; inspect the page before deciding whether to retry. No automatic duplicate DOM fallback is performed.
- The existing `@` reference still prepares its normal initial page snapshot. This branch has not established end-to-end token savings, and it does not assume Douyin or Doubao provide WebMCP tools.

## Verification / 验证

```sh
npm test
npm run build
npm run test:browser
```

The browser test starts a disposable headless Chromium profile, loads the real companion extension, pairs it with an isolated local bridge, and invokes real native WebMCP tools on `test/fixtures/webmcp.html`. Experimental web-platform features are enabled only for that disposable test browser, not for your daily Chrome or Edge profile. The fixture's counter is synthetic test data, not a Douyin or Doubao demonstration.

Native integration was verified with Chromium `156.0.8078.4`. The adapter targets the current object-argument API (Chrome 155+), not the older stringified-argument signature; API availability still depends on browser configuration or the site's origin-trial enrollment.

实际验证使用独立的无头 Chromium、真实扩展和 CDP 桥接，不修改日常浏览器的启动参数、个人资料或登录状态。测试页直接注册原生 WebMCP 工具，没有注入替代实现。

## References / 资料

- [WebMCP draft specification](https://webmachinelearning.github.io/webmcp/)
- [Chrome WebMCP imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api)
