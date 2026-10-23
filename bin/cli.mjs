#!/usr/bin/env node
/**
 * 深鲸守护 · 网页快照（dsh-web-snapshot）
 *
 * 把 URL 抓成 Markdown（标题 / 正文 / 来源 / 抓取时间），一次一批。
 *
 * 子命令：
 *   url <URL>                  抓单个页面 → 一个 .md
 *   batch --input <urls.txt>    批量抓，逐条失败不中断，最后汇总
 *   sitemap <sitemap.xml|URL>   读 sitemap，列出 URL（--limit 限制条数）
 *
 * 安全边界：
 *   - 只允许 http/https，拒绝 file: / ftp: / data: 等协议；
 *   - 超时 10s（可调），响应上限 5MB；
 *   - 明确 User-Agent；
 *   - 纯 Node 内置 fetch，不装依赖、不联网安装。
 */

import { createServer } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync, statSync, copyFileSync, mkdtempSync,
} from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const CLI_PATH = fileURLToPath(import.meta.url);
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
const TOOL = 'dsh-web-snapshot';

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const MAX_CHILD_SITEMAPS = 10;
const UA = `${TOOL}/${PKG.version} (+https://www.deepwhale.org.cn/skills.html)`;

/* ─────────────────────────── 小工具 ─────────────────────────── */

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}
const usageError = (msg) => new UsageError(msg);

function assertHttpUrl(raw, label = 'URL') {
  let u;
  try { u = new URL(String(raw)); } catch { throw usageError(`${label} 不合法：${raw}`); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw usageError(`只允许 http/https，拒绝 ${u.protocol} 协议：${raw}`);
  }
  return u;
}

function jsonOut(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
}

function truncate(s, n) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/* ─────────────────────────── 抓取 ─────────────────────────── */

function decodeBody(buf, contentType) {
  const m = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType || '');
  const label = (m ? m[1] : 'utf-8').trim();
  try { return new TextDecoder(label).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); }
}

/**
 * 抓一个 http(s) 资源：跟随重定向（最多 5 次）、超时、大小上限。
 * @returns {Promise<{url:string,status:number,contentType:string,bytes:number,text:string}>}
 */
async function fetchResource(rawUrl, { accept = '*/*', timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  let current = assertHttpUrl(rawUrl).href;
  let redirects = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'user-agent': UA,
          accept,
          'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
        },
      });

      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error(`HTTP ${res.status} 但没有 Location：${current}`);
        if (redirects >= MAX_REDIRECTS) throw new Error(`重定向超过 ${MAX_REDIRECTS} 次：${rawUrl}`);
        redirects += 1;
        const next = new URL(loc, current).href;
        assertHttpUrl(next, '重定向目标');
        current = next;
        continue;
      }

      if (!res.ok) throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}：${current}`);

      const chunks = [];
      let total = 0;
      if (res.body) {
        for await (const chunk of res.body) {
          total += chunk.byteLength;
          if (total > maxBytes) {
            throw new Error(`响应超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 上限，已中止：${current}`);
          }
          chunks.push(Buffer.from(chunk));
        }
      }
      const buf = Buffer.concat(chunks);
      const contentType = res.headers.get('content-type') || '';
      return { url: current, status: res.status, contentType, bytes: buf.length, text: decodeBody(buf, contentType) };
    } catch (e) {
      if (controller.signal.aborted) {
        throw new Error(`请求超时（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)}s` : `${timeoutMs}ms`}）：${current}`);
      }
      if (e && e.exitCode === 2) throw e; // 协议校验失败：原样抛出
      if (e && /^HTTP |^响应超过|^重定向超过|^请求超时/.test(e.message || '')) throw e;
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      throw new Error(`抓取失败：${current}（${cause || (e && e.message) || e}）`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/* ─────────────────────────── HTML → Markdown ─────────────────────────── */

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™',
  times: '×', divide: '÷', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  bull: '•', deg: '°', plusmn: '±', frac12: '½', yen: '¥', euro: '€', pound: '£', sect: '§',
};

