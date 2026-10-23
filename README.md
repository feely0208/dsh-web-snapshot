# @deepwhale-cn/dsh-web-snapshot

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/feely0208/dsh-web-snapshot)

**网页快照**：把 URL 抓成干净 Markdown（标题 / 正文 / 来源 / 抓取时间），一次抓一批，失败不中断。

**关键词**：网页快照 · 网页转 Markdown · URL 转 Markdown · 正文提取 · 批量抓取 · sitemap · 离线素材
**Keywords**: web snapshot · URL to markdown · HTML to markdown · batch crawl · sitemap

## 不装会怎样

把网页内容喂给模型或存成知识库时，直接复制粘贴会带上导航、页脚、广告和一堆脚本；用 `curl` 抓下来又是满屏 HTML。更重要的是：**抓下来的东西没有来源和抓取时间，过两周就说不清是哪一版**。批量抓十个链接，中间一条 404 就整批中断 —— 这个插件把这些琐事收成一条命令。

## 能做什么

- **`url <URL>`**：抓单个页面 → 一个 `.md`，含 `# 标题`、正文、`来源`、`抓取时间`、状态码。
  - 去 `script` / `style` / `nav` / `footer` / `aside` / `form` 等干扰
  - 正文优先取 `<article>` → `<main>` → 常见 content 容器 → `<body>`
  - 保留标题、段落、列表、链接、图片、引用、代码块、简单表格；相对链接 / 图片自动转绝对地址
- **`batch --input <urls.txt>`**：一行一个 URL（`#` 开头为注释），逐条抓取；**单条失败不中断**，最后汇总成功 / 失败数量和对应文件名。
- **`sitemap <sitemap.xml|URL>`**：读取 `urlset` 或 `sitemapindex`（子 sitemap 自动展开，最多 10 个），`--limit` 限制列出条数，`--out` 写出 URL 列表文件。
- **安全默认值**：只允许 `http/https`（拒绝 `file:` / `ftp:` / `data:`）；单次请求超时 **10s**；响应上限 **5MB**；带明确的 User-Agent。
- **`--json`** 给流水线；`--demo` 自起本地 HTTP 服务，把单页 / 批量（含失败）/ sitemap 全套跑通，全程不联网。

## 不能做什么

- ❌ **不执行 JavaScript**：SPA / 需要登录 / 反爬校验的页面，抓到的只是初始 HTML，正文可能是空的。
- ❌ **正文提取是启发式**：按 `article/main` 和常见 class 猜正文，复杂页面可能漏内容或混入推荐位、评论；提取边界不保证。
- ❌ **嵌套列表、复杂表格会被拍平**：MVP 只保证常见结构的可读性，不追求像素级还原。
- ❌ **不下载资源**：图片只保留 Markdown 链接，不落地图片 / PDF / 附件，也不做爬虫调度和代理池。
- ❌ **不做 robots / ToS 判断**：是否允许抓取由使用者自行确认并承担后果；本工具不绕过任何访问控制。
- ⚠️ 纯 Node 内置 `fetch`，不装依赖；不负责渲染、截图、OCR。

## 安装

```bash
dsh plugin --profile web add @deepwhale-cn/dsh-web-snapshot
# 或纯 CLI
npx @deepwhale-cn/dsh-web-snapshot --help
```

## 用法

```bash
dsh-web-snapshot url https://example.com/article
dsh-web-snapshot url <URL> --out snapshots/         # 指定输出目录
dsh-web-snapshot url <URL> --out page.md            # 指定文件名
dsh-web-snapshot batch --input urls.txt --out snapshots/
dsh-web-snapshot sitemap https://example.com/sitemap.xml --limit 20
dsh-web-snapshot sitemap --input local-sitemap.xml
dsh-web-snapshot --demo
```

退出码：`0` 全部成功 · `1` 有抓取失败 · `2` 用法错误 / 非法 URL 或协议。
输出目录里已有同名文件时会先备份为 `.bak` 再覆盖。

## License

MIT © 温州深鲸智能科技有限公司
