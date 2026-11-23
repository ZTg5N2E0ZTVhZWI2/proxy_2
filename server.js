import express from "express";
import * as cheerio from "cheerio";

const KEY = process.env.KEY;
const BASE = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
if (!KEY || !BASE) {
  console.error("環境変数 KEY と RENDER_EXTERNAL_URL(または PUBLIC_URL)が必要です");
  process.exit(1);
}
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// ---------- ユーティリティ ----------
const isPrivate = (h) =>
  /^(localhost$|127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[)/i.test(h) ||
  /\.(internal|local)$/i.test(h);

// 元サイトのURL → このサーバー経由のURL
const px = (u, base) => {
  if (!u || /^(#|data:|blob:|javascript:|about:)/i.test(u.trim())) return u;
  try {
    const abs = new URL(u, base).href;
    if (!/^https?:/.test(abs)) return u;
    return `${BASE}/r?key=${encodeURIComponent(KEY)}&url=${encodeURIComponent(abs)}`;
  } catch {
    return u;
  }
};

const rewriteCss = (css, base) =>
  css
    .replace(/url\(\s*(['"]?)(.*?)\1\s*\)/g, (m, q, u) => `url("${px(u, base)}")`)
    .replace(/@import\s+(['"])(.*?)\1/g, (m, q, u) => `@import "${px(u, base)}"`);

async function upstream(target, init = {}) {
  const u = new URL(target);
  if (!/^https?:$/.test(u.protocol) || isPrivate(u.hostname)) throw new Error("blocked");
  const r = await fetch(u, {
    redirect: "follow",
    ...init,
    headers: { "user-agent": UA, "accept-language": "ja,en;q=0.8", ...init.headers },
  });
  if (isPrivate(new URL(r.url).hostname)) throw new Error("blocked");
  return r;
}

// ---------- ブラウザ側で動くランタイム(HTMLに注入される) ----------
function runtime() {
  const S = window.__SJ;
  const px = (u) => {
    try {
      const a = new URL(u, S.base).href;
      if (!/^https?:/.test(a) || a.startsWith(S.proxy + "/")) return u;
      return `${S.proxy}/r?key=${encodeURIComponent(S.key)}&url=${encodeURIComponent(a)}`;
    } catch {
      return u;
    }
  };

  // fetch / XHR を Render 経由にする
  const f = window.fetch;
  window.fetch = (input, init) =>
    typeof input === "string" || input instanceof URL ? f(px(String(input)), init) : f(input, init);
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u, ...rest) {
    return open.call(this, m, px(String(u)), ...rest);
  };

  // 動的に作られる script / img / link
  const patch = (proto, prop) => {
    const d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      ...d,
      set(v) {
        d.set.call(this, px(String(v)));
      },
    });
  };
  patch(HTMLScriptElement.prototype, "src");
  patch(HTMLImageElement.prototype, "src");
  patch(HTMLLinkElement.prototype, "href");
  const sa = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (/^(src|href)$/i.test(n) && /^(SCRIPT|IMG|LINK|SOURCE|VIDEO|AUDIO)$/.test(this.tagName)) v = px(String(v));
    return sa.call(this, n, v);
  };

  // リンク・フォームは Apps Script 経由で開き直す
  const go = (u) => {
    const a = new URL(u, S.base).href;
    top.location.href = S.app + (S.app.includes("?") ? "&" : "?") + "url=" + encodeURIComponent(a);
  };
  document.addEventListener("click", (e) => {
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
    const h = a.getAttribute("href");
    if (!h || /^(#|javascript:|mailto:|tel:)/i.test(h)) return;
    e.preventDefault();
    go(h);
  });
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (e.defaultPrevented || (form.method || "get").toLowerCase() !== "get") return;
    e.preventDefault();
    const u = new URL(form.getAttribute("action") || S.base, S.base);
    u.search = new URLSearchParams(new FormData(form)).toString();
    go(u.href);
  });
}
const RUNTIME = `(${runtime.toString()})()`;

// ---------- HTML書き換え ----------
function rewriteHtml(html, base, appUrl) {
  const $ = cheerio.load(html);
  $("base").remove();
  $("meta[http-equiv]").filter((_, el) => /content-security-policy/i.test($(el).attr("http-equiv"))).remove();
  $("[integrity]").removeAttr("integrity");

  for (const attr of ["src", "poster", "data-src"]) {
    $(`[${attr}]`).each((_, el) => $(el).attr(attr, px($(el).attr(attr), base)));
  }
  $("link[href]").each((_, el) => $(el).attr("href", px($(el).attr("href"), base)));
  $("[srcset]").each((_, el) => {
    const v = $(el)
      .attr("srcset")
      .split(",")
      .map((s) => {
        const [u, d] = s.trim().split(/\s+/);
        return px(u, base) + (d ? " " + d : "");
      })
      .join(", ");
    $(el).attr("srcset", v);
  });
  // a / form は元URLの絶対URLにしておく(クリック時にランタイムが処理)
  $("a[href], area[href]").each((_, el) => {
    const h = $(el).attr("href");
    if (/^(#|javascript:|mailto:|tel:)/i.test(h)) return;
    try { $(el).attr("href", new URL(h, base).href); } catch {}
  });
  $("form[action]").each((_, el) => {
    try { $(el).attr("action", new URL($(el).attr("action"), base).href); } catch {}
  });
  $("style").each((_, el) => $(el).text(rewriteCss($(el).text(), base)));
  $("[style]").each((_, el) => $(el).attr("style", rewriteCss($(el).attr("style"), base)));

  const cfg = JSON.stringify({ base, proxy: BASE, key: KEY, app: appUrl }).replace(/</g, "\\u003c");
  $("head").prepend(`<script>window.__SJ=${cfg}</script><script>${RUNTIME}</script>`);
  return $.html();
}

// ---------- ルート ----------
const app = express();

app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  if (req.query.key !== KEY) return res.status(403).send("forbidden");
  next();
});
app.use(express.raw({ type: () => true, limit: "5mb" }));

// Apps Script が取りに来る入口:HTMLを書き換えて返す
app.get("/page", async (req, res) => {
  try {
    const r = await upstream(req.query.url, { headers: { accept: "text/html,*/*" } });
    const ct = r.headers.get("content-type") || "";
    if (!ct.includes("html")) {
      res.type(ct || "application/octet-stream").send(Buffer.from(await r.arrayBuffer()));
      return;
    }
    res.type("html").send(rewriteHtml(await r.text(), r.url, req.query.app || ""));
  } catch (e) {
    res.status(502).send("error: " + e.message);
  }
});

// ブラウザが JS / CSS / 画像 / fetch を取りに来る入口
app.all("/r", async (req, res) => {
  try {
    const hasBody = !["GET", "HEAD"].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length;
    const r = await upstream(req.query.url, {
      method: req.method,
      headers: {
        accept: req.get("accept") || "*/*",
        ...(req.get("content-type") && { "content-type": req.get("content-type") }),
      },
      body: hasBody ? req.body : undefined,
    });
    const ct = r.headers.get("content-type") || "application/octet-stream";
    const buf = Buffer.from(await r.arrayBuffer());
    res.status(r.status).set("content-type", ct).set("cache-control", "public, max-age=300");
    if (ct.includes("text/css")) return res.send(rewriteCss(buf.toString("utf8"), r.url));
    res.send(buf);
  } catch (e) {
    res.status(502).send("error: " + e.message);
  }
});

app.listen(process.env.PORT || 3000, () => console.log("listening"));
