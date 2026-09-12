# Passage

**GitHub 资源，一步直达。**

粘贴一个链接，浏览公开仓库，或获取资源代理地址。

![Passage 首页](./docs/passage-preview.jpg)

## 项目介绍

Passage 是一个运行在 Cloudflare Workers 上的轻量 GitHub 资源工具。仓库概览、Releases、文件目录和 README 入口集中在同一个页面；Raw、Blob、Release、Archive 等资源链接则可直接转换为代理地址。

界面采用简洁的单输入框设计，默认浅色，支持深色主题和手机浏览。整个应用包含在一个 `worker.js` 中，无需前端框架、安装依赖或构建步骤。

## 主要功能

- **浏览仓库**：查看描述、Stars、Forks、语言、默认分支和更新时间。
- **获取版本**：每个 Release 可独立展开；超过 4 个版本时，仅最新版默认展开。
- **查看文件**：目录按需加载，支持根目录筛选，以及 GitHub、Raw 和代理下载入口。
- **资源代理**：识别 Raw、Blob、Release、Archive、Gist、codeload 和 jsDelivr 链接，支持复制或直接打开生成的地址。
- **便捷操作**：复制代理克隆命令，使用 `/` 聚焦输入框、`Esc` 清空输入，不保存输入历史。
- **减少重复请求**：缓存 GitHub API 数据、合并相同请求，并在限流后暂停访问。

## 使用方法

打开部署后的页面，粘贴链接并点击「继续」。

| 输入 | 用途 |
| --- | --- |
| `https://github.com/owner/repository` | 浏览公开仓库 |
| `https://raw.githubusercontent.com/owner/repository/main/file.txt` | 获取源码文件代理地址 |
| `https://github.com/owner/repository/releases/download/v1.0.0/app.zip` | 获取 Release 附件代理地址 |

也可以将完整资源链接直接接在站点地址后：

```text
https://your-worker.example/https://raw.githubusercontent.com/owner/repository/main/file.txt
```

仓库浏览页面提供 README 的阅读和下载入口，不直接渲染全文。

## 部署与配置

1. 在 Cloudflare Workers 创建 Worker。
2. 将本仓库的 `worker.js` 作为完整脚本部署。它使用经典 Service Worker 格式，入口为 `addEventListener("fetch", ...)`，替换模板时请替换整个文件。
3. 访问 Worker 地址即可使用；如果设置了路径前缀，请访问对应路径。

文件顶部的配置可以按需修改：

```js
var Config = {
  PREFIX: "/",
  jsdelivr: 0,
  MAX_REDIRECTS: 4
};
```

| 配置项 | 说明 |
| --- | --- |
| `PREFIX` | 访问路径前缀，默认 `/`，也可设为 `/gh/` |
| `jsdelivr` | 设为 `1` 时，将符合条件的 Blob、Raw 请求转到 jsDelivr |
| `MAX_REDIRECTS` | 资源代理最多跟随的重定向次数，默认 `4` |

使用 `/gh/` 前缀时，代理地址示例为：

```text
https://your-worker.example/gh/https://github.com/owner/repository/releases/download/v1.0.0/app.zip
```

可选配置 `GITHUB_TOKEN` Worker Secret，用于 GitHub API 认证。仅浏览公开仓库时，无需授予私有仓库访问权限；不要将 Token 写入公开代码。

## 缓存与请求

GitHub API 数据默认缓存 5 分钟，过期后通过条件请求检查更新。同一运行实例内的重复请求会被合并，上游请求按顺序执行。

遇到限流时，服务按 GitHub 返回的时间暂停请求；临时故障时，可显示 30 分钟内的缓存数据并给出提示。这些措施能减少 API 消耗，但不能保证所有访问量下都不会触发限流。

## 项目文件

- `worker.js`：完整应用与部署入口。
- `docs/passage-preview.jpg`：当前首页截图。
- `DEVELOPMENT.md`：开发结构与接口参考。

本地语法检查：

```sh
node --check worker.js
```
