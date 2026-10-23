# 网页快照

**一句话**：把 URL 抓成 Markdown（标题 / 正文 / 来源 / 抓取时间），一次一批。

## 什么时候用

- 用户要「把这个网页存成 Markdown / 摘正文 / 存知识库」；
- 手上有一批 URL 或一个 `sitemap.xml`，要批量抓成可读文本；
- 需要保留**来源 URL + 抓取时间**，方便回溯是哪一版页面。

## 怎么调用

```bash
<cli 路径> --help
```

```bash
# 单页
<cli 路径> url https://example.com/article
<cli 路径> url https://example.com/article --out snapshots/   # 指定目录
<cli 路径> url https://example.com/article --out page.md      # 指定文件
<cli 路径> url https://example.com/article --json             # 给流水线

# 批量（一行一个 URL，# 注释；单条失败不中断）
<cli 路径> batch --input urls.txt --out snapshots/
<cli 路径> batch --input urls.txt --json

# sitemap
<cli 路径> sitemap https://example.com/sitemap.xml --limit 20
<cli 路径> sitemap --input local-sitemap.xml

<cli 路径> --demo
```

## 产物长什么样

```markdown
# 页面标题

- 来源：https://example.com/article
- 抓取时间：2026-01-01T00:00:00.000Z
- 状态码：200
- 内容大小：12.3 KB

---

正文（标题 / 段落 / 列表 / 链接 / 引用 / 代码块 / 简单表格）
```

`--json` 返回 `{ ok, url, title, status, bytes, fetchedAt, out }`（batch 另含 `total/okCount/failedCount/results`）。
退出码：`0` 全部成功 / `1` 有抓取失败 / `2` 用法错误或非法 URL / 协议。

## 安全默认值（会明确报错，不静默降级）

- 只允许 **http/https**：`file:` / `ftp:` / `data:` 一律拒绝；
- 单次请求超时 **10s**（`--timeout <ms>` 可调），响应上限 **5MB**；
- 带明确 User-Agent；跟随重定向最多 5 次，且重定向目标同样只允许 http(s)。

## 边界（必须向用户说清）

- ❌ **不执行 JavaScript**：SPA / 需登录 / 反爬页面抓到的只是初始 HTML，正文可能为空。
- ❌ **正文提取是启发式**：优先 `article > main > 常见 content 容器 > body`；复杂页面可能漏内容或混入推荐位。
- ❌ 嵌套列表 / 复杂表格会被拍平；不追求像素级还原。
- ❌ 不下载图片 / PDF / 附件（图片只保留 Markdown 链接），不做爬虫调度、代理池、登录态。
- ❌ 不做 robots / ToS 判断；是否允许抓取由使用者自行确认。
- 默认只写输出目录，不改输入；同名文件覆盖前先备份为 `.bak`。
