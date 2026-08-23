# GitHub 资源代理与项目浏览器：开发框架

## 1. 技术边界

- 运行时：Cloudflare Workers，传统 `addEventListener('fetch', ...)` 写法。
- 依赖：零运行时依赖，不引入打包器或 UI 框架。
- 前端：由 Worker 返回的原生 HTML、CSS、JavaScript 单页界面。
- 数据源：只访问 GitHub 官方 REST API 和经过严格域名校验的 GitHub 下载域名。
- 部署：主文件为 `worker.js`，可直接粘贴到 Worker 或由 Wrangler 部署。

## 2. 页面信息架构

首页保留资源加速能力，同时增加项目浏览入口。用户输入 URL 后自动识别：

1. GitHub 项目首页，如 `https://github.com/owner/repo`：加载项目面板。
2. GitHub Release、Archive、Blob、Raw、Gist 等资源 URL：生成代理下载链接。

项目面板包含：

- 项目概览：仓库名、描述、默认分支、语言、Stars、Forks、更新时间和 GitHub 原始链接。
- Releases：显示版本名、Tag、发布时间、预发布标识和资产下载按钮；资产链接走当前代理。
- 项目文件：从根目录开始加载；目录按需展开，文件提供 GitHub 查看链接，Raw 文件额外提供代理链接。
- README：展示 GitHub README 页面链接和 Raw/代理下载入口，不在 Worker 中执行不可信 Markdown。
- 状态反馈：加载中、空数据、GitHub 限流、私有仓库/不存在、网络错误。

## 3. Worker API 契约

### `GET <PREFIX>api/repo?url=<github-repository-url>`

解析并严格验证项目 URL，固定请求以下 GitHub API：

- `/repos/{owner}/{repo}`
- `/repos/{owner}/{repo}/releases?per_page=20`
- `/repos/{owner}/{repo}/contents?ref={default_branch}`
- `/repos/{owner}/{repo}/readme?ref={default_branch}`

返回统一 JSON：

```json
{
  "repository": {},
  "releases": [],
  "contents": [],
  "readme": null,
  "warnings": []
}
```

非关键子请求失败时通过 `warnings` 返回；仓库元数据失败时返回对应 HTTP 状态。

### `GET <PREFIX>api/contents?owner=<owner>&repo=<repo>&path=<path>&ref=<ref>`

用于目录懒加载。`owner`、`repo`、`ref` 和 `path` 分别验证；请求目标始终由 Worker 拼成 `api.github.com` URL，客户端不能指定主机。

## 4. 安全与可靠性约束

- 只接受 HTTPS GitHub URL；hostname 必须精确命中允许列表。
- 项目 URL 仅接受 `/owner/repo` 或尾随 `/`，可剥离 `.git`。
- GitHub API 路径参数逐段编码，禁止 `..` 和控制字符。
- 转发前删除 Cookie、Authorization、Proxy-Authorization、Forwarded 和来源 IP 头。
- 可选 Worker Secret `GITHUB_TOKEN` 仅用于 Worker 发往 GitHub API，绝不接受客户端 Token。
- GitHub 重定向支持相对 `Location`，限制跳转次数，并校验每一跳的目标域名。
- GET/HEAD 不设置请求体；所有 OPTIONS 请求都在 Worker 内结束。
- 错误响应不暴露堆栈；JSON 和 HTML 响应均设置明确 Content-Type。
- 未识别路径返回 400，不再转发到第三方 `ASSET_URL`。
- Raw/jsDelivr 判断不能出现不可达分支。

## 5. 前缀与链接规则

- `PREFIX` 统一规范为以 `/` 开头、以 `/` 结尾。
- 首页、API、代理链接和重定向都通过同一个前缀帮助函数生成。
- 前端通过服务端注入的 JSON 配置获得 `PREFIX`，不硬编码 `/`。
- 代理 URL 格式：`<origin><PREFIX><absolute-github-url>`。

## 6. 明确开发路径

1. 建立 URL、前缀、JSON 响应和错误响应帮助函数。
2. 修复原代理路由、Raw/jsDelivr 分支、预检、请求体、敏感头和重定向问题。
3. 增加 GitHub API 客户端及稳定的错误映射。
4. 实现仓库聚合 API 和目录懒加载 API。
5. 实现响应式单页界面及项目 URL/资源 URL 自动识别。
6. 集成 Release 资产代理、文件链接和 README 链接。
7. 执行 JavaScript 语法检查和纯函数测试。
8. 使用模拟 `fetch` 覆盖首页、API、Blob、Raw、OPTIONS、白名单与重定向路径。
9. 审查无效 URL、HTML 注入、路径穿越、Token 泄露和限流错误呈现。

## 7. 验收条件

- 输入公开项目 URL 后无需刷新即可看到概览、Release、根目录文件和 README 链接。
- 目录可逐级展开，错误不会破坏其他面板。
- Release 资产与 Raw 文件可生成当前域名下、包含正确 `PREFIX` 的代理链接。
- 原有支持的 GitHub 下载类型继续可用。
- `Config.jsdelivr = 1` 时 Blob 与 Raw 分支都能转换为 jsDelivr。
- 自定义 `PREFIX = '/gh/'` 时首页、API、代理和重定向均正确。
- 外部任意 URL、恶意重定向、敏感头转发和路径穿越被阻止。