function decodeEntities(text) {
  return String(text).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]+);/gi, (m, ent) => {
    if (ent[0] === '#') {
      const code = ent[1] && ent[1].toLowerCase() === 'x'
        ? Number.parseInt(ent.slice(2), 16)
        : Number.parseInt(ent.slice(1), 10);
      if (Number.isFinite(code) && code > 0 && code <= 0x10ffff) {
        try { return String.fromCodePoint(code); } catch { return m; }
      }
      return m;
    }
    const v = NAMED_ENTITIES[ent.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const stripTags = (html) => decodeEntities(String(html).replace(/<[^>]*>/g, ''));

function attr(attrs, name) {
  const re = new RegExp(`(?:^|[\\s"'<])${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>"']+))`, 'i');
  const m = re.exec(attrs || '');
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? '';
}

function stripElement(html, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
  let out = html;
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(re, '');
    if (next === out) break;
    out = next;
  }
  return out;
}

function stripChrome(html) {
  let h = String(html).replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'template', 'iframe', 'svg', 'canvas', 'nav', 'footer', 'aside', 'form', 'button', 'select', 'option', 'textarea', 'object', 'embed']) {
    h = stripElement(h, tag);
  }
  return h;
}

function extractInnerByOpenTag(html, tagName, attrTest) {
  const openRe = new RegExp(`<${tagName}\\b([^>]*)>`, 'gi');
  let m;
  while ((m = openRe.exec(html))) {
    if (attrTest && !attrTest(m[1] || '')) continue;
    const innerStart = m.index + m[0].length;
    const scanRe = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
    scanRe.lastIndex = innerStart;
    let depth = 1;
    let t;
    while ((t = scanRe.exec(html))) {
      if (t[0][1] === '/') {
        depth -= 1;
        if (depth === 0) return html.slice(innerStart, t.index);
      } else if (!t[0].endsWith('/>')) {
        depth += 1;
      }
    }
    return html.slice(innerStart);
  }
  return null;
}

/** 正文区域：article > main > 常见 content 容器 > body > 全文 */
function pickBodyRegion(html) {
  const candidates = [
    () => extractInnerByOpenTag(html, 'article'),
    () => extractInnerByOpenTag(html, 'main'),
    () => extractInnerByOpenTag(html, 'div', (a) => /(?:id|class)\s*=\s*["'][^"']*(?:article|content|post|entry|main|body)[^"']*["']/i.test(a)),
    () => extractInnerByOpenTag(html, 'body'),
  ];
  for (const pick of candidates) {
    const region = pick();
    if (region && stripTags(region).trim().length >= 80) return region;
  }
  const body = candidates[3]();
  return body || html;
}

function absLink(href, baseUrl) {
  const h = String(href == null ? '' : href).trim();
  if (!h) return '';
  if (h.startsWith('#')) return h;
  if (/^(mailto:|tel:|sms:|javascript:)/i.test(h)) return h;
  if (/^data:/i.test(h)) return '';
  try { return new URL(h, baseUrl).href; } catch { return h; }
}

/** 行内元素转换：只处理 a / img / strong / em 等，保留块级标签和换行 */
function inlinePass(html, baseUrl) {
  let s = String(html);
  s = s.replace(/<img\b([^>]*?)\/?>/gi, (m, attrs) => {
    const src = attr(attrs, 'src');
    const link = absLink(src, baseUrl);
    if (!link || /^data:/i.test(src || '')) return '';
    const alt = String(attr(attrs, 'alt') || attr(attrs, 'title') || '').replace(/\s+/g, ' ').trim();
    return `![${alt}](${link})`;
  });
  s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (m, attrs, inner) => {
    const href = attr(attrs, 'href');
    const text = inlineMark(inner, baseUrl);
    if (!href || /^javascript:/i.test(href)) return text;
    const link = absLink(href, baseUrl);
    return text ? `[${text}](${link})` : '';
  });
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `**${inlineMark(inner, baseUrl)}**`);
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `*${inlineMark(inner, baseUrl)}*`);
  s = s.replace(/<(del|s|strike)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => `~~${inlineMark(inner, baseUrl)}~~`);
  s = s.replace(/<(sup|sub)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, tag, inner) => stripTags(inner));
  return s;
}

