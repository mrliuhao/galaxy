#!/usr/bin/env node
// 活页 · 本地上传助手（零依赖，Node ≥ 20）。二进制不经 LLM 上下文、不经 MCP JSON —— 直传对象存储。
//
//   node space-cli.mjs push <dir|file.pdf|file.pptx|file.md> --token sk-space-… --proposal <id> [--manifest m.json] [--note "…"] [--base URL] [--hold] [--quiet] [--tag <名> [--tag-title "…"] [--tag-note "…"]]
//   （--quiet = 这一版上线不提醒任何人：工作区的人与订阅这一页的读者都不收，同 MCP 的 quiet；小改 / 刷新数据用）
//   （不传 --manifest 时读包根 manifest.json —— 包里写的 images:"keep" / share / reader 照样生效，这个文件本身不上传）
//   （V2：push 过审即自动生效、客户链接自动指向新版；--hold = 本版先不切给客户，确认后 publish 切换）
//                          [--migrate-ai-site [--cdn-hosts static-cdn.24haowan.com]]   ← P3-e：ai-site 方案目录原样搬来
//   node space-cli.mjs downloads --version <id> [--config downloads.json --revision <n>]
//   push --downloads downloads.json：显式配置下载；省略则沿用当前版，首版默认无下载。
//   node space-cli.mjs publish --token … --version <id> [--note "…"] [--tag <名> [--tag-title "…"]]
//   node space-cli.mjs pull    --proposal <id> --out <空目录> [--version <id>] [--manifest-out m.json]
//   （原样取回某一版 —— 默认当前生效版 —— 的全部文件 + manifest.json；本地没有源文件时，改完再 push --manifest）
//   node space-cli.mjs share   --token … --proposal <id> --name 李总 [--title 采购总监] [--days 30] [--passcode 1234] [--no-download] [--no-comment]
//   node space-cli.mjs data pull   --proposal <id> --out <目录> [--table <name>] [--json]        ← 数据表（#7622）：每张表一个 <name>.csv（--json 则 .json）
//   node space-cli.mjs data push   <file.csv|file.json> --proposal <id> --table <name> [--revision <n>]
//   JSON 对象可带 append_open、identity、identity_visibility、per_reader、vote_key；配置文件可不带 rows（只改设置）。
//   例：{"identity":"wechat","per_reader":"one","append_open":true}，已有表仍需 --revision。
//   per_reader: off（默认）/ one（重复 409）/ latest（页面每人最新，历史留给作者）/ vote（配 vote_key=列名：每人每个值一票，再投 409，撤回后可重投）。
//   需要 identity=wechat 或 wechat_optional；匿名行不受限制，成员按 user id，撤回仍占 one 名额。
//   identity_visibility 默认 all；隐私场景保持 identity=off。serve 本地预览不模拟微信身份与去重，验证走服务端。
//   node space-cli.mjs data delete --proposal <id> --table <name> --revision <n>
//   node space-cli.mjs app help     ← 应用声明、上传封存、发布任务、状态/取消及归档恢复（JSON 输出；需独立试点授权）
//   （数据表挂在**方案**上、不随版本：push 一版页面不动表、改一张表不用重发页面，`push --hold` 与表无关。
//    每张表有修订号：新建 --revision 0（缺省），改已有的表必须带 data pull 看到的那个修订号，撞版会被拒、不覆盖别人的改动。）
//
//   node space-cli.mjs quick <file|dir> [--title "…"] [--no-share] [--base URL]     ← 不登录发一份（#11310）：HTML / Markdown / PDF / PPTX / 图片，
//   node space-cli.mjs quick <管理链接> [--share]                                      最多 50 个文件共 20 MB；过审即分享（--no-share 只传不分享），
//   （不要 token。打印预览 / 分享 / 认领三条链接；7 天后失效、读者 50 台上限；要保留 → 打开认领链接登录。第二种形态查状态 / 补分享。）
//
//   node space-cli.mjs serve <目录> [--port 8787] [--closed 表1,表2] [--manifest m.json]     ← 本地先看线上效果（#8657）：与内容域同一份 CSP，
//   （`fetch('./_data/<表>.json')` 读目录里的文件、`POST ./_data/<表>`（JSON 或普通表单）追加进去；--closed 模拟没开写回的表；
//    --manifest 与 push 同一份，`kind:"deck"` 时与线上一样加载平台 deck 引擎（从 --base 取一次）。不要 token）
//
//   node space-cli.mjs watch <proposal_id> [--kinds row,thread] [--since <游标>] [--once]   ← 挂着等页面新反馈（PPH0）：
//   （一条反馈打一行 JSON 到 stdout：{"type":"ready"…} / {"type":"event",id,kind,…} / {"type":"reconnect"…}；断线自动重连
//    并从上次的位置接着读 —— 游标存在 ~/.space/watch/<proposal_id>.cursor；--once = 拿到第一批就退出 0（给只想等一次的 Agent）。
//    凭据同 push：SPACE_TOKEN / --token）
//
// 环境变量 SPACE_TOKEN / SPACE_BASE 可代替 --token / --base。默认 base = https://space.24haowan.com
import { createHash } from "node:crypto";
import { readFileSync, statSync, readdirSync, existsSync, mkdirSync, writeFileSync, realpathSync, openSync, closeSync, fstatSync, readSync, constants } from "node:fs";
import { join, relative, basename, extname, resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── P3-e 迁移转换（可 import 测试；`--migrate-ai-site` 时对包内文本文件逐个应用）──────────────────────
// 1. 剥 Service Worker 注册（沙箱 opaque origin 里本来注册不了，留着只会报错）；sw.js / workbox-*.js 文件整个丢弃；
// 2. 剥 ai-site 的 /track.js 标签（space 出流时注入自己的 SDK；这条在包里只会 404）与 GA 装载；
// 3. 外域静态资源（默认 static-cdn.24haowan.com）下载进包 `_cdn/<hash>-<basename>` 并把引用改成相对路径 —— 写这条时校验规则
//    html_external_script 与内容 CSP 都不允许包引用外域；#8660 起内容域默认放开外域，这一步只剩「页面不依赖外网」的好处，不再是唯一通路。
export const stripServiceWorker = (src) => src
  .replace(/navigator\.serviceWorker\s*\.\s*register\s*\([^;]*?\)\s*(?:\.then\([\s\S]*?\))?\s*(?:\.catch\([\s\S]*?\))?\s*;?/g, "/* sw stripped */")
  .replace(/if\s*\(\s*['"]serviceWorker['"]\s+in\s+navigator\s*\)\s*\{[\s\S]*?navigator\.serviceWorker[\s\S]*?\}/g, "/* sw stripped */")
  .replace(/navigator\.serviceWorker/g, "undefined/*sw*/");
export const stripAiSiteTracking = (html) => html
  .replace(/<script\b[^>]*\bsrc\s*=\s*["']\/track\.js(?:\?[^"']*)?["'][^>]*>\s*<\/script>/gi, "")
  .replace(/<script\b[^>]*\bsrc\s*=\s*["']\/ga\/js[^"']*["'][^>]*>\s*<\/script>/gi, "");
// ── 包根 manifest.json（读者端减法 C8 · M8）：没传 `--manifest` 时，包根那份就是这一版的 manifest ─────────────
// 以前这里只认 `--manifest`：包根的 manifest.json 被当成普通文件**一起上传**，manifest 里写的 `images:"keep"`
// 一个字都没生效 —— 设计稿 v2–v6 的图因此被平台缩到长边 1600、在电脑上糊掉，而回执里没有任何一句话说「你的 manifest 没被读」。
// `pull` 默认就把 manifest.json 写进包根，所以「pull → 改 → push」不带 --manifest 本来就该读它。
// ★ 同名的 PWA 清单（`start_url` / `icons` / `display`）不是我们的 manifest：认不出就照旧当文件传，并说一句。
export const PACKAGE_MANIFEST = "manifest.json";
const PWA_KEYS = ["start_url", "icons", "display", "short_name", "background_color", "theme_color", "scope"];
const SPACE_KEYS = ["title", "entry", "kind", "images", "share", "reader", "sections", "notes", "scene", "theme", "theme_switch", "render", "downloads", "actions", "chrome", "lang", "mobileEntry", "note", "demos", "cta", "customer"];
/** 认得出是活页 manifest ⇒ 返回对象；否则 null（PWA 清单、不是对象、一个我们的键都没有）。 */
export const asPackageManifest = (raw) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (PWA_KEYS.some((k) => k in raw)) return null;
  return SPACE_KEYS.some((k) => k in raw) ? raw : null;
};
export const isSwFile = (rel) => /(^|\/)(sw|service-worker|workbox-[\w.-]+)\.js$/i.test(rel);

// ── 讲稿剥离（deck presenter）：**不是迁移特例，每次 push 都做** ────────────────────────
// 作者把讲稿写在 slide 上（`data-speaker-notes`，ai-site 沿用下来的写法，不用改一个字），
// push 时从包里**剥出来**放进 manifest.notes[]，由平台只对发布者会话渲染。
//
// ★ 为什么必须剥而不是留在包里：客户拿到的是包的字节，View Source 就全读到了
//   ——「初次接触不给价」这类现场话术、砍页理由、内部提词。前端加个密码框不是闸，是贴纸。
// ★ 为什么不做成 `--migrate-ai-site` 的一条：服务端那道 `html_speaker_notes` 是**拒收**，
//   只在迁移时剥的话，正常 push 一份带讲稿的 deck 会被打回，而 agent 没有理由知道要加那个 flag。
// ★ 服务端仍然有闸：剥漏了、或有人绕开本 CLI 手传，都当场红。这条的失效方向是**泄露**，
//   而泄露没有人会来告诉你（客户不会说他查了源码），所以不能只靠本文件老实。
export const NOTES_ATTR = "data-speaker-notes";
const ANCHOR_ATTRS = ["id", "data-label", "data-screen-label"];
const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s) => s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/g, (raw, body) => {
  if (body[0] === "#") {
    const n = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : raw;
  }
  const k = body.toLowerCase();
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, k) ? NAMED_ENTITIES[k] : raw;
});

/**
 * 解析 html[start]（必须指向 `<`）处的**开始标签**，返回属性表与标签结束位置。
 * 自己写而不是用 `<[^>]*>`：讲稿里出现 `>` 是常事（「小票 > 抽奖券」），
 * 那个朴素正则会在属性值中间截断 —— 表现是剥完剩半个标签、页面结构塌掉。
 */
const parseTagAt = (html, start) => {
  let i = start + 1;
  const nameFrom = i;
  while (i < html.length && /[\w:-]/.test(html[i])) i++;
  if (i === nameFrom) return null;
  const attrs = [];
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i])) i++;
    if (i >= html.length) return null;
    if (html[i] === ">") return { end: i + 1, attrs };
    if (html[i] === "/" && html[i + 1] === ">") return { end: i + 2, attrs };
    const from = i;
    while (i < html.length && !/[\s=>/]/.test(html[i])) i++;
    const name = html.slice(from, i).toLowerCase();
    if (!name) { i++; continue; }            // 防死循环（畸形输入）
    let value = null, end = i, j = i;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] === "=") {
      j++;
      while (j < html.length && /\s/.test(html[j])) j++;
      const q = html[j];
      if (q === '"' || q === "'") {
        const close = html.indexOf(q, j + 1);
        if (close < 0) return null;          // 引号没闭合：整份不动，交给服务端的闸去红
        value = html.slice(j + 1, close);
        end = close + 1;
      } else {
        const vs = j;
        while (j < html.length && !/[\s>]/.test(html[j])) j++;
        value = html.slice(vs, j);
        end = j;
      }
      i = end;
    }
    attrs.push({ name, value, from, end });
  }
  return null;
};

/**
 * 从一份 HTML 里剥出讲稿。
 * @returns `{ notes: [{anchor, text}], html }` —— notes 按 DOM 顺序；html 是剥掉那些属性之后的原文。
 * **没有讲稿时 html 逐字节等于输入**（不重排属性、不改引号）——否则每次 push 都会生成一份新 sha256。
 */
