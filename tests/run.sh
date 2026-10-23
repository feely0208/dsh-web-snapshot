#!/bin/bash
# @deepwhale-cn/dsh-web-snapshot · 双向验证
# 全部离线：用 `node -e` 起一个临时本地 HTTP server（127.0.0.1 随机端口），
# 断言 标题/正文/来源/抓取时间、去导航/页脚/脚本、批量失败不中断、协议拒绝、超时、5MB 上限、sitemap。
set -uo pipefail
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
cd "$(dirname "$0")/.."
ROOT=$(pwd)
PASS=0; FAIL=0
ok(){ echo "  ✅ $1"; PASS=$((PASS+1)); }
bad(){ echo "  ❌ $1"; FAIL=$((FAIL+1)); }
TMP=$(mktemp -d)
SRV=""
cleanup(){ { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null && wait "$SRV" 2>/dev/null; } ; rm -rf "$TMP"; }
trap cleanup EXIT

json_get(){
  python3 -c '
import json,sys
d=json.load(sys.stdin)
for k in sys.argv[1].split("."):
    d=d[int(k)] if isinstance(d,list) else d[k]
print(d)
' "$1"
}

echo ""
echo "  @deepwhale-cn/dsh-web-snapshot · 双向验证（离线本地 server）"
echo "  ────────────────────────────────────────────────"

PORT=$(( 21000 + RANDOM % 20000 ))
BASE="http://127.0.0.1:$PORT"
node -e '
const http = require("node:http");
const port = Number(process.argv[1]);
const server = http.createServer((req, res) => {
  const path = new URL(req.url, "http://127.0.0.1").pathname;
  const base = "http://127.0.0.1:" + port;
  const page = (body, type) => { res.writeHead(200, {"content-type": type || "text/html; charset=utf-8"}); res.end(body); };
  if (path === "/" || path === "/index.html") {
    page("<!doctype html><html><head><title>本地测试页</title><meta name=\"description\" content=\"演示摘要不该缺席\"></head><body><nav>导航栏文字</nav><header>页头</header><main><article><h1>正文大标题</h1><p>这是正文第一段，用于断言正文提取成功。</p><p>第二段带 <a href=\"/about\">关于链接</a>，以及 <strong>加粗文字</strong>。</p><ul><li>列表条目一</li><li>列表条目二</li></ul></article></main><script>var secretTracker = \"脚本内容不该出现\";</script><footer>页脚文字</footer></body></html>");
  } else if (path === "/about") {
    page("<!doctype html><html><head><title>关于页</title></head><body><article><p>关于页正文内容。</p></article></body></html>");
  } else if (path === "/sitemap.xml") {
    page("<?xml version=\"1.0\" encoding=\"UTF-8\"?><urlset><url><loc>" + base + "/</loc></url><url><loc>" + base + "/about</loc></url></urlset>", "application/xml");
  } else if (path === "/index.xml") {
    page("<?xml version=\"1.0\"?><sitemapindex><sitemap><loc>" + base + "/sitemap.xml</loc></sitemap></sitemapindex>", "application/xml");
  } else if (path === "/slow") {
    setTimeout(() => page("<html><head><title>slow</title></head><body>慢响应</body></html>"), 3000);
  } else if (path === "/big") {
    page("<html><head><title>big</title></head><body>" + "x".repeat(6 * 1024 * 1024) + "</body></html>");
  } else if (path === "/not-html") {
    res.writeHead(200, {"content-type": "application/pdf"});
    res.end("%PDF-1.4 fake");
  } else {
    res.writeHead(404, {"content-type": "text/plain"});
    res.end("not found");
  }
});
server.listen(port, "127.0.0.1", () => console.log("ready"));
' "$PORT" > "$TMP/server.log" 2>&1 &
SRV=$!
READY=0
for _ in $(seq 1 50); do
  if node -e 'fetch(process.argv[1]).then(()=>process.exit(0)).catch(()=>process.exit(1))' "$BASE/" 2>/dev/null; then READY=1; break; fi
  sleep 0.1
done
if [ "$READY" != "1" ]; then
  echo "  ❌ 本地测试 server 没起来"; cat "$TMP/server.log"; exit 1
fi