/** 片段 → 单行 Markdown（用于标题 / 引用 / 列表项 / 表格单元格） */
function inlineMark(fragment, baseUrl) {
  const s = inlinePass(fragment, baseUrl).replace(/<[^>]+>/g, ' ');
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

/**
 * 简单但可用的 HTML → Markdown：
 * 去 script/style/nav/footer 等，保留标题 / 段落 / 列表 / 链接 / 图片 / 代码块。
 */
function htmlToMarkdown(html, baseUrl) {
  const blocks = [];
  const stash = (md) => {
    blocks.push(md);
    return `\u0000B${blocks.length - 1}\u0000`;
  };

  let h = String(html);
  h = h.replace(/<!--[\s\S]*?-->/g, '');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<hr\b[^>]*\/?>/gi, '\n\n---\n\n');

  // 代码块 / 行内代码先摘出来，避免后面被当标签清掉
  h = h.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (m, inner) => {
    const code = stripTags(inner).replace(/\r\n?/g, '\n').replace(/^\n+|\n+$/g, '');
    return stash(`\n\n\`\`\`\n${code}\n\`\`\`\n\n`);
  });
  h = h.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (m, inner) => {
    const code = stripTags(inner).replace(/\s+/g, ' ').trim();
    return stash(`\`${code}\``);
  });

  // 标题
  h = h.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (m, lvl, inner) => {
    const text = inlineMark(inner, baseUrl);
    return text ? stash(`\n\n${'#'.repeat(Number(lvl))} ${text}\n\n`) : '';
  });

  // 引用
  h = h.replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (m, inner) => {
    const text = inlineMark(inner, baseUrl);
    return text ? stash(`\n\n> ${text}\n\n`) : '';
  });

  // 表格
  h = h.replace(/<table\b[^>]*>([\s\S]*?)<\/table>/gi, (m, inner) => {
    const rows = [...inner.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map((rm) => [...rm[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
        .map((cm) => inlineMark(cm[1], baseUrl).replace(/\|/g, '\\|')))
      .filter((r) => r.length > 0);
    if (!rows.length) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (cells) => `| ${Array.from({ length: width }, (_, i) => cells[i] || '').join(' | ')} |`;
    const lines = [line(rows[0]), `| ${Array.from({ length: width }, () => '---').join(' | ')} |`];
    for (const row of rows.slice(1)) lines.push(line(row));
    return stash(`\n\n${lines.join('\n')}\n\n`);
  });

  // 列表（嵌套列表会被拍平，属于 MVP 边界）
  h = h.replace(/<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>/gi, (m, kind, inner) => {
    const ordered = kind.toLowerCase() === 'ol';
    let idx = 0;
    const items = [];
    for (const mm of inner.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) {
      idx += 1;
      const text = inlineMark(mm[1], baseUrl);
      if (text) items.push(`\n${ordered ? `${idx}.` : '-'} ${text}`);
    }
    return items.length ? stash(`\n\n${items.join('')}\n\n`) : '';
  });

  // 链接 / 图片 / 强调（块级内容里的行内元素；保留块级标签本身）
  h = inlinePass(h, baseUrl);

  // 块级标签 → 空行；剩余标签清掉
  h = h.replace(/<\/(p|div|section|article|header|main|li|dd|dt|figcaption|address|details|summary)>/gi, '\n\n');
  h = h.replace(/<(p|div|section|article|header|main|li|dd|dt|figcaption|address|details|summary)\b[^>]*>/gi, '\n\n');
  h = h.replace(/<\/(td|th)>/gi, ' ');
  h = h.replace(/<[^>]+>/g, '');
  h = decodeEntities(h);

  // 还原代码块/标题等占位
  h = h.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[Number(i)] ?? '');

  let md = h.replace(/\r\n?/g, '\n');
  md = md.split('\n').map((line) => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, '')).join('\n');
  md = md.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  return md;
}

function metaContent(html, key) {
  const lower = key.toLowerCase();
  for (const m of String(html).matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    const k = (attr(tag, 'property') || attr(tag, 'name') || '').toLowerCase();
    if (k === lower) return decodeEntities(attr(tag, 'content') || '').trim();
  }
  return '';
}

