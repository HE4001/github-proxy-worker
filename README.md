# Passage

一个链接，浏览 GitHub 仓库，或生成资源代理地址。

![Passage 项目界面](./docs/passage-preview.jpg)

## 项目介绍

Passage 是一个运行在 Cloudflare Workers 上的 GitHub 资源工具。它把仓库浏览和资源代理放在同一个页面里：粘贴公开仓库链接，可以查看项目概览、Releases、文件树和 README 入口；粘贴 Raw、Release、Archive 或 Gist 链接，则会生成当前站点的代理地址。

整个项目只有一个可部署的 `worker.js`。页面、样式、浏览器交互、GitHub API 请求和代理逻辑都包含在这个文件中，不需要安装前端框架或运行时依赖。

## 主要功能

- 自动识别 GitHub 仓库链接和资源链接。
- 展示仓库描述、Stars、Forks、Issues、语言、默认分支和更新时间。
- 按版本独立折叠 Releases；版本较多时只默认展开最新版本。
- 按需展开项目目录，并为文件提供 GitHub、Raw 和代理入口。
- 提供 README 的 GitHub、Raw 与代理下载入口。
- 支持 Raw、Blob、Release、Archive、Gist、codeload 和 jsDelivr 资源。
- 支持浅色、深色主题以及桌面、手机响应式布局。
- 输入框不显示自动完成记录，并支持 `/` 快速聚焦和 `Esc` 清空。

## 使用方式

部署后打开 Worker 首页，粘贴链接即可：

| 链接类型 | 页面行为 |
| --- | --- |
| `https://github.com/owner/repository` | 打开仓库浏览视图 |
| Raw、Blob、Release、Archive、Gist 链接 | 生成代理地址 |

也可以直接把完整资源 URL 放在 Worker 地址之后：

```text
https://your-worker.example/https://raw.githubusercontent.com/owner/repository/main/file.txt
```

如果部署前缀为 `/gh/`：

```text
https://your-worker.example/gh/https://github.com/owner/repository/releases/download/v1.0.0/app.zip
```

## 部署

1. 在 Cloudflare Workers 中创建一个支持经典 Service Worker 脚本的 Worker。
2. 将本仓库的 `worker.js` 作为完整脚本部署。
3. 根据需要修改文件顶部的配置。
4. 访问 Worker 根地址开始使用。

```js
var Config = {
  PREFIX: "/",
  jsdelivr: 0,
  MAX_REDIRECTS: 4
};
```

| 配置项 | 说明 |
| --- | --- |
| `PREFIX` | 部署路径前缀，例如 `/gh/` |
| `jsdelivr` | 设为 `1` 时，将符合条件的 Blob/Raw 请求转到 jsDelivr |
| `MAX_REDIRECTS` | 代理最多跟随的重定向次数 |

如需提高 GitHub API 请求配额，可以将 `GITHUB_TOKEN` 配置为 Worker Secret，并使用只读、最小权限的 Token。

## 本地检查

```powershell
node --check .\worker.js
```

## 项目文件

- `worker.js`：可直接部署的单文件 Worker。
- `README.md`：项目介绍和使用说明。
- `DEVELOPMENT.md`：开发结构与接口说明。