echo ""; echo "  【门 0】CLI 基本形态"
node bin/cli.mjs --help >/dev/null 2>&1 && ok "--help 退出 0" || bad "--help 失败"
node bin/cli.mjs >/dev/null 2>&1 && ok "无参数打印帮助且退出 0" || bad "无参数未退出 0"
node bin/cli.mjs bogus-cmd >/dev/null 2>&1; [ $? -eq 2 ] && ok "未知子命令退出 2" || bad "未知子命令退出码不对"
node -e "import('./lib/index.js').then(m=>process.exit(m.name&&m.inject&&m.apply?0:1))" 2>/dev/null \
  && ok "lib/index.js 导出 name/inject/apply" || bad "lib/index.js 导出不完整"

echo ""; echo "  【--demo】自造样例（本地 server）"
node bin/cli.mjs --demo >/dev/null 2>&1 && ok "--demo 退出 0" || bad "--demo 失败"
node bin/cli.mjs --demo --json > "$TMP/demo.json" 2>/dev/null
DEMO_OUT=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["out"])' "$TMP/demo.json" 2>/dev/null)
[ -n "${DEMO_OUT:-}" ] && [ -f "$DEMO_OUT/demo-page.md" ] && ok "--demo 打印并写出产物" || bad "--demo 产物缺失"
python3 - "$DEMO_OUT/demo-result.json" <<'PY' && ok "demo 自检全通过（标题/正文/去导航/去页脚/去脚本/链接/批量/sitemap）" || bad "demo 自检未全通过"
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
raise SystemExit(0 if all(d["checks"].values()) else 1)
PY

echo ""; echo "  【url】单页抓取：标题 / 正文 / 来源 / 抓取时间"
U=$(node bin/cli.mjs url "$BASE/" --out "$TMP/single" --json 2>/dev/null); RC=$?
[ "$RC" = 0 ] && ok "url 抓取退出 0" || bad "url 抓取退出 $RC"
OUT=$(echo "$U" | json_get out 2>/dev/null)
[ -n "${OUT:-}" ] && [ -f "$OUT" ] && ok "生成 Markdown 文件" || bad "未生成 Markdown"
grep -q "^# 本地测试页" "$OUT" && ok "含页面标题" || bad "缺标题"
grep -q "这是正文第一段" "$OUT" && ok "含正文段落" || bad "缺正文"
grep -qF "来源：$BASE/" "$OUT" && ok "含来源 URL" || bad "缺来源"
grep -q "抓取时间：" "$OUT" && ok "含抓取时间" || bad "缺抓取时间"
grep -q "导航栏文字" "$OUT" && bad "nav 未去除" || ok "nav 已去除"
grep -q "页脚文字" "$OUT" && bad "footer 未去除" || ok "footer 已去除"
grep -q "脚本内容不该出现" "$OUT" && bad "script 未去除" || ok "script 已去除"
grep -qF "[关于链接]($BASE/about)" "$OUT" && ok "相对链接已转绝对" || bad "相对链接未转绝对"
grep -q "加粗文字" "$OUT" && ok "保留行内强调" || bad "行内强调丢失"

# 覆盖同名文件前先备份
node bin/cli.mjs url "$BASE/" --out "$TMP/single" --json > "$TMP/single2.json" 2>/dev/null
BU=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1])).get("backup") or "")' "$TMP/single2.json")
[ -n "$BU" ] && [ -f "$BU" ] && ok "覆盖前备份 .bak" || bad "未备份原文件"

echo ""; echo "  【安全边界】协议 / 超时 / 响应大小"
node bin/cli.mjs url "file:///etc/passwd" --json > "$TMP/proto.json" 2>/dev/null; RC=$?
[ "$RC" -ne 0 ] && ok "file:// 被拒（退出 $RC）" || bad "file:// 未被拒"
grep -q "只允许 http/https" "$TMP/proto.json" && ok "拒绝原因说清协议" || bad "拒绝原因不明确"
node bin/cli.mjs url "$BASE/slow" --timeout 300 --json > "$TMP/slow.json" 2>/dev/null; RC=$?
[ "$RC" -ne 0 ] && ok "超时非 0 退出" || bad "超时未失败"
grep -q "请求超时" "$TMP/slow.json" && ok "超时原因说清（300ms）" || bad "超时信息缺失"
node bin/cli.mjs url "$BASE/big" --json > "$TMP/big.json" 2>/dev/null; RC=$?
[ "$RC" -ne 0 ] && ok "6MB 响应被中止" || bad "超大响应未中止"
grep -q "5 MB" "$TMP/big.json" && ok "大小上限信息明确" || bad "大小上限信息缺失"
node bin/cli.mjs url "$BASE/not-html" --json > "$TMP/pdf.json" 2>/dev/null; RC=$?
[ "$RC" -ne 0 ] && ok "非 HTML 页面被拒" || bad "非 HTML 页面被当正文"