function extractTitle(html) {
  const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (t) {
    const s = stripTags(t[1]).replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  const og = metaContent(html, 'og:title');
  if (og) return og;
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (h1) {
    const s = stripTags(h1[1]).replace(/\s+/g, ' ').trim();
    if (s) return s;
  }
  return '';
}

function renderDoc({ title, description, url, fetchedAt, status, bytes, body }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push('');
  if (description) {
    lines.push(`> ${description}`);
    lines.push('');
  }
  lines.push(`- 来源：${url}`);
  lines.push(`- 抓取时间：${fetchedAt}`);
  lines.push(`- 状态码：${status}`);
  lines.push(`- 内容大小：${(bytes / 1024).toFixed(1)} KB`);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(body || '（正文提取为空：页面可能是纯脚本渲染，或正文不在 article/main 里）');
  lines.push('');
  return lines.join('\n');
}

/** 抓一个 URL，返回结构化的快照结果（不落盘） */
async function snapshotUrl(rawUrl, { timeoutMs = TIMEOUT_MS } = {}) {
  const res = await fetchResource(rawUrl, {
    accept: 'text/html,application/xhtml+xml,text/plain;q=0.8,*/*;q=0.5',
    timeoutMs,
  });
  if (!/text\/html|application\/xhtml\+xml|text\/plain/i.test(res.contentType)) {
    throw new Error(`不是 HTML 页面（content-type: ${res.contentType || '未知'}）：${res.url}`);
  }
  const title = extractTitle(res.text) || new URL(res.url).hostname;
  const description = metaContent(res.text, 'og:description') || metaContent(res.text, 'description');
  const body = htmlToMarkdown(pickBodyRegion(stripChrome(res.text)), res.url);
  const fetchedAt = new Date().toISOString();
  const markdown = renderDoc({ title, description, url: res.url, fetchedAt, status: res.status, bytes: res.bytes, body });
  return {
    url: res.url, status: res.status, bytes: res.bytes, contentType: res.contentType,
    title, description, body, fetchedAt, markdown,
  };
}

/* ─────────────────────────── 落盘 ─────────────────────────── */

function slugFor(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { return 'snapshot'; }
  const host = u.hostname.replace(/[^a-z0-9]+/gi, '-');
  const port = u.port ? `-${u.port}` : '';
  const path = u.pathname.replace(/\/+$/, '').replace(/[^a-z0-9]+/gi, '-');
  return `${host}${port}${path || '-index'}`.replace(/^-+|-+$/g, '').slice(0, 90) || 'snapshot';
}

function uniquePath(dir, base) {
  let target = join(dir, `${base}.md`);
  let i = 2;
  while (existsSync(target)) {
    target = join(dir, `${base}-${i}.md`);
    i += 1;
  }
  return target;
}

function writeSnapshot(target, result) {
  mkdirSync(dirname(target), { recursive: true });
  let backup = null;
  if (existsSync(target)) {
    backup = `${target}.bak`;
    copyFileSync(target, backup);
  }
  writeFileSync(target, result.markdown, 'utf-8');
  return { target, backup };
}

function targetFor(outArg, url, { unique = false } = {}) {
  if (outArg && /\.md$/i.test(outArg)) {
    return unique ? uniquePath(dirname(resolve(outArg)), basenameNoExt(outArg)) : resolve(outArg);
  }
  const dir = resolve(outArg || 'snapshots');
  const base = slugFor(url);
  return unique ? uniquePath(dir, base) : join(dir, `${base}.md`);
}

const basenameNoExt = (p) => {
  const b = String(p).split('/').pop() || 'snapshot';
  return b.replace(/\.md$/i, '');
};

/* ─────────────────────────── 子命令：url ─────────────────────────── */

async function cmdUrl(parsed) {
  const raw = parsed._[0] || parsed.input;
  if (!raw) throw usageError('url 需要一个 URL，例如：dsh-web-snapshot url https://example.com');
  try {
    const result = await snapshotUrl(raw, { timeoutMs: parsed.timeoutMs });
    const target = targetFor(parsed.out, result.url, { unique: false });
    const saved = writeSnapshot(target, result);
    const out = {
      ok: true, tool: TOOL, command: 'url', url: raw, finalUrl: result.url,
      title: result.title, status: result.status, bytes: result.bytes, contentType: result.contentType,
      fetchedAt: result.fetchedAt, out: saved.target, backup: saved.backup,
    };
    if (parsed.json) jsonOut(out);
    else {
      process.stdout.write(`\n  📄 网页快照完成\n`);
      process.stdout.write(`     标题：${result.title}\n`);
      process.stdout.write(`     来源：${result.url}\n`);
      process.stdout.write(`     时间：${result.fetchedAt}\n`);
      process.stdout.write(`     正文：${result.body.length} 字 · 响应 ${(result.bytes / 1024).toFixed(1)} KB\n`);
      process.stdout.write(`     产物：${saved.target}\n`);
      if (saved.backup) process.stdout.write(`     原文件已备份：${saved.backup}\n`);
      process.stdout.write('\n');
    }
    return 0;
  } catch (e) {
    const code = e && e.exitCode ? e.exitCode : 1;
    if (parsed.json) jsonOut({ ok: false, tool: TOOL, command: 'url', url: raw, error: e.message });
    else process.stderr.write(`\n  ❌ ${e.message}\n\n`);
    return code;
  }
}

/* ─────────────────────────── 子命令：batch ─────────────────────────── */

async function processBatch(urls, outDir, { timeoutMs = TIMEOUT_MS, silent = false } = {}) {
  const results = [];
  for (const url of urls) {
    try {
      const r = await snapshotUrl(url, { timeoutMs });
      const saved = writeSnapshot(uniquePath(outDir, slugFor(r.url)), r);
      results.push({ url, ok: true, out: saved.target, title: r.title, status: r.status, bytes: r.bytes });
      if (!silent) process.stdout.write(`   ✅ ${url}\n      → ${saved.target}\n`);
    } catch (e) {
      results.push({ url, ok: false, error: e.message });
      if (!silent) process.stdout.write(`   ❌ ${url}\n      ${e.message}\n`);
    }
  }
  const okCount = results.filter((r) => r.ok).length;
  return {
    ok: okCount === results.length,
    tool: TOOL,
    command: 'batch',
    total: results.length,
    okCount,
    failedCount: results.length - okCount,
    out: outDir,
    results,
    checkedAt: new Date().toISOString(),
  };
}

async function cmdBatch(parsed) {
  if (!parsed.input) throw usageError('batch 需要 --input <urls.txt>（一行一个 URL，# 开头为注释）');
  let text;
  if (parsed.input === '-') text = readFileSync(0, 'utf-8');
  else {
    const p = resolve(parsed.input);
    if (!existsSync(p)) throw usageError(`urls 文件不存在：${p}`);
    text = readFileSync(p, 'utf-8');
  }
  const urls = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (!urls.length) throw usageError('urls 文件里没有有效 URL');
  const outDir = resolve(parsed.out && !/\.md$/i.test(parsed.out) ? parsed.out : (parsed.out ? dirname(resolve(parsed.out)) : 'snapshots'));
  mkdirSync(outDir, { recursive: true });

  if (!parsed.json) process.stdout.write(`\n  📚 批量快照：${urls.length} 条 → ${outDir}\n\n`);
  const result = await processBatch(urls, outDir, { timeoutMs: parsed.timeoutMs, silent: parsed.json });

  if (parsed.json) jsonOut(result);
  else {
    process.stdout.write(`\n  ${result.ok ? '✅' : '⚠️ '} 汇总：成功 ${result.okCount} · 失败 ${result.failedCount} · 共 ${result.total}\n`);
    if (!result.ok) process.stdout.write('     有失败条目；成功抓取的产物已保留，可修好 URL 后重跑。\n');
    process.stdout.write(`     产物目录：${outDir}\n\n`);
  }
  return result.ok ? 0 : 1;
}

/* ─────────────────────────── 子命令：sitemap ─────────────────────────── */

function parseLocs(xml) {
  return [...String(xml).matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)]
    .map((m) => decodeEntities(m[1]).trim())
    .filter(Boolean);
}