export const extractSpeakerNotes = (html) => {
  const notes = [];
  const cuts = [];
  const re = /<[a-zA-Z]/g;
  let m;
  while ((m = re.exec(html))) {
    const tag = parseTagAt(html, m.index);
    if (!tag) continue;
    re.lastIndex = tag.end;                  // 跳过整个标签：属性值里的 `<` 不该被当成新标签
    const a = tag.attrs.find((x) => x.name === NOTES_ATTR);
    if (!a || a.value === null) continue;
    let cutFrom = a.from;
    while (cutFrom > 0 && /\s/.test(html[cutFrom - 1])) cutFrom--;
    cuts.push([cutFrom, a.end]);
    const text = decodeEntities(a.value).trim();
    if (!text) continue;                     // 空讲稿不算一条，否则 presenter 上是一页空白
    const anchorAttr = ANCHOR_ATTRS.map((n) => tag.attrs.find((x) => x.name === n)).find((x) => x && x.value);
    notes.push({ anchor: anchorAttr ? decodeEntities(anchorAttr.value) : null, text });
  }
  if (!cuts.length) return { notes, html };
  let out = "", at = 0;
  for (const [from, to] of cuts) { out += html.slice(at, from); at = to; }
  return { notes, html: out + html.slice(at) };
};

/** 找外域引用：返回去重后的绝对 URL 列表（只认 https 且 host 在白名单）。 */
export const findCdnRefs = (text, hosts) => {
  const out = new Set();
  const re = /https?:\/\/([a-z0-9.-]+)(\/[^\s"'()<>]*)?/gi;
  let m;
  while ((m = re.exec(text))) {
    if (!hosts.includes(m[1].toLowerCase())) continue;
    const url = m[0].replace(/[),;]+$/, "");
    // 只收「像文件」的引用（末段带扩展名）：`base + '/' + name` 这种拼接前缀不是资源，下载必 404
    if (!/\.[a-z0-9]{1,5}(?:[?#]|$)/i.test(url.split("/").pop() || "")) continue;
    out.add(url);
  }
  return [...out];
};
/** 把外域 URL 改写成相对路径（包根 `_cdn/`）；depth = 该文件在包内的目录深度，用于 ../ 前缀。 */
export const rewriteCdnRefs = (text, map, depth) => {
  const prefix = "../".repeat(depth);
  let out = text;
  for (const [url, rel] of map) out = out.split(url).join(prefix + rel);
  return out;
};
/** 外域 URL 的路径后缀若已在包里（ai-site 把 assets/engine 同步到 CDN 又本地保留），直接改指本地文件，不下载。取最长匹配后缀。 */
export const localForCdn = (url, packagePaths) => {
  const segs = new URL(url).pathname.split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) { const cand = segs.slice(i).join("/"); if (packagePaths.has(cand)) return cand; }
  return null;
};
export const cdnLocalName = (url) => `_cdn/${createHash("sha256").update(url).digest("hex").slice(0, 10)}-${(basename(new URL(url).pathname) || "asset").replace(/[^\w.-]/g, "_")}`;

// 版本握手：服务端从它自己发出的本文件里正则抽取这行（app.ts cliLatestVersion），响应头回
// x-space-cli-latest / x-space-cli-min —— 过旧提示重新 curl，低于 min 直接停（防静默用坏协议）。
export const CLI_VERSION = 14;
let versionWarned = false;

// ── serve：本地起一个与内容域同规则的小服务器（#8657，EPIC #8653 C6）────────────────────────────
// 让 Agent 发之前在自己电脑上先看线上效果：静态文件原样；`GET ./_data/<表>.json` 读目录里的文件；
// `POST ./_data/<表>` 追加到那个文件；HTML 带与线上**逐字相同**的 CSP，并加线上那一行 `/_space/sdk.js`（本地版，埋点打到控制台）。
// 零依赖（node:http）、不要 token、不连服务端。
//
// ★ 下面三个常量是 `src/viewer/serve.ts` 的 `contentHtmlCsp`、`src/viewer/sandbox.ts` 的 `CONTENT_PACKAGE_SANDBOX`、
//   `src/data/tables.ts` 的 `TABLE_NAME` 的**抄本** —— 本文件是单文件分发（curl 下来就能跑），import 不了服务端 TS。
//   `src/viewer/local-serve.test.ts` 逐字断言两边相等：线上改了 CSP 而这里没跟，当场红（这正是「本地什么样线上就什么样」的底）。
export const SERVE_SANDBOX = "allow-scripts allow-popups allow-forms allow-popups-to-escape-sandbox allow-downloads allow-same-origin allow-modals allow-top-navigation-by-user-activation allow-pointer-lock allow-orientation-lock allow-presentation";
export const serveHtmlCsp = (entryOrigin) =>
  `sandbox ${SERVE_SANDBOX}; default-src 'self' https: data: blob:; script-src 'self' https: blob: 'unsafe-inline' 'unsafe-eval'; worker-src 'self' https: blob:; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:; media-src 'self' https: data: blob:; connect-src 'self' https: wss: data: blob:; frame-src 'self' https:; frame-ancestors 'self' ${entryOrigin}; form-action 'self' https:; base-uri 'self'`;
export const SERVE_TABLE_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * `/_space/sdk.js` 的本地版：接口形状与线上 SDK 相同（`space.data.get/append`、`space.submit/cta`、`window.__track`、
 * `form[data-space-form]`），但不经壳页 —— 数据直接读写本地 `_data/`，埋点只 `console.info('[space] …')`。
 * 线上的阅读统计、回放、目录胶囊依赖壳页，本地没有，不模拟。
 * `data-deck`（manifest `kind:"deck"` 且页里有 `<deck-stage>`）⇒ 与线上引导段同样加载平台 deck 引擎 + 外观（#8658 对比检查量出：
 * 本地不加载时一份演示稿三页平铺，线上一次一页）。两份引擎文件由 serve 从 --base 取一次缓存（线上改引擎，本地自动跟上）。
 */
// 外链开新窗口 / 包内下载的点击委托：线上 `src/viewer/external-links.ts` 的 LINK_DELEGATE_JS 的**抄本**（逐字，local-serve.test.ts 锁步）。
// #8658 对比检查量出：本地没有它时，点站外链接是本页跳走，线上是开新窗口；`<a download>` 线上补 `?space_dl=` 走 attachment。
export const SERVE_LINK_DELEGATE_JS = String.raw`(function(){
function nearA(n){while(n&&n.nodeType===1){if(String(n.tagName).toUpperCase()==='A'&&n.hasAttribute('href'))return n;n=n.parentNode;}return null;}
function dl(a,h){var v=String(h).trim();if(!v||/^(?:[a-z][a-z0-9+.-]*:|\/|#)/i.test(v)||/[?&]space_dl=/.test(v))return false;
var i=h.indexOf('#'),path=i<0?h:h.slice(0,i),hash=i<0?'':h.slice(i),base='download';
try{base=decodeURIComponent(path.split('?')[0].split('/').pop()||'download');}catch(x){}
var name=String(a.getAttribute('download')||'').trim()||base;
a.setAttribute('href',path+(path.indexOf('?')>=0?'&':'?')+'space_dl='+encodeURIComponent(name)+hash);return true;}
function imageNav(a,h){var p=new URL(location.href),u=new URL(h,document.baseURI||p.href),b=p.pathname.match(/^\/v\/[^/]+\/(?:~[^/]+\/)?/);
if(!/^(?!_self$).+/i.test(a.getAttribute('target')||'')&&b&&u.href.indexOf(p.origin+b[0])===0&&/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/i.test(u.pathname)){u.searchParams.set('space_frame',1);a.setAttribute('href',u.href);}}
function hu(h){var v=String(h).trim();if(!/^(?:https?:)?\/\//i.test(v))return 0;try{return new URL(v.indexOf('//')===0?'https:'+v:v);}catch(x){return 0;}}
document.addEventListener('click',function(e){try{var a=nearA(e&&e.target);if(!a)return;var h=a.getAttribute('href')||'';
if(a.hasAttribute('download')){if(dl(a,h))return;}else imageNav(a,h);
if(a.hasAttribute('target'))return;
var top=false;try{top=!!window.__spaceTop&&String(location.origin)!=='null';}catch(x){}
var u=hu(h),o=u&&String(u.host).toLowerCase()===String(location.host).toLowerCase();
if(!u||o){if(o&&top&&!/^\/(?:v\/|_)/.test(u.pathname))a.setAttribute('target','_top');return;}
var rel=String(a.getAttribute('rel')||'').split(/\s+/).filter(function(t){return !!t;}),low=rel.join(' ').toLowerCase().split(' ');
["noopener","noreferrer"].forEach(function(t){if(low.indexOf(t)<0)rel.push(t);});
a.setAttribute('target',top?'_top':'_blank');a.setAttribute('rel',rel.join(' '));
}catch(x){}},true);
})();`;
/** `?space_dl=<名>` ⇒ attachment（线上 serve.ts attachmentHeader 的抄本，锁步同上）。 */
export const serveAttachmentHeader = (requested, rel) => {
  const fallback = rel.split("/").pop() || "download";
  const clean = requested.replace(/[\u0000-\u001f\u007f/\\]/g, "").trim().slice(0, 180) || fallback;
  const ext = /\.[a-z0-9]{1,8}$/i.exec(fallback)?.[0] ?? "";
  const name = ext && !clean.toLowerCase().endsWith(ext.toLowerCase()) ? `${clean}${ext}` : clean;
  return `attachment; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`;
};
// 与线上 `DECK_STAGE_URL` 锁步（local-serve.test.ts）：v = deck-stage.js 内容 sha256 前 10 位（KYRP 起由版本号整数改为内容哈希）。
export const SERVE_DECK_STAGE_URL = "/static/deck/deck-stage.js?v=d5928291a8";
export const SERVE_DECK_CHROME_PATH = "/_space/deck-chrome.js";
export const LOCAL_SDK_JS = `(function(){
if(window.__spaceBoot)return;window.__spaceBoot=1;window.__spaceTop=1;
var S=document.currentScript;
function load(src){try{var s=document.createElement('script');s.src=src;s.async=false;(document.head||document.documentElement).appendChild(s);}catch(e){}}
if(S&&S.getAttribute('data-deck')!==null){var dk=function(){load('${SERVE_DECK_STAGE_URL}');load('${SERVE_DECK_CHROME_PATH}');};if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',dk);else dk();}
function log(t,m){try{console.info('[space] '+t,m===undefined?'':m);}catch(e){}}
function derr(code,msg,status){var e=new Error(msg||code);e.code=code;if(status)e.status=status;return e;}
function fail(r,j){var er=(j&&j.error)||{};throw derr(String(er.code||'http_'+r.status),String(er.message||''),r.status);}
function cols(rows){var s={},o=[];(rows||[]).forEach(function(r){if(r&&typeof r==='object')Object.keys(r).forEach(function(k){if(!s[k]){s[k]=1;o.push(k);}});});return o;}
function dget(table){return fetch('/_data/'+encodeURIComponent(String(table==null?'':table))+'.json',{cache:'no-store'}).then(function(r){return r.json().catch(function(){return null;}).then(function(j){
  if(r.status===404)throw derr('table_not_found','这份内容没有这张表',404);if(!r.ok)fail(r,j);
  var rows=Array.isArray(j)?j:(j&&Array.isArray(j.rows)?j.rows:[]);
  return {table:String(table),revision:Number(r.headers.get('X-Space-Revision'))||0,columns:(j&&Array.isArray(j.columns))?j.columns:cols(rows),rows:rows,dataRevision:0};});});}
function dappend(table,row){return fetch('/_data/'+encodeURIComponent(String(table==null?'':table)),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify((row&&typeof row==='object'&&!Array.isArray(row))?row:{})}).then(function(r){return r.json().catch(function(){return null;}).then(function(j){
  if(!r.ok)fail(r,j);log('data_append',{table:table,row:row});return {rowId:String(j.id||''),status:String(j.status||''),dataRevision:0,message:''};});});}
window.__track={slide:function(i,label,total,anchor){log('page',{index:i,label:label,total:total,anchor:anchor});},event:function(name,meta){log('cta',{name:name,data:meta});}};
window.space={submit:function(fields){log('form',fields||{});},cta:function(name){log('cta',{name:name});},link:(window.__space&&window.__space.link)||{params:{}},page:{id:'local'},data:{get:dget,append:dappend}};
try{document.addEventListener('submit',function(e){var f=e.target;if(!f||!f.matches||!f.matches('form[data-space-form]'))return;e.preventDefault();
  var o={};try{new FormData(f).forEach(function(v,k){if(typeof v==='string')o[k]=v.slice(0,500);});}catch(x){}
  window.space.submit(o);var d=document.createElement('div');d.setAttribute('data-space-form-result','ok');d.textContent=f.getAttribute('data-space-form-done')||'收到了。';f.replaceWith(d);},true);}catch(e){}
log('本地 SDK（space-cli serve）：数据读写走本地 _data/，埋点只打到控制台');
})();
${SERVE_LINK_DELEGATE_JS}`;

const SERVE_MIME = { html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", ico: "image/x-icon", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", pdf: "application/pdf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", csv: "text/csv; charset=utf-8", xml: "application/xml", wasm: "application/wasm", glb: "model/gltf-binary", gltf: "model/gltf+json" };
export const SDK_LINE = `<script data-space-sdk src="/_space/sdk.js"></script>`;
/**
 * 线上那一行加在哪、怎么加，这里就一样（sdk.ts 的 injectSdk 同口径，逐字）：紧跟 `<head…>` 且前面补一个换行，没有 head 就在
 * `<html…>` 之后，再没有就放最前并在后面补换行；已经有 `/_space/sdk.js` 的不再加。
 * #8658 对比检查量出来过：这里曾不补换行、且按 `data-space-sdk` 判重 —— 页面字节在两边差一个 `\n`，
 * 页面里只要提到 `data-space-sdk` 这几个字本地就不加 SDK。local-serve.test.ts 拿 injectSdk 逐字对。
 */
export const injectLocalSdk = (html, { deck = false } = {}) => {
  if (html.includes("/_space/sdk.js")) return html;
  const line = deck && /<deck-stage[\s>]/i.test(html) && !html.includes("data-space-deck") ? SDK_LINE.replace("></script>", " data-deck></script>") : SDK_LINE;
  const m = /<head\b[^>]*>/i.exec(html) ?? /<html\b[^>]*>/i.exec(html);
  if (!m) return `${line}\n${html}`;
  const cut = m.index + m[0].length;
  return `${html.slice(0, cut)}\n${line}${html.slice(cut)}`;
};

/** `_next` 只认本站相对路径（不以 `/`、`\`、scheme 开头）；越界即忽略，回来源页。 */
const safeNext = (next) => typeof next === "string" && next && !/^[\\/]|^[a-z][a-z0-9+.-]*:/i.test(next) && !next.includes("\\") ? next : null;

/**
 * 本地服务器的请求处理器（可 import 测试）。`root` = 包目录；`closed` = 模拟「没开写回」的表名集合（`--closed a,b`）。
 * 数据约定（EPIC #8653 共同约定 5）：读回行数组 + `X-Space-Revision`；写 JSON 回 `201 {id,status}`，表单回 `303` 到来源页并带
 * `?space_submitted=<表>`（`_next` 可覆盖）；表没开写回 ⇒ `403 append_closed`；只做追加。`_` 开头的表单字段不落库。
 */
export const createServeHandler = (root, { closed = new Set(), log = () => {}, manifest = {}, fetchAsset } = {}) => {
  // deck 引擎两份文件：默认从服务端取一次缓存（CLI 单文件分发，带不了引擎本体）；对比检查传本仓的同一份文件进来。
  const assetCache = new Map();
  const getAsset = fetchAsset ?? (async (p) => {
    const r = await fetch(`${BASE}${p}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  });
  const deck = manifest && manifest.kind === "deck";
  const base = resolve(root);
  const send = (res, status, headers, body) => { res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...headers }); res.end(body); };
  const json = (res, status, obj, extra = {}) => send(res, status, { "Content-Type": "application/json; charset=utf-8", ...extra }, JSON.stringify(obj));
  const err = (res, status, code, message, fix) => json(res, status, { error: { code, message, ...(fix ? { fix } : {}) } });
  // 普通表单的错误：读者在看的是整页 ⇒ 与线上（data/routes.ts 的 fail）同一页人话 + 回去的链接，不是一屏 JSON（#8658 量出）。
  const formErr = (res, status, code, message, fix, back) => {
    const esc = (v) => String(v).replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
    send(res, status, { "Content-Type": "text/html; charset=UTF-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'", "Referrer-Policy": "same-origin" },
      `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>没提交成功</title>`
      + `<body style="font:16px/1.6 system-ui,sans-serif;margin:2em 1.25em"><p><b>${esc(message)}</b></p>${fix ? `<p>${esc(fix)}</p>` : ""}<p data-space-error="${esc(code)}"><a href="${esc(back)}">返回</a></p>`);
  };
  const readBody = (req) => new Promise((ok, no) => { const cs = []; let n = 0; req.on("data", (c) => { n += c.length; if (n > 1 << 20) { no(new Error("too_large")); req.destroy(); } else cs.push(c); }); req.on("end", () => ok(Buffer.concat(cs).toString("utf8"))); req.on("error", no); });
  const loadTable = (file) => {
    const doc = JSON.parse(readFileSync(file, "utf8"));
    const rows = Array.isArray(doc) ? doc : doc && Array.isArray(doc.rows) ? doc.rows : null;
    if (!rows) throw new Error("not_rows");
    return { doc, rows };
  };
  // CW1M：线上读回给读者写回的行加 `_row_id` / `_at` / `_status` / `_mine`（本地只有你一个读者 ⇒ 这次 serve 里交的行都是你的）。
  //   这几键**不写进文件**（文件是底表样例，写进去 push 上线就成了底表的列）—— 记在内存里，读的时候按行号补上。
  const READBACK = new Set(["_author", "_row_id", "_at", "_status", "_mine", "_by"]);
  const appended = new Map(); // table → [{ row, id, at }]（row = 文件里那一行对象的同值副本，用来在重读后认回它）
  const sameRow = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const annotate = (table, rows) => {
    const marks = (appended.get(table) ?? []).slice();
    return rows.map((r) => {
      const k = marks.findIndex((m) => sameRow(m.row, r));
      if (k < 0) return r;
      const m = marks.splice(k, 1)[0];
      return { ...r, _row_id: m.id, _at: m.at, _status: "approved", _mine: true };
    });
  };
  return async (req, res) => {
    const origin = `http://${req.headers.host || "localhost"}`;
    let url;
    try { url = new URL(req.url || "/", origin); } catch { return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad path"); }
    let path;
    try { path = decodeURIComponent(url.pathname); } catch { return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad path"); }
    if (path.includes("..") || path.includes("\0")) return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad path");
    const method = req.method || "GET";

    if (path === "/_space/sdk.js") return send(res, 200, { "Content-Type": "text/javascript; charset=utf-8" }, LOCAL_SDK_JS);
    if (path === SERVE_DECK_STAGE_URL.split("?")[0] || path === SERVE_DECK_CHROME_PATH) {
      try {
        if (!assetCache.has(path)) assetCache.set(path, await getAsset(path === SERVE_DECK_CHROME_PATH ? path : SERVE_DECK_STAGE_URL));
        return send(res, 200, { "Content-Type": "text/javascript; charset=utf-8" }, assetCache.get(path));
      } catch (e) { return send(res, 502, { "Content-Type": "text/plain; charset=utf-8" }, `本地 serve 取不到平台 deck 引擎（${BASE}${path}：${e.message}）—— 需要联网`); }
    }

    // 数据：只认包根下的 `_data/`（线上 DATA_PATH 同口径 —— 子目录里的 `_data/` 就是普通文件）
    const dm = /^\/_data\/([^/]+?)(\.json)?$/.exec(path);
    // CW1M：撤回自己交的一行（线上 `DELETE ./_data/<表>/<row_id>` 同口径；本地 = 从文件里删掉这次 serve 里交的那一行）
    const wd = /^\/_data\/([^/.]+)\/([0-9A-Za-z_]{6,64})$/.exec(path);
    if (wd && method === "DELETE") {
      const [, table, id] = wd;
      const o = req.headers.origin, sfs = req.headers["sec-fetch-site"];
      if ((o && o !== origin && o !== "null") || (sfs && sfs !== "same-origin" && sfs !== "none")) return err(res, 403, "cross_origin", "只接受本页发出的提交");
      const file = join(base, "_data", `${table}.json`);
      const list = appended.get(table) ?? [];
      const k = list.findIndex((m) => m.id === id);
      if (!SERVE_TABLE_NAME.test(table) || !existsSync(file) || k < 0) return err(res, 404, "data_row_not_found", "找不到这一次提交", "只能撤回自己提交的那一行（本地：这次 serve 里交的）");
      let t;
      try { t = loadTable(file); } catch { return err(res, 500, "local_table_invalid", `_data/${table}.json 不是行数组`, "内容要是 [ {…}, … ]"); }
      const i = t.rows.findIndex((r) => sameRow(r, list[k].row));
      if (i >= 0) { t.rows.splice(i, 1); writeFileSync(file, JSON.stringify(t.doc, null, 2) + "\n"); }
      list.splice(k, 1);
      log(`- _data/${table}.json 撤回 ${id}`);
      return json(res, 200, { id, table, withdrawn: true, withdrawn_at: new Date().toISOString() });
    }
    if (dm && method === "POST" && !dm[2]) {
      const table = dm[1];
      const ct = String(req.headers["content-type"] || "");
      const isForm = /^application\/x-www-form-urlencoded\b/i.test(ct);
      // 303 回哪一页：同源 Referer（不是 _data 本身），拿不到回入口；`_next` 相对路径可覆盖，越界忽略（线上 formReturn 同口径）
      const formReturn = (next) => {
        const from = (() => { try { const r = new URL(String(req.headers.referer || ""), origin); return r.origin === origin && !r.pathname.startsWith("/_data/") ? r : null; } catch { return null; } })() ?? new URL(`/${String((manifest && manifest.entry) || "index.html").split("/").map(encodeURIComponent).join("/")}`, origin);
        let dest = from;
        if (safeNext(next)) { try { const n = new URL(next, from); if (n.origin === origin && !n.pathname.startsWith("/_data/")) dest = n; } catch { /* 越界即忽略 */ } }
        dest.searchParams.set("space_submitted", table);
        return dest.pathname + dest.search + dest.hash;
      };
      const fail = (status, code, message, fix) => isForm
        ? formErr(res, status, code, message, fix, formReturn(null).replace(/([?&])space_submitted=[^&#]*&?/, "$1").replace(/[?&]$/, ""))
        : err(res, status, code, message, fix);
      // 与线上同一道 CSRF 闸：只收本站页面发来的写（Origin / Sec-Fetch-Site 任一表明跨站即拒）
      const o = req.headers.origin, sfs = req.headers["sec-fetch-site"];
      if ((o && o !== origin && o !== "null") || (sfs && sfs !== "same-origin" && sfs !== "none")) return fail(403, "cross_origin", "只接受本页发出的提交");
      if (!SERVE_TABLE_NAME.test(table)) return fail(422, "invalid_table_name", "表名不合法", "小写字母开头，只含字母、数字、下划线，≤ 64");
      const file = join(base, "_data", `${table}.json`);
      if (!existsSync(file)) return fail(404, "table_not_found", "这份内容没有这张表", `本地：建 _data/${table}.json（内容 []）；线上：set_data 建表并打开 append_open`);
      if (closed.has(table)) return fail(403, "append_closed", "这张表不接收提交", `表「${table}」的读者写回没有打开；发布者用 set_data 传 append_open=true 打开`);
      let text;
      try { text = await readBody(req); } catch { return fail(413, "too_large", "提交的内容太大"); }
      let row, next = null;
      if (/^application\/json\b/i.test(ct)) {
        try { row = JSON.parse(text); } catch { return fail(400, "bad_request", "参数格式不正确", "请求体要是 JSON 对象：键是列名，值是那一格"); }
      } else if (/^application\/x-www-form-urlencoded\b/i.test(ct)) {
        row = {};
        for (const [k, v] of new URLSearchParams(text)) { if (k === "_next") next = v; else if (!k.startsWith("_")) row[k] = v; }
      } else return fail(415, "bad_request", "参数格式不正确", "用 JSON（Content-Type: application/json）或普通表单（application/x-www-form-urlencoded）提交；带文件的表单不收");
      if (!row || typeof row !== "object" || Array.isArray(row)) return fail(422, "row_not_object", "提交的内容不是一行数据", "传一个对象：键是列名，值是那一格");
      let t;
      try { t = loadTable(file); } catch { return fail(500, "local_table_invalid", `_data/${table}.json 不是行数组`, "内容要是 [ {…}, … ]（或 data pull --json 的 {columns, rows}）"); }
      // 线上按底表的列投影（多出来的键丢掉）；本地的「列」= 文件里已有行的键（空表时收下全部键）
      const known = t.doc && Array.isArray(t.doc.columns) ? t.doc.columns : [...new Set(t.rows.flatMap((r) => (r && typeof r === "object" ? Object.keys(r) : [])))];
      const out = {};
      const ignored = [];
      for (const [k, v] of Object.entries(row)) {
        if (READBACK.has(k)) continue; // 读回键只由平台写（线上同口径）
        if (known.length && !known.includes(k)) { if (!k.startsWith("_")) ignored.push(k); continue; }
        if (v !== null && typeof v === "object") return fail(422, "cell_not_scalar", `「${k}」是对象或数组`, "每一格只能是文字、数字、真假或空");
        out[k] = v;
      }
      t.rows.push(out);
      writeFileSync(file, JSON.stringify(t.doc, null, 2) + "\n");
      const id = `local_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      if (!appended.has(table)) appended.set(table, []);
      appended.get(table).push({ row: JSON.parse(JSON.stringify(out)), id, at: new Date().toISOString() });
      log(`+ _data/${table}.json ← ${JSON.stringify(out)}`);
      const warnings = ignored.length ? [{ code: "unknown_columns", columns: ignored.slice(0, 20), message: `这些键不是表「${table}」的列，没有保存：${ignored.join(", ")}`, fix: `表的列是 ${known.join(", ")}；要收新的一格，先用 set_data（或 set_form）把列加上` }] : [];
      if (ignored.length) log(`! _data/${table}: 未知列没保存 ${ignored.join(", ")}`);
      if (!isForm) return json(res, 201, { id, status: "approved", ignored_columns: ignored.slice(0, 20), warnings });
      return send(res, 303, { Location: formReturn(next) }, "");
    }
    if (method !== "GET" && method !== "HEAD") return send(res, 405, { Allow: "GET, HEAD", "Content-Type": "text/plain; charset=utf-8" }, "method not allowed");
    if (dm && dm[2] && existsSync(join(base, "_data", `${dm[1]}.json`))) {
      let body;
      try {
        body = readFileSync(join(base, "_data", `${dm[1]}.json`));
        const t = loadTable(join(base, "_data", `${dm[1]}.json`));
        if (appended.get(dm[1])?.length) body = JSON.stringify(annotate(dm[1], t.rows)); // 线上读回出的是行数组 + 读回键
      }
      catch { return err(res, 500, "local_table_invalid", `_data/${dm[1]}.json 不是行数组`, "内容要是 [ {…}, … ]"); }
      return send(res, 200, { "Content-Type": "application/json; charset=utf-8", "X-Space-Revision": "0" }, method === "HEAD" ? "" : body);
    }

    // 静态文件原样；目录 ⇒ index.html
    let file = join(base, path);
    if (!file.startsWith(base)) return send(res, 400, { "Content-Type": "text/plain; charset=utf-8" }, "bad path");
    if (existsSync(file) && statSync(file).isDirectory()) {
      if (!path.endsWith("/")) return send(res, 301, { Location: `${url.pathname}/${url.search}` }, "");
      file = join(file, "index.html");
    }
    if (!existsSync(file) || !statSync(file).isFile()) return send(res, 404, { "Content-Type": "text/plain; charset=utf-8" }, "not found");
    const ext = extname(file).slice(1).toLowerCase();
    const mime = SERVE_MIME[ext] || "application/octet-stream";
    const headers = { "Content-Type": mime };
    let body = readFileSync(file);
    if (/^text\/html/.test(mime)) body = Buffer.from(injectLocalSdk(body.toString("utf8"), { deck }), "utf8");
    if (/^(text\/html|image\/svg)/.test(mime)) headers["Content-Security-Policy"] = serveHtmlCsp(origin);
    else {
      // 与线上 /v/ 同：非 HTML 带 ACAO *；`?space_dl=<名>`（点击委托补的）⇒ attachment
      headers["Access-Control-Allow-Origin"] = "*";
      const dlName = url.searchParams.get("space_dl");
      if (dlName) headers["Content-Disposition"] = serveAttachmentHeader(dlName, relative(base, file).split("\\").join("/"));
    }
    return send(res, 200, headers, method === "HEAD" ? "" : body);
  };
};

// ── app：独立的应用控制面。保持单文件分发；不复用页面 api() 的自动写请求重试。──────────
class AppCliError extends Error { constructor(code) { super(code); this.code = code; } }
const appFail = (code) => { throw new AppCliError(code); };
const APP_CLI_USAGE = [
  "app capabilities | list",
  "app create --name NAME",
  "app validate --manifest FILE",
  "app environment --app ID | save --app ID --manifest FILE --revision N",
  "app prepare --app ID --revision N --request-id ULID",
  "app releases --app ID | release --app ID --release ID",
  "app upload --app ID --release ID --manifest FILE --root DIRECTORY",
  "app submit | cancel-release --app ID --release ID",
  "app deploy --app ID --release ID --generation N --request-id ULID",
  "app deployments --app ID | deployment | cancel-deployment --app ID --deployment ID",
  "app admission --app ID",
  "app stop --app ID --revision N --request-id ULID",
  "app resume --app ID --revision N --request-id ULID",
  "app diagnostics --app ID [--request-id ULID]",
  "app usage --app ID",
  "app archive --app ID --out NEW_FILE [--portable]",
  "app restore --app ID --archive FILE --request-id ULID",
  "所有命令：SPACE_TOKEN/--token，SPACE_BASE/--base；--environment 默认 preview。输出 JSON 原始状态，任务提交不等于发布成功。",
];
function appLocalBytes(path, max, root) {
  let fd;
  try {
    // Opening a FIFO must not block before fstat can reject non-regular input.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > max) return appFail("app_local_file_limit");
    if (root) {
      const actual = realpathSync(path), rel = relative(root, actual), linked = statSync(actual);
      if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || linked.dev !== info.dev || linked.ino !== info.ino) return appFail("app_file_outside_root");
    }
    const parts = []; let size = 0;
    while (true) {
      const chunk = Buffer.alloc(Math.min(65536, max + 1 - size)), count = readSync(fd, chunk, 0, chunk.length, null);
      if (!count) break;
      size += count; if (size > max) return appFail("app_local_file_limit"); parts.push(chunk.subarray(0, count));
    }
    return Buffer.concat(parts);
  } catch (error) { if (error instanceof AppCliError) throw error; return appFail("app_local_file_unavailable"); }
  finally { if (fd !== undefined) closeSync(fd); }
}
async function appResponseBytes(response, max) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(); let size = 0; const parts = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > max) return appFail("app_response_limit"); parts.push(value);
    }
    return Buffer.concat(parts);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function runAppPlatformCli(argv, env = process.env) {
  const action = argv[0];
  if (!action || action === "help") return { usage: APP_CLI_USAGE };
  const flags = {}, actions = {
    admission: ["app"], stop: ["app", "revision", "request-id"], resume: ["app", "revision", "request-id"],
    usage: ["app"], diagnostics: ["app"], capabilities: [], list: [], create: ["name"], validate: ["manifest"], environment: ["app"], save: ["app", "manifest", "revision"],
    prepare: ["app", "revision", "request-id"], releases: ["app"], release: ["app", "release"],
    upload: ["app", "release", "manifest", "root"], submit: ["app", "release"], "cancel-release": ["app", "release"],
    deploy: ["app", "release", "generation", "request-id"], deployments: ["app"], deployment: ["app", "deployment"],
    "cancel-deployment": ["app", "deployment"], archive: ["app", "out", "portable"], restore: ["app", "archive", "request-id"],
  };
  if (!Object.hasOwn(actions, action)) return appFail("app_command_invalid");
  const allowed = new Set([...actions[action], ...(action === "diagnostics" ? ["request-id"] : []), "base", "token", "environment"]);
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i].startsWith("--") ? argv[i].slice(2) : "";
    if (!allowed.has(flag) || Object.hasOwn(flags, flag)) return appFail("app_option_invalid");
    if (flag === "portable") flags[flag] = true;
    else { const value = argv[++i]; if (!value || value.startsWith("--")) return appFail("app_option_invalid"); flags[flag] = value; }
  }
  for (const required of actions[action]) if (required !== "portable" && !flags[required]) return appFail("app_option_missing");
  const loopback = u => ["127.0.0.1", "[::1]", "localhost"].includes(u.hostname);
  let base;
  try { base = new URL(flags.base || env.SPACE_BASE || "https://space.24haowan.com"); } catch { return appFail("app_base_invalid"); }
  if (base.username || base.password || base.pathname !== "/" || base.search || base.hash
    || !(base.protocol === "https:" || base.protocol === "http:" && loopback(base))) return appFail("app_base_invalid");
  const token = flags.token || env.SPACE_TOKEN;
  if (typeof token !== "string" || !token || token.length > 4096 || /[\r\n]/.test(token)) return appFail("app_token_required");
  const environment = flags.environment || "preview";
  if (!["preview", "production"].includes(environment) || ["archive", "restore", "diagnostics", "admission", "stop", "resume", "usage"].includes(action) && environment !== "preview") return appFail("app_environment_invalid");
  const identifier = name => { const value = flags[name]; if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)) return appFail("app_id_invalid"); return value; };
  const integer = name => { const v = flags[name]; if (!/^(0|[1-9][0-9]*)$/.test(v) || Number(v) > 2147483646) return appFail("app_revision_invalid"); return Number(v); };
  const parse = bytes => { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { return appFail("app_json_invalid"); } };
  const root = "/api/app-platform", scope = flags.app ? `${root}/apps/${identifier("app")}/environments/${environment}` : "";
  // A transport failure may follow a committed mutation. Never silently replay it or invent a new ID.
  const request = async (path, body, method = body === undefined ? "GET" : "POST", max = 2 * 1024 * 1024, extraHeaders = {}) => {
    try {
      const response = await fetch(base.origin + path, { method, redirect: "error", signal: AbortSignal.timeout(["archive", "restore"].includes(action) ? 125000 : 30000),
        headers: { authorization: `Bearer ${token}`, "x-space-cli": String(CLI_VERSION), ...extraHeaders, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body) });
      const bytes = await appResponseBytes(response, response.ok ? max : 65536);
      if (!response.ok) {
        let code; try { code = parse(bytes)?.error?.code; } catch { /* Keep arbitrary HTML/provider errors out of diagnostics. */ }
        return appFail(typeof code === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : `app_http_${response.status}`);
      }
      if (Number(response.headers.get("x-space-cli-min") || 0) > CLI_VERSION) return appFail("app_cli_upgrade_required");
      return bytes;
    } catch (error) { if (error instanceof AppCliError) throw error; return appFail("app_network_unknown"); }
  };
  const json = async (...args) => parse(await request(...args));
  const manifest = () => parse(appLocalBytes(flags.manifest, 262144));
  switch (action) {
    case "capabilities": return json(`${root}/capabilities`);
    case "list": return json(`${root}/apps`);
    case "create": return json(`${root}/apps`, { name: flags.name });
    case "validate": return json(`${root}/validate`, manifest());
    case "environment": return json(scope);
    case "usage": return json(`${scope}/usage`);
    case "admission": return json(`${scope}/admission`);
    case "stop": case "resume": return json(`${scope}/admission`, { request_id: identifier("request-id"), expected_revision: integer("revision"), state: action === "stop" ? "stopped" : "running" });
    case "diagnostics": return json(`${scope}/diagnostics${flags["request-id"] ? `?request_id=${identifier("request-id")}` : ""}`);
    case "save": return json(scope, { expected_revision: integer("revision"), manifest: manifest() }, "PUT");
    case "prepare": return json(`${scope}/releases`, { expected_revision: integer("revision"), request_id: identifier("request-id") });
    case "releases": return json(`${scope}/releases`);
    case "release": return json(`${scope}/releases/${identifier("release")}`);
    case "submit": case "cancel-release": return json(`${scope}/releases/${identifier("release")}/${action === "submit" ? "submit" : "cancel"}`, undefined, "POST");
    case "deploy": return json(`${scope}/deployments`, { release_id: identifier("release"), request_id: identifier("request-id"), expected_generation: integer("generation") });
    case "deployments": return json(`${scope}/deployments`);
    case "deployment": return json(`${scope}/deployments/${identifier("deployment")}`);
    case "cancel-deployment": return json(`${scope}/deployments/${identifier("deployment")}/cancel`, undefined, "POST");
    case "archive": {
      if (existsSync(flags.out)) return appFail("app_output_exists");
      const bytes = await request(`${scope}/${flags.portable ? "archive-bundle" : "archive"}`, undefined, "GET", flags.portable ? 16 * 1024 * 1024 : 32 * 1024 * 1024);
      const archive = parse(bytes);
      if (archive?.format !== (flags.portable ? "space-app-portable/v1" : "space-app-archive/v1")) return appFail("app_response_invalid");
      try { writeFileSync(flags.out, bytes, { flag: "wx", mode: 0o600 }); } catch { return appFail("app_output_unavailable"); }
      return { saved: true, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), offline_archive_available: false };
    }
    case "restore": {
      const bytes = appLocalBytes(flags.archive, 32 * 1024 * 1024), archive = parse(bytes);
      if (archive?.format !== "space-app-archive/v1") return appFail("app_online_archive_required");
      return json(`${scope}/archive-restore`, bytes, "POST", 2 * 1024 * 1024, { "idempotency-key": identifier("request-id") });
    }
    case "upload": {
      const releaseId = identifier("release"), local = manifest();
      const checked = await json(`${root}/validate`, local), saved = await json(`${scope}/releases/${releaseId}`);
      if (!checked.manifest_valid || checked.manifest_sha256 !== saved.release?.manifest_sha256 || saved.release.state !== "awaiting_upload"
        || local.environment !== environment || !Array.isArray(local.files) || !local.files.length || local.files.length > 2000) return appFail("app_release_manifest_mismatch");
      let directory; try { directory = realpathSync(flags.root); if (!statSync(directory).isDirectory()) throw Error(); } catch { return appFail("app_root_invalid"); }
      let total = 0;
      const fileBytes = file => {
        if (typeof file.path !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9_.-]*(\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/.test(file.path)
          || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > 50 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(file.sha256)) return appFail("app_file_invalid");
        let path; try { path = realpathSync(join(directory, file.path)); } catch { return appFail("app_local_file_unavailable"); }
        const rel = relative(directory, path);
        if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || resolve(directory, rel) !== path) return appFail("app_file_outside_root");
        const bytes = appLocalBytes(path, 50 * 1024 * 1024, directory);
        if (bytes.length !== file.size || createHash("sha256").update(bytes).digest("hex") !== file.sha256) return appFail("app_file_mismatch");
        return bytes;
      };
      // Verify the entire local package before requesting any upload capability.
      for (const file of local.files) { total += file.size; if (total > 200 * 1024 * 1024) return appFail("app_local_file_limit"); fileBytes(file); }
      let uploaded = 0, existing = 0;
      for (let start = 0; start < local.files.length; start += 32) {
        const indices = local.files.slice(start, start + 32).map((_, i) => start + i);
        const result = await json(`${scope}/releases/${releaseId}/upload-grants`, { file_indices: indices });
        if (result.release_id !== releaseId || !Array.isArray(result.uploads) || result.uploads.length !== indices.length) return appFail("app_upload_grant_invalid");
        for (let i = 0; i < indices.length; i++) {
          const grant = result.uploads[i], file = local.files[indices[i]];
          if (!grant || grant.file_index !== indices[i] || grant.path !== file.path || grant.size !== file.size || grant.sha256 !== file.sha256
            || grant.method !== "POST" || grant.redirect !== "error" || !(Date.parse(grant.expires_at) > Date.now())
            || !grant.fields || typeof grant.fields !== "object" || Array.isArray(grant.fields)
            || Object.keys(grant.fields).length > 32 || grant.fields["x-oss-forbid-overwrite"] !== "true") return appFail("app_upload_grant_invalid");
          let destination; try { destination = new URL(grant.url); } catch { return appFail("app_upload_grant_invalid"); }
          if (destination.username || destination.password || destination.search || destination.hash || destination.pathname !== "/"
            || !(destination.protocol === "https:" && /^[a-z0-9-]+\.oss-cn-[a-z0-9]+\.aliyuncs\.com$/.test(destination.hostname) && !destination.port
              || loopback(base) && loopback(destination) && destination.protocol === "http:")) return appFail("app_upload_grant_invalid");
          const form = new FormData();
          for (const [key, value] of Object.entries(grant.fields)) {
            if (typeof value !== "string" || value.length > 16384 || key.length > 128 || key === "file") return appFail("app_upload_grant_invalid");
            form.append(key, value);
          }
          form.append("file", new Blob([fileBytes(file)], { type: "application/octet-stream" }), "file");
          try {
            const response = await fetch(destination, { method: "POST", body: form, redirect: "error", signal: AbortSignal.timeout(60000) });
            await response.body?.cancel();
            if (response.status === 409) existing++;
            else if (response.status === 200 || response.status === 201 || response.status === 204) uploaded++;
            else return appFail("app_upload_rejected");
          } catch (error) { if (error instanceof AppCliError) throw error; return appFail("app_upload_unknown"); }
        }
      }
      // Even a 2xx upload is not content verification; only the server's sealer can attest that.
      return { release_id: releaseId, uploaded, already_present_unverified: existing, artifacts_verified: false, deployable: false };
    }
  }
}

// 两边都按真实路径比（#12322）：Node 加载主模块前会 realpath，`import.meta.url` 是 `/private/tmp/space.mjs`，
// 而 argv[1] 仍是用户敲的 `/tmp/space.mjs`（macOS 上 /tmp 是符号链接）—— 直接比对不上，push / 用法全都静默退出 0。
const realUrl = (p) => { try { return pathToFileURL(realpathSync(p)).href; } catch { return pathToFileURL(p).href; } };
const isMain = !!process.argv[1] && realUrl(process.argv[1]) === realUrl(fileURLToPath(import.meta.url));
const args = isMain ? process.argv.slice(2) : [];
const cmd = args[0];
if (isMain && cmd === "app") {
  const output = (stream, value) => new Promise((resolve, reject) => stream.write(JSON.stringify(value) + "\n", error => error ? reject(error) : resolve()));
  try { await output(process.stdout, await runAppPlatformCli(args.slice(1))); }
  catch (error) { await output(process.stderr, { error: { code: error instanceof AppCliError ? error.code : "app_cli_failed" } }); process.exitCode = 2; }
  process.exit(process.exitCode || 0);
}
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return dflt;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? true : v;
};
const has = (name) => args.includes(`--${name}`);
// 版本标签：`--tag 2026-10-29 [--tag-title "这一期的标题"] [--tag-note "一句说明"]`。打了标签的页面，读者看到最新一期、能翻往期。
const tagArg = () => {
  const name = opt("tag");
  if (name === undefined) return {};
  if (name === true) die("--tag 后面要跟标签名（如 2026-10-29）");
  const title = opt("tag-title"), note = opt("tag-note");
  return { tag: title || note ? { name, ...(title && title !== true ? { title } : {}), ...(note && note !== true ? { note } : {}) } : name };
};
const BASE = (opt("base", process.env.SPACE_BASE || "https://space.24haowan.com")).replace(/\/$/, "");
const TOKEN = opt("token", process.env.SPACE_TOKEN);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
if (isMain && (!cmd || !["push", "publish", "share", "downloads", "pull", "data", "serve", "quick", "watch"].includes(cmd))) die("用法：space-cli.mjs push|publish|downloads|share|pull|data|serve|quick|watch|app …（见文件头）");
if (isMain && !TOKEN && cmd !== "serve" && cmd !== "quick") die("缺 --token 或 SPACE_TOKEN");

const api = async (path, body, method = body === undefined ? "GET" : "POST") => {
  let r;
  for (let attempt = 1; ; attempt++) {
    try { r = await fetch(`${BASE}${path}`, { method, headers: { authorization: `Bearer ${TOKEN}`, "x-space-cli": String(CLI_VERSION), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) }); break; }
    catch (e) { if (attempt >= 3) die(`${path} 网络失败（3 次）：${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`); await new Promise((res) => setTimeout(res, 800 * attempt)); }
  }
  const min = Number(r.headers.get("x-space-cli-min") || 0);
  const latest = Number(r.headers.get("x-space-cli-latest") || 0);
  if (min > CLI_VERSION) die(`上传助手版本过旧（v${CLI_VERSION} < 服务端最低 v${min}），先更新：curl -sSO ${BASE}/cli/space.mjs`);
  if (latest > CLI_VERSION && !versionWarned) { versionWarned = true; console.error(`⚠ 上传助手有新版 v${latest}（当前 v${CLI_VERSION}）：curl -sSO ${BASE}/cli/space.mjs 更新`); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    console.error(`✗ ${e.code || r.status}: ${e.message || ""}${e.fix ? `\n  修法：${e.fix}` : ""}`);
    for (const i of e.issues || []) console.error(`  - [${i.code}] ${i.file || ""}${i.line ? `:${i.line}` : ""} ${i.message}${i.fix ? ` → ${i.fix}` : ""}`);
    process.exit(2);
  }
  return j;
};

const walk = (root) => {
  const st = statSync(root);
  if (st.isFile()) return [{ abs: root, rel: basename(root) }];
  const out = [];
  const rec = (dir) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith(".") || ent.name === "node_modules") continue;
      // 没有扩展名的（LICENSE、README）与 .map 平台不收；跳过而不是让整个 push 被 ext_not_allowed 打死
      if (ent.isFile() && (!extname(ent.name) || /\.map$/i.test(ent.name))) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) rec(abs);
      else out.push({ abs, rel: relative(root, abs).split("\\").join("/") });
    }
  };
  rec(root);
  return out;
};

const MIME = { pdf: "application/pdf", html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8", json: "application/json; charset=utf-8", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf", txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "application/octet-stream", bin: "application/octet-stream", wasm: "application/wasm", bcmap: "application/octet-stream", pfb: "application/octet-stream", webmanifest: "application/manifest+json", jsx: "text/javascript; charset=utf-8", ico: "image/x-icon", csv: "text/csv; charset=utf-8", xml: "application/xml", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg" };
const mimeOf = (p) => MIME[extname(p).slice(1).toLowerCase()] || "application/octet-stream";

// ── quick（#11310 C9）：不登录发一份。POST /quick（JSON 形态）→ /u/<票> 的五个写口（与上传网页同一套）→ share。不要 token。
//    规则与网页、/mcp/quick 同一套（常量在 src/upload/guest.ts）：每来源每小时 3 份、分享后 7 天失效、读者 50 台；撞到就只给一个出口：认领链接。
const anon = async (path, init = {}) => {
  let r;
  for (let attempt = 1; ; attempt++) {
    try { r = await fetch(path.startsWith("http") ? path : `${BASE}${path}`, { ...init, headers: { accept: "application/json", "x-space-cli": String(CLI_VERSION), "user-agent": `space-cli/${CLI_VERSION}`, ...(init.headers || {}) } }); break; }
    catch (e) { if (attempt >= 3) die(`${path} 网络失败（3 次）：${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`); await new Promise((res) => setTimeout(res, 800 * attempt)); }
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const e = j.error || {};
    console.error(`✗ ${e.code || r.status}: ${e.message || ""}${e.fix ? `\n  修法：${e.fix}` : ""}`);
    for (const i of e.issues || []) console.error(`  - [${i.code}] ${i.file || ""}${i.line ? `:${i.line}` : ""} ${i.message}${i.fix ? ` → ${i.fix}` : ""}`);
    if (e.code === "guest_rate_limited" || e.code === "guest_capacity") console.error(`  撞到了不登录发布的次数上限。要继续发 → 登录接入：${BASE}/start`);
    process.exit(2);
  }
  return j;
};
const QUICK_ENTRY_RE = /\.(html?|md|pdf|pptx|png|jpe?g|webp)$/i, QUICK_ASSET_RE = /\.(css|js|mjs|json|svg|txt|csv)$/i;
const quickKeepLine = (claimUrl) => `不登录发的 · 7 天后失效 · 读者 50 台上限 —— 要保留 / 要更多读者 → 登录保留（链接不变）：${claimUrl}`;
const printQuickStatus = (s) => {
  console.log(`✓ 「${s.title}」状态：${s.status} · 读者 ${s.readers} / ${s.reader_cap} 台 · 还有 ${s.days_left} 天失效${s.reader_cap_reached ? " · 已到上限" : ""}`);
  if (s.share_url) console.log(`分享：${s.share_url}`);
  else if (s.preview_url) console.log(`预览：${s.preview_url}\n→ 看过预览、确认后：node space.mjs quick ${s.manage_url} --share`);
  else console.log("→ 还在审核；稍后再查同一条命令");
  console.log(`管理：${s.manage_url}`);
  console.log(quickKeepLine(s.claim_url));
};
if (isMain && cmd === "quick") {
  const target = args[1];
  if (!target || target.startsWith("--")) die("quick 需要一个文件 / 目录路径，或一条 /quick/m/… 管理链接");
  if (/\/quick\/m\//.test(target)) {
    // 第二种形态：查状态 / 补分享。
    const manage = target.startsWith("http") ? target : `${BASE}${target}`;
    const s = has("share") ? await (async () => { await anon(`${manage}/share`, { method: "POST" }); return anon(manage); })() : await anon(manage);
    printQuickStatus(s);
    process.exit(0);
  }
  if (!existsSync(target)) die(`找不到 ${target}`);
  const raw = walk(target).map((f) => ({ rel: f.rel, buf: readFileSync(f.abs) }));
  if (!raw.length) die("没有文件");
  if (raw.length > 50) die(`不登录发布每次最多 50 个文件（现在 ${raw.length} 个）；更多文件请登录后用 push`);
  const total = raw.reduce((n, f) => n + f.buf.length, 0);
  if (total > 20 * 1048576) die(`不登录发布每次最多 20 MB（现在 ${(total / 1048576).toFixed(1)} MB）；更大的包请登录后用 push`);
  for (const f of raw) {
    if (!f.buf.length) die(`空文件：${f.rel}`);
    if (!QUICK_ENTRY_RE.test(f.rel) && !QUICK_ASSET_RE.test(f.rel)) die(`不登录发布不收这种文件：${f.rel}（只收 HTML / Markdown / PDF / PPTX / 图片，以及 HTML 小包里的 css / js / json / svg / txt / csv）`);
  }
  const only = (re) => { const m = raw.filter((f) => re.test(f.rel)); return m.length === 1 ? m[0].rel : undefined; };
  const entry = (raw.length === 1 ? raw[0].rel : undefined) || raw.find((f) => f.rel === "index.html")?.rel || only(/\.html?$/i) || only(/\.md$/i) || only(/\.pdf$/i) || only(/\.pptx$/i);
  if (!entry || !QUICK_ENTRY_RE.test(entry)) die("推断不出入口（单个文件、目录里有 index.html、或目录里只有一份 HTML / MD / PDF / PPTX）");
  let title = opt("title");
  if (!title || title === true) {
    const head = raw.find((f) => f.rel === entry).buf.toString("utf8").slice(0, 8000);
    const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    if (/\.md$/i.test(entry)) title = /^#\s+(.+?)\s*$/m.exec(head)?.[1];
    else if (/\.html?$/i.test(entry)) title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "") || strip(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head)?.[1] ?? "") || undefined;
    title = (title || "").trim().slice(0, 120) || basename(entry).replace(/\.[^.]+$/, "");
  }
  console.log(`→ ${raw.length} 个文件，${(total / 1048576).toFixed(1)} MB，入口 ${entry}，标题「${title}」`);
  const started = await anon("/quick", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `title=${encodeURIComponent(title)}` });
  const base = new URL(started.uploadUrl).pathname; // /u/<票>
  const declared = await anon(`${base}/files`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ files: raw.map((f) => ({ path: f.rel, size: f.buf.length, sha256: createHash("sha256").update(f.buf).digest("hex") })) }) });
  const PART = Number(declared.partBytes) || 4 * 1024 * 1024;
  for (const f of raw) {
    const st = await anon(`${base}/start`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: f.rel }) });
    const parts = [];
    for (let n = 1, off = 0; off < f.buf.length; n++, off += PART) {
      const chunk = f.buf.subarray(off, Math.min(off + PART, f.buf.length));
      const r = await anon(`${base}/part?path=${encodeURIComponent(f.rel)}&upload=${encodeURIComponent(st.uploadId)}&n=${n}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk });
      parts.push({ number: n, etag: r.etag });
    }
    await anon(`${base}/complete`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: f.rel, uploadId: st.uploadId, parts }) });
    console.log(`→ ${f.rel} 已传（${(f.buf.length / 1024).toFixed(0)} KB）`);
  }
  const fin = await anon(`${base}/finalize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ entry }) });
  const manageUrl = `${BASE}${fin.manageUrl}`;
  console.log(`✓ 已上传，状态：${fin.status}`);
  if (fin.previewUrl) console.log(`预览：${fin.previewUrl}`);
  if (fin.status === "published" && !has("no-share")) {
    const s = await anon(`${fin.manageUrl}/share`, { method: "POST" });
    console.log(`分享（发到微信）：${s.share_url}\n失效：${s.expires_at}`);
  } else if (fin.status === "published") console.log(`→ 已过审但未分享（--no-share）；确认后：node space.mjs quick ${manageUrl} --share`);
  else console.log(`→ 还在审核（${fin.status}）；稍后：node space.mjs quick ${manageUrl}${fin.retryRequired ? "（审核服务暂时不可用，打开管理链接点「重试审核」）" : " --share"}`);
  console.log(`管理：${manageUrl}`);
  console.log(quickKeepLine(manageUrl));
  process.exit(0);
}

if (isMain && cmd === "push") {
  const target = args[1];
  if (!target || target.startsWith("--")) die("push 需要一个目录、PDF 或 PPTX 路径");
  const proposal = opt("proposal");
  if (!proposal || proposal === true) die("缺 --proposal <id>");
  // --migrate-ai-site：剥 SW / 剥 /track.js / 外域素材打进包（--cdn-hosts 逗号分隔，默认 static-cdn.24haowan.com）
  const migrate = has("migrate-ai-site");
  const cdnHosts = String(opt("cdn-hosts", "static-cdn.24haowan.com")).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
  const configFiles = new Set([opt("manifest"), opt("downloads")].filter((p) => typeof p === "string").map((p) => resolve(p)));
  // 没传 --manifest ⇒ 包根的 manifest.json（认得出是活页 manifest 时）就是这一版的 manifest，且不作为文件上传。
  let pkgManifest = null;
  const mOpt = opt("manifest");
  if ((!mOpt || mOpt === true) && existsSync(target) && statSync(target).isDirectory() && existsSync(join(target, PACKAGE_MANIFEST))) {
    const mAbs = join(target, PACKAGE_MANIFEST);
    let parsed = null;
    try { parsed = JSON.parse(readFileSync(mAbs, "utf8")); } catch (e) { die(`包根 ${PACKAGE_MANIFEST} 不是合法 JSON：${e.message}（要当普通文件传就改个名字）`); }
    pkgManifest = asPackageManifest(parsed);
    if (pkgManifest) { configFiles.add(resolve(mAbs)); console.log(`→ 使用包根 ${PACKAGE_MANIFEST} 作 manifest（不上传这个文件）${pkgManifest.images ? `，images: ${JSON.stringify(pkgManifest.images)}` : ""}`); }
    else console.log(`→ 包根 ${PACKAGE_MANIFEST} 看着不是活页 manifest（像 PWA 清单），当普通文件上传；要指定 manifest 用 --manifest`);
  }
  let raw = walk(target).filter((f) => !configFiles.has(resolve(f.abs)) && !(migrate && isSwFile(f.rel))).map((f) => ({ rel: f.rel, abs: f.abs, buf: readFileSync(f.abs) }));
  if (migrate) {
    const TEXT = /\.(html?|css|js|mjs|json)$/i;
    const cdnMap = new Map();
    const pkgPaths = new Set(raw.map((x) => x.rel));
    let localHits = 0;
    for (const f of raw.filter((x) => TEXT.test(x.rel))) for (const url of findCdnRefs(f.buf.toString("utf8"), cdnHosts)) if (!cdnMap.has(url)) { const local = localForCdn(url, pkgPaths); if (local) localHits++; cdnMap.set(url, local ?? cdnLocalName(url)); }
    const toFetch = [...cdnMap].filter(([, rel]) => rel.startsWith("_cdn/"));
    if (cdnMap.size) console.log(`→ 外域素材 ${cdnMap.size} 个：${localHits} 个包内已有（改相对路径），${toFetch.length} 个下载进包…`);
    for (const [url, rel] of toFetch) {
      const r = await fetch(url).catch(() => null);
      if (!r || !r.ok) { console.warn(`  ! 外域素材 ${url} 下载失败 ${r ? r.status : "network"} —— 引用原样保留（沙箱 CSP 可能拦，请人看一眼）`); cdnMap.delete(url); continue; }
      raw.push({ rel, abs: null, buf: Buffer.from(await r.arrayBuffer()) });
    }
    raw = raw.map((f) => {
      if (!TEXT.test(f.rel)) return f;
      let t = f.buf.toString("utf8");
      if (/\.html?$/i.test(f.rel)) t = stripAiSiteTracking(t);
      if (/\.(html?|js|mjs)$/i.test(f.rel)) t = stripServiceWorker(t);
      t = rewriteCdnRefs(t, cdnMap, f.rel.split("/").length - 1);
      return { ...f, buf: Buffer.from(t) };
    });
    console.log(`→ 迁移转换：剥 SW/track.js，${cdnMap.size} 个外域素材已内置`);
  }
  // 讲稿剥离（每次 push，不只是迁移）：包里不留 `data-speaker-notes`，讲稿进 manifest.notes[]。
  // 必须在算 sha256 之前做 —— 上传的字节就是剥过的那份。
  const notesByFile = new Map();
  raw = raw.map((f) => {
    if (!/\.html?$/i.test(f.rel)) return f;
    const r = extractSpeakerNotes(f.buf.toString("utf8"));
    if (!r.notes.length) return f;                       // 没有讲稿 ⇒ 字节一个不动（sha256 不变）
    notesByFile.set(f.rel, r.notes);
    return { ...f, buf: Buffer.from(r.html) };
  });
  const files = raw.map((f) => ({ path: f.rel, size: f.buf.length, sha256: createHash("sha256").update(f.buf).digest("hex"), mime: mimeOf(f.rel), buf: f.buf }));
  if (!files.length) die("没有文件");
  let manifest;
  const mPath = opt("manifest");
  if (mPath && mPath !== true) manifest = JSON.parse(readFileSync(mPath, "utf8"));
  else {
    // 入口推断：单个 PDF / PPTX 文件；目录里的 index.html；否则目录里唯一的 PDF 或 PPTX（P2-c 起 PPTX 可作入口，后台转逐页图）
    const only = (re) => { const m = files.filter((f) => re.test(f.path)); return m.length === 1 ? m[0].path : undefined; };
    const entry = (typeof pkgManifest?.entry === "string" ? pkgManifest.entry : undefined) || (files.length === 1 && /\.(pdf|pptx|md)$/i.test(files[0].path) ? files[0].path : undefined) || files.find((f) => f.path === "index.html")?.path || only(/\.pdf$/i) || only(/\.pptx$/i) || only(/\.md$/i);
    if (!entry) die("推断不出入口（单个 PDF / PPTX / Markdown、目录里有 index.html、或目录里只有一份 PDF / PPTX / MD）；用 --manifest 指定");
    let title = typeof pkgManifest?.title === "string" ? pkgManifest.title : opt("title");
    if (!title || title === true) {
      // 标题从**入口内容**里取，目录名只是最后的兜底（#8059）。
      // 以前这里一上来就是 `basename(target)`，于是客户在微信里收到的卡片标题是
      // `24haowan_upload_3999` / `_push_0918` / `_report.pdf` 这种 —— 生产 34 份成果里 14 份如此。
      // 作者给的 `--title` 仍然最高；服务端那边 `proposal.title` 也排在 manifest.title 前面，
      // 两道都兜不住时才会看到目录名。
      const head = (() => {
        try { return (files.find((f) => f.path === entry)?.buf ?? readFileSync(files.length === 1 ? target : join(target, entry))).toString("utf8").slice(0, 8000); }
        catch { return ""; }
      })();
      if (/\.md$/i.test(entry)) title = /^#\s+(.+?)\s*$/m.exec(head)?.[1];
      else if (/\.html?$/i.test(entry)) {
        const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
        // <title> 优先：作者写在那儿的就是给浏览器标签页和分享卡看的。其次首个 <h1>。
        title = strip(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? "") || strip(/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(head)?.[1] ?? "") || undefined;
      }
      title = (title || "").trim().slice(0, 200) || basename(target);
      if (title === basename(target)) console.log(`→ 没能从 ${entry} 里读到标题，暂用目录名「${title}」作包标题；卡片标题会优先用方案自己的名字，要指定就加 --title "…"`);
      else console.log(`→ 包标题取自 ${entry}：「${title}」`);
    }
    // No extension-based selection: server inherits explicit previous settings or starts empty.
    // 包根 manifest 缺 entry / title 时只补缺的那两项，别的键（images / share / reader …）原样带上。
    manifest = pkgManifest ? { ...pkgManifest, title, entry } : { title, entry };
  }
  const downloadPath = opt("downloads");
  if (downloadPath === true) die("--downloads 需要下载配置 JSON 文件路径");
  if (downloadPath) manifest.downloads = JSON.parse(readFileSync(downloadPath, "utf8"));
  // 讲稿挂进 manifest：只取**入口那份**的。别的 HTML 里的照样剥掉（不能泄露），
  // 但**说出来**而不是静默丢 —— 一份包只有一条 notes[]，讲的人只看得到入口那份的。
  if (notesByFile.size) {
    const entryNotes = notesByFile.get(manifest.entry);
    if (manifest.notes && manifest.notes.length) {
      console.log(`→ manifest 自带 notes[] ${manifest.notes.length} 条，以它为准（包里剥出的 ${entryNotes ? entryNotes.length : 0} 条不叠加）`);
    } else if (entryNotes) {
      manifest.notes = entryNotes;
      console.log(`→ 讲解提示 ${entryNotes.length} 条已从包里剥出，进 manifest（客户侧拿不到）`);
    }
    for (const [rel, n] of notesByFile) {
      if (rel === manifest.entry) continue;
      console.warn(`  ! ${rel} 里的 ${n.length} 条讲解提示已剥掉但**没有进 manifest** —— 一份方案只有入口那份的讲稿会显示给讲解人`);
    }
  }
  console.log(`→ ${files.length} 个文件，${(files.reduce((a, f) => a + f.size, 0) / 1048576).toFixed(1)} MB，入口 ${manifest.entry}`);
  const sess = await api("/api/uploads", { proposal_id: proposal, files: files.map(({ path, size, sha256, mime }) => ({ path, size, sha256, mime })), note: opt("note") === true ? undefined : opt("note") });
  const delivery = await api(`/api/uploads/${sess.version_id}/downloads-preview`, { manifest });
  console.log(`→ 下载材料：${delivery.config.enabled ? "开启" : "关闭"}${delivery.inherited ? "（沿用当前版配置）" : ""}`);
  const selected = [delivery.config.source, ...delivery.config.attachments].filter(Boolean);
  if (!selected.length) console.log("  未选择下载材料；可用 --downloads <配置.json> 或在后台配置。");
  for (const item of selected) console.log(`  ${item === delivery.config.source ? "正文" : "附件"} · ${item.label} → ${item.path}${item.showFilename ? "（展示原文件名）" : ""}`);
  for (const [k, label] of Object.entries({ added: "新增", removed: "移除", replaced: "文件已替换", missing: "缺失", metadata: "展示信息调整" })) {
    for (const path of delivery.diff[k]) console.log(`  ${label}：${path}`);
  }
  if (delivery.diff.reordered) console.log("  材料顺序已调整");
  if (delivery.diff.enabledChanged) console.log("  下载开关已调整");
  if (delivery.issues.length) die(delivery.issues.map((i) => `${i.file}: ${i.message}`).join("\n"));
  console.log(`→ 版本 ${sess.version_id}（第 ${sess.seq} 版），直传 ${sess.uploads.length} 个文件…`);
  const byPath = new Map(files.map((f) => [f.path, f]));
  let done = 0;
  const queue = [...sess.uploads];
  const worker = async () => {
    for (let u = queue.shift(); u; u = queue.shift()) {
      const f = byPath.get(u.path);
      // 直传对象存储：网络抖动（fetch failed / 5xx）重试 3 次，指数退避；4xx 不重试
      let r = null, lastErr = "";
      for (let attempt = 1; attempt <= 3; attempt++) {
        try { r = await fetch(u.putUrl, { method: "PUT", headers: { "content-type": u.mime }, body: f.buf }); } catch (e) { lastErr = `${e.message}${e.cause ? ` (${e.cause.code || e.cause.message})` : ""}`; r = null; }
        if (r && (r.ok || (r.status >= 400 && r.status < 500))) break;
        if (r) lastErr = `${r.status}`;
        await new Promise((res) => setTimeout(res, 800 * attempt));
      }
      if (!r) die(`PUT ${u.path} 网络失败（3 次）：${lastErr}`);
      if (!r.ok) die(`PUT ${u.path} 失败 ${r.status}: ${(await r.text()).slice(0, 200)}`);
      done += 1;
      if (done % 20 === 0 || done === sess.uploads.length) console.log(`  ${done}/${sess.uploads.length}`);
    }
  };
  await Promise.all(Array.from({ length: Math.min(6, sess.uploads.length) }, worker));
  let fin = await api(`/api/uploads/${sess.version_id}/finalize`, { manifest, hold: has("hold"), quiet: has("quiet") || undefined, download_basis: delivery.basis, ...tagArg() });
  if (fin.status === "converting") {
    // PDF / PPTX 入口：后台转逐页图（通常 1–3 分钟），完成后自动审核。这里轮询到落定为止（最多 10 分钟）。
    process.stdout.write("→ 校验通过，正在转换为逐页图");
    // 转换完成后紧接着是审核（moderating，通常几秒到一分钟）：再多等最多 2 分钟，别把过渡态当结论打印出来。
    const t0 = Date.now();
    let tConv = 0;
    while (Date.now() - t0 < 10 * 60_000 && (fin.status === "converting" || (fin.status === "moderating" && tConv && Date.now() - tConv < 2 * 60_000))) {
      await new Promise((r) => setTimeout(r, 10_000));
      process.stdout.write(".");
      const v = await api(`/api/versions/${sess.version_id}`);
      fin = { ...fin, status: v.version.status, issues: v.issues, pages: v.version.pages };
      if (fin.status !== "converting" && !tConv) tConv = Date.now();
    }
    console.log("");
    if (fin.status === "converting") die("转换超过 10 分钟仍未完成：稍后 `GET /api/versions/<id>` 再查；PDF 入口可再 push 一次改走直接展示");
    if (fin.status === "draft") { console.error("✗ 转换失败："); for (const i of fin.issues || []) console.error(`  - [${i.code}] ${i.message}${i.fix ? ` → ${i.fix}` : ""}`); process.exit(2); }
    if (fin.status === "review") { console.log("  命中内容规则，进入人工复核（复核通过自动生效；在那之前客户仍看旧版）："); for (const i of fin.issues || []) console.log(`  - [${i.code}] ${i.message}`); }
    if (fin.status === "moderating") console.log("  内容审核尚未完成（审核服务可能暂时不可用）：稍后再 push 一次即可，文件不用重传");
    if (fin.pages) console.log(`  ${fin.pages.count} 页页图${fin.pages.fontSubstitutions?.length ? `（字体被替换：${fin.pages.fontSubstitutions.join("、")}）` : ""}`);
  }
  // 「预览」那一行（#8511）：这条链接会被人顺手转出去，所以它必须自带「能不能免登录打开、能打开多久」。
  //   `preview_expires_at` 有值 = 带票那条（免登录十分钟，private 也打得开）；为 null = 预览台关着时的
  //   退路 `/p/<id>?v=`，那条只有登录的工作区成员打得开，转出去就是一页 403。
  const previewLine = fin.preview_expires_at
    ? `\n  预览（十分钟内有效、免登录，可直接转给对方）：${fin.preview_url}`
    : `\n  预览（只有登录的工作区成员打得开，别直接转出去）：${fin.preview_url}`;
  // JEHB 空白自检：服务端判这一版打开是空白 ⇒ 先没上线（held 那条提示就是原因）。
  const blankHeld = fin.blank?.held ? fin.blank : null;
  if (fin.status === "published" && blankHeld && !has("hold")) {
    console.log(`⛔ 打开会是空白，已先不发布：客户链接仍是之前的版本。\n  原因：[${blankHeld.code}] ${blankHeld.file}${blankHeld.line ? `:${blankHeld.line}` : ""} ${blankHeld.message}\n  修法：${blankHeld.fix}\n  确认没问题仍要发布：node space-cli.mjs publish --version ${fin.version_id}${previewLine}${fin.manage_url ? `\n  管理：${fin.manage_url}` : ""}\n  version_id: ${fin.version_id}`);
  } else if (fin.status === "published") {
    console.log(has("hold")
      ? `✓ 已过审（--hold）：客户链接仍指向旧版。确认后切换：node space-cli.mjs publish --version ${fin.version_id}${previewLine}${fin.manage_url ? `\n  管理：${fin.manage_url}` : ""}`
      : `✓ 已生效（过审自动发布）${fin.active_links ? `，${fin.active_links} 条客户链接已指向本版` : "；固定链接可在管理台或通过 MCP set_visibility 设置访问权限"}${previewLine}${fin.manage_url ? `\n  管理：${fin.manage_url}` : ""}\n  version_id: ${fin.version_id}`);
  } else {
    console.log(`✓ 校验通过，状态 ${fin.status}${previewLine}${fin.manage_url ? `\n  管理：${fin.manage_url}` : ""}\n  version_id: ${fin.version_id}`);
  }
  // 发布回执里的提示（不影响发布）：例如正文里有 data-space="form" 但这一页还没 set_form（KSXQ）—— 读者点了没反应，得说出来。
  const notesLeft = [...(fin.blank && !blankHeld ? [fin.blank] : []), ...(Array.isArray(fin.compat_notes) ? fin.compat_notes : [])];
  if (notesLeft.length) {
    console.log("  提示（不影响发布）：");
    for (const n of notesLeft) console.log(`  - [${n.code}] ${n.file}${n.line ? `:${n.line}` : ""} ${n.message} → ${n.fix}`);
  }
} else if (isMain && cmd === "downloads") {
  const version = opt("version");
  if (!version || version === true) die("缺 --version <id>");
  const configPath = opt("config");
  if (configPath === true) die("--config 需要下载配置 JSON 文件路径");
  if (configPath) {
    const revision = opt("revision");
    if (revision === undefined || revision === true || !/^\d+$/.test(String(revision))) die("先用 downloads --version 查看配置，再带 --revision <返回的修订号> 保存，避免覆盖其他修改");
    const r = await api(`/api/versions/${version}/downloads`, { config: JSON.parse(readFileSync(configPath, "utf8")), revision: Number(revision) });
    console.log(`✓ 下载材料已保存（revision ${r.revision}）\n${r.manage_url}`);
  } else console.log(JSON.stringify(await api(`/api/versions/${version}/downloads`), null, 2));
} else if (isMain && cmd === "pull") {
  // 原样取回（#7574）：字节与上传时一致、逐个比 sha256；不走 /v/（会注入 SDK）也不走 /d/（只放行下载设置里的文件）。
  const proposal = opt("proposal"); const out = opt("out"); let vid = opt("version");
  if (!proposal || proposal === true) die("缺 --proposal <id>");
  if (!out || out === true) die("缺 --out <目录>（取回的文件写到这里；必须不存在或是空目录）");
  if (vid === true) die("--version 需要版本 id");
  let current = null;
  if (!vid) {
    const p = ((await api("/api/proposals")).proposals || []).find((x) => x.id === proposal);
    if (!p) die(`找不到方案 ${proposal}（或它不在这把令牌所在的工作区）`);
    if (!p.currentVersionId) die(`方案 ${proposal} 还没有生效版本；用 --version <id> 指定要取的那一版`);
    vid = current = p.currentVersionId;
  }
  const v = await api(`/api/versions/${vid}`);
  if (v.version.proposalId !== proposal) die(`版本 ${vid} 不属于方案 ${proposal}`);
  const dir = resolve(out);
  if (existsSync(dir) && readdirSync(dir).length) die(`${out} 不是空目录 —— 为免覆盖本地改动，换一个目录或先清空`);
  const mOut = resolve(opt("manifest-out") && opt("manifest-out") !== true ? opt("manifest-out") : join(dir, "manifest.json"));
  const files = v.artifacts.filter((a) => a.status === "ok");
  if (files.some((a) => resolve(dir, a.path) === mOut)) die("包里本身就有同名的 manifest.json；用 --manifest-out <包外路径> 另存");
  for (const a of files) {
    if (!a.path || a.path.includes("\\") || a.path.split("/").some((x) => !x || x === "." || x === "..")) die(`服务端返回了不安全的路径：${a.path}`);
    const r = await fetch(`${BASE}/api/versions/${vid}/files/${a.path.split("/").map(encodeURIComponent).join("/")}`, { headers: { authorization: `Bearer ${TOKEN}`, "x-space-cli": String(CLI_VERSION) } }).catch((e) => die(`${a.path} 网络失败：${e.message}`));
    if (!r.ok) { const e = (await r.json().catch(() => ({}))).error || {}; die(`${a.path} 取回失败 ${e.code || r.status}${e.message ? `：${e.message}` : ""}`); }
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length !== a.size) die(`${a.path} 大小不符（${buf.length} ≠ ${a.size}）`);
    if (a.sha256 && createHash("sha256").update(buf).digest("hex") !== a.sha256) die(`${a.path} sha256 与平台记录不符 —— 没写盘，重试一次`);
    mkdirSync(dirname(join(dir, a.path)), { recursive: true });
    writeFileSync(join(dir, a.path), buf);
  }
  // 下载设置有自己的修订号与接口（downloads 命令），不跟 manifest 走：push 时省略 = 沿用当前版。
  const { downloadRevision: _rev, downloads, ...manifest } = v.version.manifest || {};
  mkdirSync(dirname(mOut), { recursive: true });
  writeFileSync(mOut, JSON.stringify(manifest, null, 2) + "\n");
  const dl = downloads && ((downloads.attachments || []).length || downloads.source) ? `\n  下载设置不写进 manifest，上传时沿用当前版；查看：node space-cli.mjs downloads --version ${vid}` : "";
  console.log(`✓ 取回第 ${v.version.seq} 版${current ? "（当前生效版）" : ""}：${files.length} 个文件 → ${out}\n  manifest → ${relative(process.cwd(), mOut) || mOut}${dl}\n  改完再传：node space-cli.mjs push ${out} --proposal ${proposal} --manifest ${relative(process.cwd(), mOut) || mOut} --hold\n  version_id: ${vid}`);
} else if (isMain && cmd === "publish") {
  const v = opt("version");
  if (!v || v === true) die("缺 --version <id>");
  const r = await api(`/api/versions/${v}/publish`, { note: opt("note") === true ? undefined : opt("note"), ...tagArg() });
  console.log(`✓ 客户可见版已切到 version ${r.version_id}（proposal ${r.proposal_id}）`);
} else if (isMain && cmd === "share") {
  const p = opt("proposal"); const name = opt("name");
  if (!p || p === true) die("缺 --proposal <id>");
  const r = await api("/api/share-links", { proposal_id: p, recipient_name: name && name !== true ? name : undefined, recipient_title: opt("title") === true ? undefined : opt("title"), expires_in_days: opt("days") === true || !opt("days") ? undefined : Number(opt("days")), passcode: opt("passcode") === true || !opt("passcode") ? undefined : String(opt("passcode")), allow_download: !has("no-download"), allow_comment: !has("no-comment") });
  console.log(`✓ ${name} 的专属链接（到期 ${String(r.expires_at).slice(0, 10)}）：\n${r.url}\n发微信卡片：打开 ${r.card_url} 长按识别二维码进入方案页，再转发给客户（链接当文字直接发会被降级为裸链接）\nlink_id: ${r.link_id}`);
} else if (isMain && cmd === "data") {
  // 数据表（#7622）：挂在方案上、不随版本。pull / push / delete 三个子命令都只碰表，不碰版本与 manifest。
  const sub = args[1];
  const proposal = opt("proposal");
  if (!["pull", "push", "delete"].includes(sub)) die("用法：space-cli.mjs data pull|push|delete …（见文件头）");
  if (!proposal || proposal === true) die("缺 --proposal <id>");
  const table = opt("table");
  const tablePath = (name) => `/api/proposals/${proposal}/data/${encodeURIComponent(name)}`;
  if (sub === "pull") {
    const out = opt("out");
    if (!out || out === true) die("缺 --out <目录>（每张表写成 <表名>.csv；--json 则写 .json）");
    if (table === true) die("--table 需要表名");
    const asJson = has("json");
    const listed = await api(`/api/proposals/${proposal}/data`);
    const names = table ? [table] : listed.tables.map((t) => t.table);
    if (!names.length) { console.log(`方案 ${proposal} 还没有数据表。建一张：node space-cli.mjs data push <file.csv> --proposal ${proposal} --table <name>`); process.exit(0); }
    const dir = resolve(out);
    mkdirSync(dir, { recursive: true });
    const lines = [];
    for (const name of names) {
      if (asJson) {
        const t = await api(tablePath(name));
        writeFileSync(join(dir, `${name}.json`), JSON.stringify({ columns: t.columns, rows: t.rows }, null, 2) + "\n");
        lines.push(`  ${name}.json  revision ${t.revision} · ${t.row_count} 行`);
      } else {
        const r = await fetch(`${BASE}${tablePath(name)}?format=csv`, { headers: { authorization: `Bearer ${TOKEN}`, "x-space-cli": String(CLI_VERSION) } }).catch((e) => die(`${name} 网络失败：${e.message}`));
        if (!r.ok) { const e = (await r.json().catch(() => ({}))).error || {}; die(`${name} 取回失败 ${e.code || r.status}${e.message ? `：${e.message}` : ""}`); }
        writeFileSync(join(dir, `${name}.csv`), await r.text());
        lines.push(`  ${name}.csv  revision ${r.headers.get("x-data-revision")}`);
      }
    }
    console.log(`✓ 取回 ${names.length} 张数据表 → ${out}（方案数据修订 ${listed.data_revision}）\n${lines.join("\n")}\n  改完推回：node space-cli.mjs data push ${out}/<表名>.csv --proposal ${proposal} --table <表名> --revision <上面的修订号>\n  ${listed.limits_text}`);
  } else if (sub === "push") {
    const file = args[2] && !args[2].startsWith("--") ? args[2] : null;
    if (!file) die("用法：data push <file.csv|file.json> --proposal <id> --table <name> [--revision <n>]");
    if (!table || table === true) die("缺 --table <name>（小写字母开头，只含字母、数字、下划线）");
    const rev = opt("revision", "0");
    if (rev === true || !/^\d+$/.test(String(rev))) die("--revision 要是不小于 0 的整数：新建传 0（缺省）；改已有的表带 data pull 看到的修订号");
    const text = readFileSync(file, "utf8");
    const ext = extname(file).toLowerCase();
    let body;
    if (ext === ".json") {
      const parsed = JSON.parse(text);
      body = Array.isArray(parsed) ? { rows: parsed } : { rows: parsed.rows, columns: parsed.columns, append_open: parsed.append_open, members_only: parsed.members_only, identity: parsed.identity, identity_visibility: parsed.identity_visibility, per_reader: parsed.per_reader, vote_key: parsed.vote_key };
    } else if (ext === ".csv") body = { csv: text };
    else die(`只认 .csv 或 .json：${file}`);
    const r = await api(tablePath(table), { revision: Number(rev), ...body }, "PUT");
    console.log(`✓ 表 ${r.table} ${r.created ? "已建" : "已替换"}：revision ${r.revision} · ${r.row_count} 行 · ${r.columns.length} 列（方案数据修订 ${r.data_revision}）\n  页面不用重发，刷新即见新数据。下次修改带 --revision ${r.revision}。\n  ${r.limits_text}`);
  } else {
    const rev = opt("revision");
    if (!table || table === true) die("缺 --table <name>");
    if (rev === undefined || rev === true || !/^\d+$/.test(String(rev))) die("删表必须带 --revision <修订号>（先 data pull 看），避免删掉别人刚改过的那一版");
    const r = await api(`${tablePath(table)}?revision=${Number(rev)}`, undefined, "DELETE");
    console.log(`✓ 表 ${r.table} 已删除（方案数据修订 ${r.data_revision}）。页面不用重发。`);
  }
}
// ── watch（PPH0）：挂着等页面新反馈。连 GET /api/proposals/:id/feedback/stream（SSE），一条一行 JSON；游标落盘，断了接着读。
/** 把 SSE 文本拆成块：返回 [完整块…] 与剩下没收完的尾巴。注释块（`: ping`）返回 {comment:true}。 */
export const sseBlocks = (buf) => {
  const out = [];
  let idx;
  while ((idx = buf.indexOf("\n\n")) >= 0) {
    const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
    if (!block.trim()) continue;
    if (block.startsWith(":")) { out.push({ comment: true }); continue; }
    const ev = {};
    for (const line of block.split("\n")) {
      const m = /^(\w+): ?(.*)$/.exec(line);
      if (!m) continue;
      if (m[1] === "data") ev.data = (ev.data === undefined ? "" : ev.data + "\n") + m[2];
      else ev[m[1]] = m[2];
    }
    out.push(ev);
  }
  return { blocks: out, rest: buf };
};
export const watchCursorPath = (proposal, home = homedir()) => join(home, ".space", "watch", `${proposal}.cursor`);
if (isMain && cmd === "watch") {
  const target = args[1] && !args[1].startsWith("--") ? args[1] : null;
  const proposal = target && (/^[0-9A-HJKMNP-TV-Z]{26}$/.exec(target)?.[0] ?? /\/(?:p|app\/proposals)\/([0-9A-HJKMNP-TV-Z]{26})/.exec(target)?.[1]);
  if (!proposal) die("用法：space-cli.mjs watch <proposal_id> [--kinds row,thread] [--since <游标>] [--once]（proposal_id 来自 list_proposals）");
  const kinds = opt("kinds");
  if (kinds === true) die("--kinds 要写 row、thread 或 row,thread");
  const sinceOpt = opt("since");
  if (sinceOpt === true) die("--since 要写一个游标（上一次读到的那一条的 id）");
  const once = has("once");
  const cursorFile = watchCursorPath(proposal);
  let cursor = sinceOpt || (existsSync(cursorFile) ? readFileSync(cursorFile, "utf8").trim() || undefined : undefined);
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\n");
  const save = (c) => { try { mkdirSync(dirname(cursorFile), { recursive: true }); writeFileSync(cursorFile, c + "\n"); } catch { /* 落不了盘只是重启后从此刻起读 */ } };
  const IDLE_MS = 45_000; // 服务端每 15 秒一行 ping：45 秒一个字节都没有 = 连接已死，主动重连
  let backoff = 1, readyShown = false, got = 0, stopping = false;
  process.on("SIGINT", () => { stopping = true; process.exit(0); });
  for (;;) {
    const ctl = new AbortController();
    let idle = setTimeout(() => ctl.abort(), IDLE_MS);
    const kick = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), IDLE_MS); };
    let ended = "eof";
    try {
      const q = new URLSearchParams();
      if (cursor) q.set("since", cursor);
      if (kinds) q.set("kinds", String(kinds));
      const r = await fetch(`${BASE}/api/proposals/${proposal}/feedback/stream?${q}`, { headers: { authorization: `Bearer ${TOKEN}`, accept: "text/event-stream", "x-space-cli": String(CLI_VERSION) }, signal: ctl.signal });
      if (r.status === 429) { ended = "busy"; throw new Error("busy"); }
      if (!r.ok) {
        const e = (await r.json().catch(() => ({}))).error || {};
        console.error(`✗ ${e.code || r.status}: ${e.message || ""}${e.fix ? `\n  修法：${e.fix}` : ""}`);
        if (r.status === 422 && cursor && !sinceOpt) { console.error(`  （本地游标 ${cursorFile} 失效，删掉后从此刻起读）`); }
        process.exit(2);
      }
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "", batch = 0, onceTimer = null;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kick();
        const { blocks, rest } = sseBlocks(buf + dec.decode(value, { stream: true }));
        buf = rest;
        for (const b of blocks) {
          if (b.comment || !b.event) continue;
          if (b.event === "ready") {
            const d = JSON.parse(b.data);
            backoff = 1;
            if (!readyShown) { readyShown = true; line({ type: "ready", proposal, cursor: d.cursor }); }
            if (!cursor) { cursor = d.cursor; save(cursor); }
            if (once && batch) { process.exit(0); }
            continue;
          }
          const it = JSON.parse(b.data);
          line({ type: "event", ...it });
          cursor = it.id; save(cursor); got++; batch++;
          if (once && readyShown && !onceTimer) onceTimer = setTimeout(() => process.exit(0), 300); // 同一批再攒 300ms
        }
      }
    } catch (e) {
      if (ended !== "busy") ended = ctl.signal.aborted ? "idle" : (e?.cause?.code || e?.message || "error");
    } finally { clearTimeout(idle); }
    if (stopping) break;
    line({ type: "reconnect", after_s: backoff, cursor: cursor ?? null, why: ended });
    await new Promise((res) => setTimeout(res, backoff * 1000));
    backoff = Math.min(backoff * 2, 30);
  }
}
if (isMain && cmd === "serve") {
  const dir = args[1] && !args[1].startsWith("--") ? args[1] : null;
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) die("用法：space-cli.mjs serve <目录> [--port 8787] [--closed 表1,表2] [--manifest m.json]");
  const port = Number(opt("port", "8787"));
  if (!Number.isInteger(port) || port < 0 || port > 65535) die("--port 要是 0–65535 的整数（0 = 随便挑一个空闲端口）");
  const closedOpt = opt("closed");
  const closed = new Set(typeof closedOpt === "string" ? closedOpt.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const { createServer } = await import("node:http");
  const mPath = opt("manifest");
  const manifest = mPath && mPath !== true ? JSON.parse(readFileSync(mPath, "utf8")) : {};
  const server = createServer(createServeHandler(dir, { closed, manifest, log: (m) => console.log(m) }));
  server.listen(port, "127.0.0.1", () => {
    const at = `http://127.0.0.1:${server.address().port}`;
    const tables = existsSync(join(dir, "_data")) ? readdirSync(join(dir, "_data")).filter((f) => /\.json$/.test(f)).map((f) => f.slice(0, -5)) : [];
    console.log(`✓ 本地活页：${at}/  （目录 ${resolve(dir)}，与内容域同一份 CSP；Ctrl+C 停）`);
    console.log(`  数据表（_data/）：${tables.length ? tables.map((t) => `${t}${closed.has(t) ? "（没开写回）" : ""}`).join("、") : "无"}${tables.length ? "  —— 写回会追加进这些文件" : ""}`);
    console.log("  没模拟的：阅读统计 / 回放 / 目录胶囊（依赖壳页）；内容审核与限频（线上的写回会过审、可能 held）");
  });
}