echo ""; echo "  【batch】逐条失败不中断 + 汇总"
printf '%s\n%s\n%s\n' "$BASE/" "$BASE/missing" "file:///etc/passwd" > "$TMP/urls.txt"
node bin/cli.mjs batch --input "$TMP/urls.txt" --out "$TMP/batch" --json > "$TMP/batch.json" 2>/dev/null; RC=$?
[ "$RC" = 1 ] && ok "有失败时退出 1" || bad "batch 退出 $RC（期望 1）"
BT=$(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d["total"],d["okCount"],d["failedCount"])' "$TMP/batch.json")
[ "$BT" = "3 1 2" ] && ok "汇总：total 3 / ok 1 / failed 2" || bad "汇总不对：$BT"
NMD=$(find "$TMP/batch" -name '*.md' 2>/dev/null | wc -l | tr -d ' ')
[ "${NMD:-0}" -ge 1 ] && ok "成功条目产物已保留（$NMD 个 .md）" || bad "成功条目产物丢失"
grep -q "HTTP 404" "$TMP/batch.json" && ok "404 作为单条失败记录" || bad "404 未记录"
grep -q "只允许 http/https" "$TMP/batch.json" && ok "非 http 条目单条失败" || bad "非 http 条目未记录"
printf '%s\n%s\n' "$BASE/" "$BASE/about" > "$TMP/ok.txt"
node bin/cli.mjs batch --input "$TMP/ok.txt" --out "$TMP/batch-ok" --json >/dev/null 2>&1; [ $? -eq 0 ] && ok "全部成功时退出 0" || bad "全成功 batch 退出非 0"

echo ""; echo "  【sitemap】读取 / sitemapindex / --limit / 本地文件"
SM=$(node bin/cli.mjs sitemap "$BASE/sitemap.xml" --json 2>/dev/null)
[ "$(echo "$SM" | json_get count)" = "2" ] && ok "sitemap 列出 2 个 URL" || bad "sitemap 数量不对"
SML=$(node bin/cli.mjs sitemap "$BASE/sitemap.xml" --limit 1 --json 2>/dev/null)
[ "$(echo "$SML" | json_get count)" = "1" ] && ok "--limit 1 生效" || bad "--limit 未生效"
IDX=$(node bin/cli.mjs sitemap "$BASE/index.xml" --json 2>/dev/null)
[ "$(echo "$IDX" | json_get isSitemapIndex)" = "True" ] && ok "识别 sitemapindex" || bad "未识别 sitemapindex"
[ "$(echo "$IDX" | json_get count)" = "2" ] && ok "sitemapindex 展开子 sitemap（2 条）" || bad "sitemapindex 展开失败"
printf '<?xml version="1.0"?><urlset><url><loc>%s/</loc></url><url><loc>%s/about</loc></url></urlset>\n' "$BASE" "$BASE" > "$TMP/local-sitemap.xml"
LF=$(node bin/cli.mjs sitemap --input "$TMP/local-sitemap.xml" --json 2>/dev/null)
[ "$(echo "$LF" | json_get count)" = "2" ] && ok "支持本地 sitemap.xml" || bad "本地 sitemap 失败"
node bin/cli.mjs sitemap "$BASE/sitemap.xml" --out "$TMP/sm" --json > "$TMP/sm.json" 2>/dev/null
[ -f "$TMP/sm/sitemap-urls.txt" ] && ok "--out 写出 URL 列表" || bad "--out 未写 URL 列表"
node bin/cli.mjs sitemap "file:///etc/passwd" --json > "$TMP/smproto.json" 2>/dev/null; RC=$?
[ "$RC" -ne 0 ] && ok "sitemap 也拒绝 file://" || bad "sitemap 未拒绝 file://"

echo ""; echo "  ────────────────────────────────────────────────"
if [ "$FAIL" -eq 0 ]; then
  echo "  ✅ 全过（$PASS 项）"; echo ""
  exit 0
else
  echo "  ❌ 失败 $FAIL 项 · 通过 $PASS 项"; echo ""
  exit 1
fi