async function loadSitemap(source, { timeoutMs = TIMEOUT_MS } = {}) {
  let text;
  let sourceLabel = source;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchResource(source, { accept: 'application/xml,text/xml,*/*;q=0.5', timeoutMs });
    text = res.text;
    sourceLabel = res.url;
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(source)) {
    assertHttpUrl(source); // file: / ftp: 等在这里被拒绝
    throw usageError(`不支持的 sitemap 来源：${source}`);
  } else {
    const p = resolve(source);
    if (!existsSync(p)) throw usageError(`sitemap 文件不存在：${p}`);
    text = readFileSync(p, 'utf-8');
  }

  const notes = [];
  let urls = parseLocs(text);
  const isIndex = /<sitemapindex\b/i.test(text);
  if (isIndex) {
    const children = urls.slice(0, MAX_CHILD_SITEMAPS);
    if (urls.length > children.length) notes.push(`子 sitemap 共 ${urls.length} 个，只展开前 ${children.length} 个`);
    const collected = [];
    for (const child of children) {
      try {
        const res = await fetchResource(child, { accept: 'application/xml,text/xml,*/*;q=0.5', timeoutMs });
        collected.push(...parseLocs(res.text));
      } catch (e) {
        notes.push(`子 sitemap 抓取失败：${child}（${e.message}）`);
      }
    }
    urls = collected;
  }
  urls = [...new Set(urls)];
  return { source: sourceLabel, isIndex, urls, notes };
}

