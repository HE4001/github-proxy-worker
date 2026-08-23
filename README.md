# Passage

一个链接，浏览公开 GitHub 仓库，或生成受限制的资源代理地址。

Passage 是零运行时依赖、单文件部署的 Cloudflare Worker。仓库 API、代理路由、HTML、CSS 和浏览器端交互全部内嵌在 [`worker.js`](./worker.js) 中。

## 功能

### 仓库浏览

- 查看仓库描述、Stars、Forks、Issues、语言、默认分支和更新时间。
- 查看 Releases 与附件；附件下载自动使用当前 Worker 的代理地址。
- Release 数量超过 4 个时，仅默认展开最新版本；每个版本都可以独立折叠。
- 浏览根目录并按需展开子目录，避免一次性请求完整文件树。
- 筛选根目录文件，并获取 GitHub、Raw 和代理下载入口。
- 生成适用于公开仓库的代理 Git clone 命令。
- 提供 README 的 GitHub、Raw 与代理入口，不执行远程 Markdown。

### 资源代理

- 支持 Raw、Blob、Release、Archive、Gist、codeload 和 jsDelivr `gh` 资源。
- 严格验证 HTTPS、主机名、路径和每一跳重定向。
- 可选将符合条件的 Blob/Raw 请求重定向到 jsDelivr。
- 支持自定义部署前缀，例如 `/gh/`。

### 内置界面

- 自动识别仓库链接与资源链接。
- 浅色、深色和系统主题。
- 桌面与手机响应式布局，支持键盘操作。
- 输入框关闭自动补全，不使用 `localStorage` 保存输入记录。
- 提交后的 URL 参数用于分享页面状态以及浏览器前进、后退。

## 快速部署

1. 在 Cloudflare Workers 中创建或选择一个支持经典 Service Worker 格式的 Worker。
2. 使用本仓库的 [`worker.js`](./worker.js) 替换脚本内容。
3. 按需要修改文件顶部的 `Config`。
4. 部署后访问 Worker 根地址，即可使用内置界面。

`worker.js` 为了保持“复制单文件即可运行”，使用 `addEventListener("fetch", ...)` 的经典 Service Worker 格式。Cloudflare 目前仍支持此格式，但已将其标记为 deprecated；新建长期维护的项目可评估迁移到 [Module Worker](https://developers.cloudflare.com/workers/reference/migrate-to-module-workers/)。

## 使用方法

### 在界面中使用

| 输入 | 结果 |
| --- | --- |
| `https://github.com/owner/repository` | 浏览仓库概览、Releases、文件和 README 入口 |
| Raw、Blob、Release、Archive 或 Gist URL | 生成当前站点的代理地址 |

### 直接构造代理地址

将完整 GitHub 资源 URL 放在 Worker 地址之后：

```text
https://your-worker.example/https://raw.githubusercontent.com/owner/repository/main/file.txt
```

如果 `PREFIX` 为 `/gh/`：

```text
https://your-worker.example/gh/https://github.com/owner/repository/releases/download/v1.0.0/app.zip
```

Passage 不是通用代理。普通网页、仓库首页和不在允许列表中的外部主机不会被代理。

## 配置

编辑 `worker.js` 顶部：

```js
var Config = {
  PREFIX: "/",
  jsdelivr: 0,
  MAX_REDIRECTS: 4
};
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `PREFIX` | `/` | 部署路径前缀；会被规范为以 `/` 开头和结尾 |
| `jsdelivr` | `0` | 设为 `1` 时，将符合条件的 Blob/Raw 请求重定向到 jsDelivr |
| `MAX_REDIRECTS` | `4` | 上游代理最多跟随的重定向次数；代码上限为 8 |

### 可选的 GitHub Token

可以给 Worker 添加 Secret `GITHUB_TOKEN`，减少未认证 GitHub API 请求更容易触发限额的问题。使用 Wrangler 时：

```bash
npx wrangler secret put GITHUB_TOKEN
```

也可以在 Cloudflare 控制台中把 `GITHUB_TOKEN` 添加为 Secret。参见 [Cloudflare Workers Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

> [!WARNING]
> 公开部署时，不要绑定能够读取私有仓库的高权限 Token。当前仓库浏览 API 没有用户登录或访问控制；如果 Token 能读取私有仓库，知道仓库地址的人可能通过你的 Worker 获取该 Token 可访问的数据。请使用最小权限、仅限公开仓库的凭据，或先为 Worker 增加访问控制。

Passage 不接受浏览器传入的 Authorization，并且不会把 Worker Secret 返回给客户端。Token 只用于 Worker 请求 `api.github.com`。

## 支持的资源

| 类型 | 常见形式 |
| --- | --- |
| 仓库 | `github.com/owner/repository` |
| 文件 | `raw.githubusercontent.com`、GitHub `blob/raw/resolve` |
| Release | `releases/download`、`releases/latest` 及 GitHub Release 资产主机 |
| 归档 | `archive`、`tarball`、`zipball`、`codeload.github.com` |
| Gist | `gist.github.com`、`gist.githubusercontent.com` |
| CDN | `cdn.jsdelivr.net/gh/...` |

## 内部 API

内置前端使用以下接口：

```text
GET <PREFIX>api/repo?url=<repository-url>
GET <PREFIX>api/contents?owner=<owner>&repo=<repo>&path=<path>&ref=<ref>
```

- `api/repo` 聚合仓库信息、最多 20 个 Releases、根目录和 README 元数据。
- `api/contents` 在用户展开目录时按需加载该目录。
- 非关键子请求失败时，其他已获得的数据仍可显示，并通过 `warnings` 返回提示。

`api/repo` 的响应结构：

```json
{
  "repository": {},
  "releases": [],
  "contents": [],
  "readme": null,
  "warnings": []
}
```

更详细的接口与开发约束见 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。

## 安全边界

- 只接受 HTTPS，拒绝 URL 用户名、密码、异常端口、控制字符和过长目标。
- GitHub API 主机固定为 `api.github.com`。
- 资源请求和每一跳重定向都必须命中明确允许的 GitHub/CDN 主机。
- 不转发 Cookie、Authorization、来源 IP 和代理相关请求头。
- 不向客户端转发上游 Cookie、认证挑战、CSP 或 `Clear-Site-Data`。
- 仓库路径逐段验证与编码，拒绝路径穿越和控制字符。
- 错误响应不包含运行时堆栈。

## 本地检查

需要 Node.js 18 或更高版本：

```powershell
node --check .\worker.js
```

本仓库不需要安装前端框架、打包器或运行时依赖。

## 文件

- [`worker.js`](./worker.js)：可部署的单文件 Worker。
- [`README.md`](./README.md)：部署、配置和使用说明。
- [`DEVELOPMENT.md`](./DEVELOPMENT.md)：架构、API 契约和安全约束。

## 限制

- 仓库浏览面向公开仓库，GitHub API 仍受上游限额和可用性影响。
- 只读取最多 20 个 Releases，每个 Release 最多映射 50 个附件。
- 文件树按目录加载，不提供全仓库全文搜索。
- README 仅提供安全入口，不在页面内渲染远程 Markdown。
- 代理 clone 仅适合公开仓库；代理不会转发客户端 Authorization。
- 经典 Service Worker 格式仍可运行，但可能无法使用 Cloudflare 后续只面向 Module Worker 的新功能。
