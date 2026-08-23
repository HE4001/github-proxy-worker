# Passage — GitHub 资源代理与项目浏览器

这是一个零依赖、单文件的 Cloudflare Worker。它既能代理常见 GitHub 下载资源，也能在首页浏览公开项目的概览、Releases、文件树和 README 链接。

内置前端支持浅色/深色主题、响应式布局、仓库 URL 状态恢复、根目录筛选、代理克隆命令，以及适合键盘操作的无障碍交互。

## 文件说明

- `worker.js`：最终部署文件，已经包含完整前端。
- `frontend-home.js`：便于独立维护的首页生成函数。
- `integrate-frontend.mjs`：把前端函数机械整合回 `worker.js`。
- `worker.test.js`：使用 Node 内置能力运行的路由、安全和接口测试。
- `DEVELOPMENT.md`：架构、接口契约、安全边界、开发路径和验收条件。

## 配置

直接部署时，可以编辑 `worker.js` 顶部的配置：

```js
var Config = {
  PREFIX: "/",
  jsdelivr: 0,
  MAX_REDIRECTS: 4
};
```

- `PREFIX`：部署子路径，例如 `/gh/`。开头和结尾的 `/` 会自动规范化。
- `jsdelivr`：设为 `1` 后，Blob 和 Raw 文件会跳转到 jsDelivr。
- `MAX_REDIRECTS`：代理最多跟随的重定向次数，最高限制为 8。

建议在 Cloudflare Worker 中增加 Secret `GITHUB_TOKEN`。未配置 Token 时 GitHub API 的共享出口额度较低；Token 只由 Worker 发给 `api.github.com`，不会接受或转发浏览器的 Authorization。

## 本地验证

需要 Node.js 18 或更高版本：

```powershell
node --check .\worker.js
node --check .\frontend-home.js
node --test .\worker.test.js
```

修改 `frontend-home.js` 后，重新生成单文件并验证：

```powershell
node .\integrate-frontend.mjs
node --check .\worker.js
node --test .\worker.test.js
```

## 部署

将 `worker.js` 作为传统 Service Worker 脚本部署，或直接粘贴到 Cloudflare Workers 编辑器。部署后访问 Worker 根路径；输入：

- `https://github.com/owner/repo`：加载项目仪表板。
- Release、Archive、Blob、Raw、Gist 等资源 URL：生成代理地址。

项目数据接口：

- `GET <PREFIX>api/repo?url=<repository-url>`
- `GET <PREFIX>api/contents?owner=<owner>&repo=<repo>&path=<path>&ref=<ref>`

## 安全边界

Worker 不提供通用 URL 代理。GitHub API 主机固定为 `api.github.com`，下载请求与每一跳重定向都必须命中允许的 GitHub/CDN 域名。客户端 Cookie、Authorization、来源 IP 头，以及上游 Cookie、认证挑战、CSP 和 Clear-Site-Data 不会被转发。