async function cmdSitemap(parsed) {
  const source = parsed._[0] || parsed.input;
  if (!source) throw usageError('sitemap 需要一个 sitemap 地址或 --input <sitemap.xml>');
  try {
    const loaded = await loadSitemap(source, { timeoutMs: parsed.timeoutMs });
    const limit = parsed.limit;
    const urls = limit && limit > 0 ? loaded.urls.slice(0, limit) : loaded.urls;
    const result = {
      ok: true, tool: TOOL, command: 'sitemap', source: loaded.source,
      isSitemapIndex: loaded.isIndex, total: loaded.urls.length, count: urls.length,
      urls, notes: loaded.notes, checkedAt: new Date().toISOString(),
    };
    if (parsed.out) {
      const dir = /\.txt$/i.test(parsed.out) ? dirname(resolve(parsed.out)) : resolve(parsed.out);
      mkdirSync(dir, { recursive: true });
      const target = /\.txt$/i.test(parsed.out) ? resolve(parsed.out) : join(dir, 'sitemap-urls.txt');
      writeFileSync(target, `${urls.join('\n')}\n`, 'utf-8');
      result.out = target;
    }
    if (parsed.json) jsonOut(result);
    else {
      process.stdout.write(`\n  🗺  sitemap\n`);
      process.stdout.write(`     来源：${loaded.source}${loaded.isIndex ? '（sitemapindex）' : ''}\n`);
      process.stdout.write(`     共 ${loaded.urls.length} 个 URL${urls.length !== loaded.urls.length ? `，按 --limit 显示 ${urls.length} 个` : ''}\n`);
      if (loaded.notes.length) for (const n of loaded.notes) process.stdout.write(`     ⚠️  ${n}\n`);
      process.stdout.write('\n');
      urls.forEach((u, i) => process.stdout.write(`   ${String(i + 1).padStart(2, ' ')}. ${u}\n`));
      if (result.out) process.stdout.write(`\n     📄 URL 列表已写入：${result.out}\n`);
      process.stdout.write('\n');
    }
    return 0;
  } catch (e) {
    const code = e && e.exitCode ? e.exitCode : 1;
    if (parsed.json) jsonOut({ ok: false, tool: TOOL, command: 'sitemap', source, error: e.message });
    else process.stderr.write(`\n  ❌ ${e.message}\n\n`);
    return code;
  }
}

/* ─────────────────────────── demo ─────────────────────────── */

const DEMO_HTML = () => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>深鲸快照演示页</title>
<meta name="description" content="这是 dsh-web-snapshot 的本地演示数据">
<style>body{font:14px sans-serif}</style>
<script>window.__tracker = function(){ alert('这段脚本不该出现在 Markdown 里'); };</script>
</head><body>
<nav><a href="/">首页</a> · <a href="/about">关于</a>（导航栏文字不该出现）</nav>
<header><h1>深鲸快照演示页</h1></header>
<main>
  <article>
    <h2>正文标题</h2>
    <p>这里是正文第一段：本地演示服务器返回的 HTML，被转成了 Markdown。</p>
    <p>第二段包含 <strong>加粗</strong>、<em>斜体</em> 和 <a href="/about">关于我们</a> 链接。</p>
    <ul><li>列表项一</li><li>列表项二</li></ul>
    <blockquote>一段引用，用来验证引用转换。</blockquote>
    <pre><code>const answer = 42;</code></pre>
    <p><img src="/logo.png" alt="站点 logo"></p>
  </article>
</main>
<footer>页脚文字不该出现</footer>
</body></html>`;

const DEMO_ABOUT = () => `<!doctype html><html><head><title>关于深鲸</title></head>
<body><main><article><h1>关于</h1><p>这是演示站点的关于页面，用于批量抓取演示。</p></article></main></body></html>`;

const DEMO_SITEMAP = (base) => `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc></url>
  <url><loc>${base}/about</loc></url>
</urlset>`;

function startDemoServer() {
  return new Promise((resolvePromise) => {
    const server = createServer((req, res) => {
      let path = '/';
      try { path = new URL(req.url, 'http://127.0.0.1').pathname; } catch { /* 忽略 */ }
      const base = `http://127.0.0.1:${server.address().port}`;
      if (path === '/' || path === '/index.html') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DEMO_HTML());
      } else if (path === '/about') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(DEMO_ABOUT());
      } else if (path === '/sitemap.xml') {
        res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
        res.end(DEMO_SITEMAP(base));
      } else if (path === '/slow') {
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<html><title>slow</title><body>慢响应</body></html>');
        }, 3000);
      } else {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('not found');
      }
    });
    server.listen(0, '127.0.0.1', () => resolvePromise({ server, port: server.address().port }));
  });
}

async function cmdDemo(parsed) {
  const { server, port } = await startDemoServer();
  const base = `http://127.0.0.1:${port}`;
  try {
    const work = mkdtempSync(join(tmpdir(), 'dsh-web-snapshot-demo-'));
    const out = join(work, 'out');
    mkdirSync(out, { recursive: true });

    // 1) 单页
    const page = await snapshotUrl(`${base}/`);
    const pageSaved = writeSnapshot(join(out, 'demo-page.md'), page);

    // 2) 批量：一条成功、一条 404、一条非 http 协议 → 失败不中断
    const urlsFile = join(work, 'urls.txt');
    writeFileSync(urlsFile, `${base}/\n${base}/missing\nfile:///etc/passwd\n`);
    const batch = await processBatch([`${base}/`, `${base}/missing`, 'file:///etc/passwd'], join(out, 'batch'), { silent: true });

    // 3) sitemap
    const sitemap = await loadSitemap(`${base}/sitemap.xml`);
    const sitemapFile = join(out, 'sitemap-urls.txt');
    writeFileSync(sitemapFile, `${sitemap.urls.join('\n')}\n`);

    const checks = {
      title: page.title === '深鲸快照演示页',
      body: page.body.includes('正文第一段'),
      navRemoved: !page.markdown.includes('导航栏文字'),
      footerRemoved: !page.markdown.includes('页脚文字'),
      scriptRemoved: !page.markdown.includes('这段脚本不该出现'),
      linkResolved: page.markdown.includes(`(${base}/about)`),
      batchFailures: batch.failedCount === 2 && batch.okCount === 1,
      sitemap: sitemap.urls.length === 2,
    };
    const resultFile = join(out, 'demo-result.json');
    writeFileSync(resultFile, JSON.stringify({ tool: TOOL, out, page: pageSaved.target, sitemap: sitemapFile, batch, checks }, null, 2));

    if (parsed.json) {
      jsonOut({ ok: true, tool: TOOL, command: 'demo', out, page: pageSaved.target, sitemap: sitemapFile, batch: { total: batch.total, okCount: batch.okCount, failedCount: batch.failedCount }, checks });
      return 0;
    }

    const lines = [];
    lines.push('');
    lines.push(`  🕸  ${TOOL} · --demo`);
    lines.push('     自起一个本地 HTTP 服务（127.0.0.1 随机端口），抓页面 / 批量 / sitemap，全程不联网。');
    lines.push('');
    lines.push('  ── 单页 ──');
    lines.push(`     标题：${page.title}`);
    lines.push(`     正文：${page.body.length} 字`);
    lines.push(`     清洗：nav ${checks.navRemoved ? '✅ 已去掉' : '❌ 残留'} · footer ${checks.footerRemoved ? '✅ 已去掉' : '❌ 残留'} · script ${checks.scriptRemoved ? '✅ 已去掉' : '❌ 残留'}`);
    lines.push(`     链接：${checks.linkResolved ? '✅ 相对链接已转绝对' : '⚠️  相对链接未解析'}`);
    lines.push('');
    lines.push('  ── 批量（失败不中断）──');
    for (const r of batch.results) {
      lines.push(`     ${r.ok ? '✅' : '❌'} ${r.url}${r.ok ? '' : ` — ${r.error}`}`);
    }
    lines.push(`     汇总：成功 ${batch.okCount} · 失败 ${batch.failedCount}`);
    lines.push('');
    lines.push('  ── sitemap ──');
    lines.push(`     共 ${sitemap.urls.length} 个 URL：${sitemap.urls.join('  ')}`);
    lines.push('');
    lines.push('  ────────────────────────────────────────────────');
    lines.push('  产物路径：');
    lines.push(`    ${out}`);
    lines.push('      demo-page.md');
    lines.push('      demo-result.json');
    lines.push('      batch/（批量结果，1 个 .md）');
    lines.push('      sitemap-urls.txt');
    lines.push('');
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    server.close();
  }
}

/* ─────────────────────────── 帮助 & 入口 ─────────────────────────── */

function printHelp() {
  process.stdout.write(`
  ${TOOL} v${PKG.version}

  ${PKG.description}

  把网页抓成 Markdown：标题 / 正文 / 来源 / 抓取时间。纯 Node 内置 fetch，不装依赖。

  用法：
    dsh-web-snapshot url <URL> [--out <目录|文件.md>] [--json] [--timeout <ms>]
    dsh-web-snapshot batch --input <urls.txt> [--out <目录>] [--json] [--timeout <ms>]
    dsh-web-snapshot sitemap <sitemap.xml|URL> [--limit <n>] [--out <目录>] [--json]
    dsh-web-snapshot --demo
    dsh-web-snapshot --help

  选项：
    --input <路径>    batch 的 URL 清单（一行一个，# 开头为注释；- 表示 stdin）
    --out <路径>      输出目录；url 传 .md 路径则直接写该文件（已存在会先备份 .bak）
    --json            输出 JSON（给 CI 二次处理）
    --limit <n>       sitemap 最多列出多少个 URL
    --timeout <ms>    单次请求超时，默认 10000ms；响应上限 5MB

  安全边界：
    只允许 http/https（拒绝 file: / ftp: / data:）；超时 10s；响应上限 5MB；明确的 User-Agent。

  退出码：
    0  全部成功
    1  有抓取失败（batch 逐条失败不中断，最后汇总）
    2  用法错误或非法 URL / 协议
`);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--demo') out.demo = true;
    else if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--out' || a === '-o') out.out = argv[++i];
    else if (a === '--limit') out.limit = Number(argv[++i]);
    else if (a === '--timeout') out.timeoutMs = Number(argv[++i]);
    else if (a.startsWith('-')) throw usageError(`未知选项：${a}\n   用 --help 看用法。`);
    else out._.push(a);
  }
  if (out.limit !== undefined && (!Number.isFinite(out.limit) || out.limit < 0)) {
    throw usageError('--limit 需要一个非负整数');
  }
  if (out.timeoutMs !== undefined && (!Number.isFinite(out.timeoutMs) || out.timeoutMs <= 0)) {
    throw usageError('--timeout 需要一个正整数（毫秒）');
  }
  return out;
}

async function main() {
  const raw = process.argv.slice(2);
  if (raw.length === 0) {
    printHelp();
    return 0;
  }
  const parsed = parseArgs(raw);
  if (parsed.help) {
    printHelp();
    return 0;
  }
  if (parsed.demo || parsed._[0] === 'demo') return cmdDemo(parsed);

  const cmd = parsed._.shift();
  switch (cmd) {
    case 'url': return cmdUrl(parsed);
    case 'batch': return cmdBatch(parsed);
    case 'sitemap': return cmdSitemap(parsed);
    default:
      throw usageError(`未知子命令：${cmd}\n   可用：url / batch / sitemap / --demo / --help`);
  }
}

try {
  const code = await main();
  process.exit(code);
} catch (e) {
  const parsed = (() => { try { return parseArgs(process.argv.slice(2)); } catch { return {}; } })();
  const message = e && e.message ? e.message : String(e);
  if (parsed.json) jsonOut({ ok: false, tool: TOOL, error: message });
  else process.stderr.write(`\n  ❌ ${message}\n\n`);
  process.exit(e && e.exitCode ? e.exitCode : 2);
}
