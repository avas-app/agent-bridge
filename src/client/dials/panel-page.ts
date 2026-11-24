// The Dials panel served at GET /. One self-contained page: inline CSS and JS,
// no external requests, no build step. It talks only to the routes in the script
// and sends the key from location.search with every request.
// String.raw keeps regex backslashes as written; the page must not contain a backtick or a dollar-brace.
export const PANEL_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>Dials</title>
<style>
*{box-sizing:border-box}
:root{--ground:#0B0B0C;--surface:#141416;--raised:#1D1D20;--line:#26262A;--line2:#3A3A40;--text:#F2F2F0;--muted:#A1A1A6;--live:#C6F432;--changed:#FF9F43;--bad:#FF7A7A;--sans:'IBM Plex Sans',system-ui,sans-serif;--mono:'IBM Plex Mono',ui-monospace,monospace}
html,body{margin:0;padding:0}
body{background:var(--ground);color:var(--text);font:14px/1.45 var(--sans);height:100vh;display:flex;flex-direction:column;overflow:hidden}
button,input,textarea{font:inherit;color:inherit}
button{cursor:pointer}
button:disabled{opacity:.45;cursor:default}
:focus{outline:none}
:focus-visible{outline:2px solid var(--live);outline-offset:2px}
[hidden]{display:none!important}
.mono{font-family:var(--mono)}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
h1,h2,h3{margin:0}

.top{display:flex;align-items:center;gap:16px;padding:0 20px;min-height:52px;border-bottom:1px solid var(--line);background:var(--surface);flex:none;flex-wrap:wrap}
.brand{font-weight:700;font-size:15px}
.app{font:12px var(--mono);color:var(--muted)}
.seg{display:flex;border:1px solid var(--line2);border-radius:4px;overflow:hidden}
.seg button{border:0;background:transparent;color:var(--muted);font-size:12px;padding:5px 10px}
.seg button[aria-pressed=true]{background:var(--line);color:var(--text)}
.devs{display:flex;gap:6px;flex-wrap:wrap}
.dev{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:5px 10px;border-radius:4px;border:1px solid var(--line2);background:transparent;color:var(--muted)}
.dev[aria-pressed=true]{border-color:var(--live);background:var(--raised);color:var(--text)}
.dev i{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--muted)}
.dev[aria-pressed=true] i{background:var(--live);border-color:var(--live)}
.count{margin-left:auto;font:12px var(--mono);color:var(--changed)}
.count.none{color:var(--muted)}
.btn{font-size:13px;padding:7px 12px;border-radius:4px;border:1px solid var(--line2);background:transparent;color:var(--text)}
.btn:hover:not(:disabled){background:var(--raised)}
.btn.primary{background:var(--live);color:var(--ground);border:0;font-weight:600;padding:8px 14px}
.btn.primary:hover:not(:disabled){background:#D4FF55}
.btn.sm{font-size:12px;padding:5px 9px;color:var(--muted)}
.btn.sm:hover:not(:disabled){color:var(--text)}
#status{padding:8px 20px;font-size:13px;background:var(--bad);color:var(--ground);font-weight:500;flex:none}

.shell{flex:1;min-height:0;display:grid}
.shell.el{grid-template-columns:240px minmax(0,1fr) 380px}
.shell.one{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
nav{border-right:1px solid var(--line);background:var(--surface);padding:14px 0;display:flex;flex-direction:column;gap:2px;overflow:auto}
.filter{padding:0 14px 10px}
.filter input,.field{width:100%;font-size:13px;padding:7px 10px;border-radius:4px;border:1px solid var(--line2);background:var(--ground);color:var(--text)}
.field.mono{font-family:var(--mono)}
::placeholder{color:var(--muted);opacity:1}
.sec{padding:14px 14px 6px;font:11px var(--mono);color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.sec:first-child{padding-top:6px}
.navi{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px 14px;font-size:13px;color:var(--text);background:transparent;border:0;text-align:left;width:100%}
.navi:hover{background:var(--raised)}
.navi .n{font:11px var(--mono);color:var(--changed)}
.navi[aria-current=true]{background:var(--live);color:var(--ground);font-weight:600}
.navi[aria-current=true] .n{color:var(--ground)}
.empty{padding:28px 20px;color:var(--muted);font-size:13px}

main{padding:28px 36px;display:flex;flex-direction:column;gap:32px;overflow:auto;min-width:0}
.mh{display:flex;align-items:baseline;justify-content:space-between;gap:12px;flex-wrap:wrap}
.mh h1{font-size:24px;font-weight:600}
.shell.one .mh h1{font-size:28px}
.sub{font:12px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.mh .col{display:flex;flex-direction:column;gap:4px;min-width:0}
.big{display:flex;align-items:baseline;gap:14px}
.big .was{font:13px var(--mono);color:var(--changed)}
.big .v{font:600 44px/1 var(--mono);color:var(--live);overflow-wrap:anywhere}

.dial{display:flex;flex-direction:column;gap:12px;padding:16px;margin:-16px;border-radius:6px}
.dial:hover,.dial:focus-within{background:var(--surface);box-shadow:inset 0 0 0 1px var(--live)}
.dh{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
.dh h3{font-size:14px;font-weight:600}
.dh .src{display:block;font:11px var(--mono);color:var(--muted);margin-top:2px;overflow-wrap:anywhere}
.dv{display:flex;align-items:center;gap:8px;font:12px var(--mono)}
.dv .now{color:var(--live)}
.dv .was{color:var(--muted)}
.dial.changed .dv .was{color:var(--changed)}

.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(92px,1fr));gap:8px}
.tile{min-height:64px;border-radius:4px;border:1px solid var(--line);background:var(--ground);color:var(--text);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:8px}
.shell.el .tile{background:var(--surface)}
.tile:hover{border-color:var(--line2)}
.tile .t{font-size:15px;overflow-wrap:anywhere;text-align:center}
.tile.w .t{font-size:24px}
.tile .s{font:11px var(--mono);color:var(--muted);min-height:15px}
.tile.orig{border:1px dashed var(--changed)}
.tile.orig .s{color:var(--changed)}
.tile.on{border:2px solid var(--live);background:var(--raised)}
.tile.on .s{color:var(--live)}

.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(118px,1fr));gap:8px}
.card{border-radius:4px;border:1px solid var(--line);background:var(--surface);color:var(--text);padding:0;overflow:hidden;text-align:left;display:flex;flex-direction:column;min-width:0}
.card:hover{border-color:var(--line2)}
.card .pv{height:40px;display:flex;align-items:center;justify-content:center;border-bottom:1px solid var(--line);font:600 18px var(--mono);color:var(--text);background:var(--ground)}
.card .meta{padding:7px 8px;display:flex;flex-direction:column;gap:1px;min-width:0}
.card .nm{font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .pa{font:10px var(--mono);color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card .vl{font:11px var(--mono);color:var(--muted)}
.card.orig{border:1px dashed var(--changed)}
.card.on{border:2px solid var(--live);background:var(--raised)}
.card.on .vl{color:var(--live)}

.thumb{height:130px;background:#F7F8F5;display:flex;align-items:center;justify-content:center;padding:6px;border-bottom:1px solid var(--line)}
.thumb img{max-width:100%;max-height:100%;object-fit:contain}
.thumb span{font-size:20px;font-weight:600;color:#1E3A2B}
.card .row{display:flex;justify-content:space-between;gap:6px;padding:8px 10px;font-size:13px}
.card .row .tag{font:11px var(--mono);color:var(--muted)}
.card.orig .row .tag{color:var(--changed)}
.card.on .row .tag{color:var(--live)}

.rg{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:3px;margin:8px 0;background:var(--line)}
.rg::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:4px;background:var(--live);border:0}
.rg::-moz-range-thumb{width:18px;height:18px;border-radius:4px;background:var(--live);border:0}
.rg:focus-visible{outline-offset:6px}
.ticks{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--muted)}
.nrow{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.sq{width:44px;height:44px;border-radius:4px;border:1px solid var(--line2);background:var(--surface);font-size:18px;color:var(--text)}
.sq:hover{background:var(--raised)}
.lbl{display:flex;align-items:center;gap:8px;font-size:13px;color:var(--muted)}
.lbl .field{width:84px;font:14px var(--mono);padding:10px}

.sw{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.sw input[type=color]{width:44px;height:44px;padding:0;border:1px solid var(--line2);border-radius:4px;background:none;cursor:pointer}
.sw .field{width:120px;font:14px var(--mono);padding:10px}
.gh{font:11px var(--mono);color:var(--muted);letter-spacing:.08em;text-transform:uppercase}

.switch{display:inline-flex;align-items:center;gap:10px;background:none;border:0;padding:4px 0;color:var(--text)}
.switch .tr{width:44px;height:24px;border-radius:12px;background:var(--line);border:1px solid var(--line2);position:relative}
.switch .tr:after{content:"";position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--muted);transition:transform .12s}
.switch[aria-checked=true] .tr{background:var(--live);border-color:var(--live)}
.switch[aria-checked=true] .tr:after{transform:translateX(20px);background:var(--ground)}
.switch .tx{font:13px var(--mono)}

.own{display:flex;flex-direction:column;gap:2px;padding:12px;border-radius:6px;border:1px solid var(--line);background:var(--surface)}
.own .gh{padding-bottom:6px}
.own button{display:flex;justify-content:space-between;gap:10px;font-size:13px;padding:7px 0;background:none;border:0;color:var(--text);text-align:left}
.own button .n{font:11px var(--mono);color:var(--changed)}
.own button:hover{text-decoration:underline}

aside.crops{border-left:1px solid var(--line);background:var(--surface);padding:18px;display:flex;flex-direction:column;gap:16px;overflow:auto;min-width:0}
.shell.one .crops{border:0;background:transparent;padding:0}
.cdev{display:flex;flex-direction:column;gap:12px}
.cap{font:11px var(--mono);color:var(--muted);letter-spacing:.08em;text-transform:uppercase}
.pair{display:grid;gap:12px}
.shell.one .pair{grid-template-columns:repeat(2,minmax(0,1fr))}
.shot{display:flex;flex-direction:column;gap:6px;min-width:0}
.shot .cap.live{color:var(--live)}
.frame{border-radius:6px;border:1px solid var(--line);background:var(--ground);min-height:120px;display:flex;align-items:center;justify-content:center;padding:6px;overflow:hidden}
.frame img{display:block;max-width:100%;max-height:260px;object-fit:contain;border-radius:2px}
.frame.after{border:2px solid var(--live)}
.frame .none{font-size:13px;color:var(--muted)}
.cact{display:flex;gap:8px;flex-wrap:wrap}
.cerr{font-size:13px;color:var(--bad)}
.shell.one main{padding:32px 40px}
.strip{display:flex;gap:6px;padding:12px 20px;border-bottom:1px solid var(--line);overflow-x:auto}
.chip{flex:none;display:inline-flex;align-items:center;gap:8px;padding:7px 12px;border-radius:4px;border:1px solid var(--line2);font-size:13px;color:var(--text);background:transparent}
.chip:hover{background:var(--raised)}
.chip .pvw{font:11px var(--mono);color:var(--muted);max-width:60px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.chip .sq2{width:14px;height:14px;border-radius:3px;border:1px solid var(--line2)}
.chip .dot{width:6px;height:6px;border-radius:50%;background:var(--changed)}
.chip[aria-current=true]{background:var(--live);border-color:var(--live);color:var(--ground);font-weight:600}
.chip[aria-current=true] .pvw{color:var(--ground)}
.chip[aria-current=true] .dot{background:var(--ground)}

#drawer{position:fixed;top:0;right:0;bottom:0;width:420px;max-width:100%;background:var(--surface);border-left:1px solid var(--line);padding:22px;display:flex;flex-direction:column;gap:16px;overflow:auto;box-shadow:-12px 0 32px rgba(0,0,0,.5);z-index:5}
#drawer .dt{display:flex;justify-content:space-between;align-items:center;gap:8px}
#drawer h2{font-size:18px;font-weight:600}
.list{display:flex;flex-direction:column;border:1px solid var(--line);border-radius:4px}
.item{display:grid;grid-template-columns:20px minmax(0,1fr) auto;gap:10px;align-items:center;padding:12px;border-bottom:1px solid var(--line)}
.item:last-child{border-bottom:0}
.item input{accent-color:var(--live);width:16px;height:16px}
.item .a{display:flex;flex-direction:column;gap:2px;min-width:0}
.item .a span:first-child{font-size:13px}
.item .a span+span{font:11px var(--mono);color:var(--muted);overflow-wrap:anywhere}
.item .d{font:12px var(--mono);display:flex;align-items:center;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.item .d b{color:var(--live);font-weight:500}
.item .d i{width:11px;height:11px;border-radius:2px;border:1px solid var(--line2);display:inline-block}
.fl{display:flex;flex-direction:column;gap:6px;font-size:13px;color:var(--muted)}
.fl textarea{resize:vertical;min-height:70px;padding:10px;border-radius:4px;border:1px solid var(--line2);background:var(--ground);color:var(--text);font-size:13px}
.ck{display:flex;align-items:center;gap:10px;font-size:13px}
.ck input{accent-color:var(--live);width:16px;height:16px}
.cstat{margin-top:auto;border-top:1px solid var(--line);padding-top:14px;display:flex;flex-direction:column;gap:10px}
.steps{display:flex;gap:6px;flex-wrap:wrap}
.step{font:11px var(--mono);padding:4px 8px;border-radius:4px;border:1px solid var(--line2);color:var(--muted)}
.step.done{color:var(--text);border-color:var(--text)}
.step.now{background:var(--live);border-color:var(--live);color:var(--ground)}
.step.bad{background:var(--bad);border-color:var(--bad);color:var(--ground)}

@media (max-width:699px){
  body{height:auto;min-height:100vh;overflow:auto}
  .top{padding:10px 16px;gap:10px;position:sticky;top:0;z-index:3}
  .seg,.app,.count,#resetAll,#copy{display:none}
  #commitBtn{margin-left:auto}
  #status{padding:8px 16px}
  .shell.el,.shell.one{display:flex;flex-direction:column}
  nav{border-right:0;border-bottom:1px solid var(--line);padding:12px 16px;flex-direction:row;gap:6px;overflow-x:auto}
  nav .filter,nav .sec{display:none}
  #navlist{display:flex;gap:6px}
  .navi{width:auto;flex:none;padding:8px 12px;border:1px solid var(--line2);border-radius:4px;gap:8px}
  main,.shell.one main{padding:18px 16px;overflow:visible;gap:28px}
  .dial{margin:-12px;padding:12px}
  aside.crops{border-left:0;border-top:1px solid var(--line);padding:16px}
  .shell.one .pair,.pair{grid-template-columns:repeat(2,minmax(0,1fr))}
  .frame img{max-height:180px}
  #drawer{width:100%;border-left:0}
}
</style>
</head>
<body>
<header class="top">
  <span class="brand">Dials</span>
  <span class="app" id="app"></span>
  <div class="seg" id="layoutSeg" role="group" aria-label="Layout">
    <button type="button" data-l="element" aria-pressed="true">By element</button>
    <button type="button" data-l="dial" aria-pressed="false">One dial</button>
  </div>
  <div class="devs" id="devs" role="group" aria-label="Devices"></div>
  <span class="count none" id="count" role="status"></span>
  <button type="button" class="btn" id="resetAll">Reset all</button>
  <button type="button" class="btn" id="copy">Copy values</button>
  <button type="button" class="btn primary" id="commitBtn" aria-haspopup="dialog">Commit</button>
</header>
<div id="status" role="alert" hidden></div>
<div class="shell el" id="shell"></div>
<aside id="drawer" role="dialog" aria-modal="false" aria-labelledby="dtitle" hidden></aside>
<script>
(function () {
  "use strict"
  var KEY = new URLSearchParams(location.search).get("key") || ""
  var NARROW = window.matchMedia("(max-width:699px)")
  var $ = function (id) { return document.getElementById(id) }

  function add(el, kids) {
    if (kids == null || kids === false) return
    if (!Array.isArray(kids)) kids = [kids]
    kids.forEach(function (c) {
      if (c == null || c === false) return
      if (Array.isArray(c)) add(el, c)
      else el.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)))
    })
  }
  function h(tag, attrs, kids) {
    var el = document.createElement(tag)
    if (attrs) for (var k in attrs) {
      var v = attrs[k]
      if (v == null || v === false) continue
      if (k === "class") el.className = v
      else if (k === "text") el.textContent = v
      else if (k === "style") el.style.cssText = v
      else if (k.slice(0, 2) === "on") el.addEventListener(k.slice(2), v)
      else el.setAttribute(k, v === true ? "" : v)
    }
    add(el, kids)
    return el
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild) }

  var S = {
    data: { devices: [], dials: [], tokens: null, labels: {}, commit: null, capture: null, app: "" },
    loaded: false,
    layout: "element",
    sec: null, el: null, dialId: null, active: null,
    filter: "", off: {},
    local: {}, touched: {}, pend: {},
    caps: {}, thumbs: {}, busyVar: {},
    commitOpen: false, sel: {}, note: "", revert: false, posting: false,
    copied: false, mainSig: "", ctl: {}
  }
  try { var saved = localStorage.getItem("dials.layout"); if (saved === "dial" || saved === "element") S.layout = saved } catch (e) {}

  /* ---------- api ---------- */
  function api(method, path, body) {
    var opts = { method: method, headers: { "x-dials-key": KEY } }
    if (body !== undefined) { opts.headers["content-type"] = "application/json"; opts.body = JSON.stringify(body) }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) throw new Error("Unauthorized. Reopen the panel URL with its key.")
      return r.json().catch(function () { return {} }).then(function (j) {
        if (!r.ok) throw new Error((j && j.error) || "HTTP " + r.status)
        return j
      })
    })
  }
  var statusEl = $("status")
  function showError(msg) { statusEl.textContent = msg; statusEl.hidden = false }
  function clearError() { statusEl.hidden = true }

  /* ---------- helpers ---------- */
  function devs() {
    var names = S.data.devices.map(function (d) { return d.name })
    var on = names.filter(function (n) { return !S.off[n] })
    return on.length === names.length || !on.length ? undefined : on
  }
  function dials() { return S.data.dials }
  function find(id) { var l = dials(); for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i]; return null }
  function eq(a, b) {
    if (typeof a === "string" && typeof b === "string") return a.toLowerCase() === b.toLowerCase()
    return JSON.stringify(a) === JSON.stringify(b)
  }
  function changed(d) { return !eq(d.value, d.original) }
  function humanize(s) {
    var t = String(s).replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[._-]+/g, " ").trim().toLowerCase()
    return t.charAt(0).toUpperCase() + t.slice(1)
  }
  function lab(d) { return d.label || humanize(String(d.id).split(".").slice(-1)[0]) }
  function split(d) {
    var g = d.group || "", i = g.indexOf("/")
    if (i < 0) return { sec: g || "General", el: g || "General" }
    var s = g.slice(0, i).trim() || "General"
    return { sec: s, el: g.slice(i + 1).trim() || s }
  }
  function isColor(v) { return typeof v === "string" && /^(#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})|(rgb|hsl)a?\(.*\))$/i.test(v.trim()) }
  function hex6(v) {
    var m = /^#([0-9a-f]{3})$/i.exec(v || "")
    if (m) return "#" + m[1].split("").map(function (c) { return c + c }).join("").toLowerCase()
    m = /^#([0-9a-f]{6})/i.exec(v || "")
    return m ? "#" + m[1].toLowerCase() : "#000000"
  }
  function isWeightOpts(o) { return o && o.length && o.every(function (x) { return /^([1-9]00|normal|bold|ultralight|thin|light|regular|medium|semibold|heavy|black)$/i.test(String(x)) }) }
  function wnum(x) {
    var m = { thin: 100, ultralight: 200, light: 300, normal: 400, regular: 400, medium: 500, semibold: 600, bold: 700, heavy: 800, black: 900 }
    return m[String(x).toLowerCase()] || Number(x) || 400
  }

  /* tokens */
  function tokenInfo() {
    var t = S.data.tokens, labels = S.data.labels || {}
    if (t && typeof t === "object" && t.tokens && typeof t.tokens === "object" && !Array.isArray(t.tokens)) {
      var m = {}
      for (var k in (t.labels || {})) m[k] = t.labels[k]
      for (var k2 in labels) m[k2] = labels[k2]
      return { tree: t.tokens, labels: m }
    }
    return { tree: t && typeof t === "object" ? t : null, labels: labels }
  }
  var flatCache = { tree: null, list: [] }
  function flat() {
    var info = tokenInfo()
    if (flatCache.tree === info.tree) return flatCache.list
    var out = []
    ;(function walk(node, path) {
      if (node && typeof node === "object" && !Array.isArray(node)) {
        Object.keys(node).forEach(function (k) { walk(node[k], path ? path + "." + k : k) })
      } else if (typeof node === "string" || typeof node === "number") out.push({ path: path, value: node })
    })(info.tree, "")
    flatCache = { tree: info.tree, list: out }
    return out
  }
  function tokenLabel(path) {
    var l = tokenInfo().labels
    return (l && l[path]) || String(path).split(".").slice(-1)[0]
  }
  function tokenValue(path) {
    var l = flat()
    for (var i = 0; i < l.length; i++) if (l[i].path === path) return l[i].value
    return undefined
  }
  function fmt(d, v) {
    if (v === undefined || v === null) return ""
    if (d.type === "boolean") return v ? "on" : "off"
    if (d.type === "token") return tokenLabel(v)
    if (d.type === "text") { var s = String(v); return s.length > 24 ? s.slice(0, 23) + "…" : '"' + s + '"' }
    return String(v)
  }

  /* ---------- groups ---------- */
  function tree() {
    var secs = [], idx = {}
    var q = S.filter.toLowerCase()
    dials().forEach(function (d) {
      var g = split(d)
      if (q && (g.sec + " " + g.el + " " + lab(d) + " " + d.id).toLowerCase().indexOf(q) < 0) return
      var s = idx[g.sec]
      if (!s) { s = idx[g.sec] = { name: g.sec, els: [], byName: {} }; secs.push(s) }
      var e = s.byName[g.el]
      if (!e) { e = s.byName[g.el] = { name: g.el, sec: g.sec, dials: [] }; s.els.push(e) }
      e.dials.push(d)
    })
    return secs
  }
  function elementsOf(secs) { var o = []; secs.forEach(function (s) { s.els.forEach(function (e) { o.push(e) }) }); return o }
  function currentElement(secs) {
    var all = elementsOf(secs)
    for (var i = 0; i < all.length; i++) if (all[i].sec === S.sec && all[i].name === S.el) return all[i]
    return all[0] || null
  }
  function effLayout() { return NARROW.matches ? "element" : S.layout }
  function nChanged(list) { return list.filter(changed).length }

  /* ---------- sending ---------- */
  function post(id, value) {
    return api("POST", "/api/dials/set", { id: id, value: value, devices: devs() }).then(function (res) {
      var bad = ((res && res.results) || []).filter(function (r) { return r.ok === false })
      if (bad.length) showError(bad[0].device + ": " + bad[0].error)
      else clearError()
    }).catch(function (e) { showError(e.message) })
  }
  function setLocal(id, v) {
    var d = find(id)
    if (!d) return
    d.value = v
    S.local[id] = v
    S.touched[id] = Date.now()
    refreshValues()
  }
  function throttled(id, v) {
    setLocal(id, v)
    var st = S.pend[id] || (S.pend[id] = { t: null, last: 0, has: false, v: null })
    st.v = v; st.has = true
    if (st.t) return
    var wait = Math.max(0, 50 - (Date.now() - st.last))
    st.t = setTimeout(function () {
      st.t = null; st.last = Date.now()
      if (st.has) { st.has = false; post(id, st.v) }
    }, wait)
  }
  function release(id, v) {
    var st = S.pend[id]
    if (st) { if (st.t) clearTimeout(st.t); st.t = null; st.has = false; st.last = Date.now() }
    setLocal(id, v)
    var p = post(id, v)
    scheduleCapture(id)
    return p
  }
  function resetDial(id) { var d = find(id); if (d) release(id, d.original) }

  /* ---------- highlight ---------- */
  var hlT = null, hlId = null
  function highlight(id) {
    if (hlT) clearTimeout(hlT)
    hlT = setTimeout(function () {
      hlT = null
      if (id === hlId) return
      hlId = id
      api("POST", "/api/highlight", { id: id, devices: devs() }).catch(function () {})
    }, 60)
  }
  document.addEventListener("visibilitychange", function () { if (document.hidden) highlight(null) })

  /* ---------- capture ---------- */
  function capOf(id) { return S.caps[id] || (S.caps[id] = { before: {}, after: {}, err: "", busy: false, seq: 0 }) }
  function normRes(res) {
    if (Array.isArray(res)) return res
    if (res && Array.isArray(res.results)) return res.results
    if (res && (res.png || res.error)) return [res]
    return []
  }
  function union(r) {
    if (!Array.isArray(r)) return r
    if (!r.length) return null
    var x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    r.forEach(function (q) { x1 = Math.min(x1, q.x); y1 = Math.min(y1, q.y); x2 = Math.max(x2, q.x + q.width); y2 = Math.max(y2, q.y + q.height) })
    return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
  }
  function crop(r) {
    return new Promise(function (resolve, reject) {
      var png = String(r.png || "")
      var img = new Image()
      img.onload = function () {
        // Screenshot tools may return points or pixels; the window width tells which.
        var rect = union(r.rect), s = r.window && r.window.width ? img.width / r.window.width : r.scale || 1
        var x = 0, y = 0, w = img.width, hh = img.height
        if (rect && rect.width > 0 && rect.height > 0) {
          var pad = Math.round(8 * s)
          var x0 = Math.max(0, Math.round(rect.x * s) - pad), y0 = Math.max(0, Math.round(rect.y * s) - pad)
          var x1 = Math.min(img.width, Math.round((rect.x + rect.width) * s) + pad), y1 = Math.min(img.height, Math.round((rect.y + rect.height) * s) + pad)
          if (x1 > x0 && y1 > y0) { x = x0; y = y0; w = x1 - x0; hh = y1 - y0 }
        }
        var c = document.createElement("canvas")
        c.width = w; c.height = hh
        c.getContext("2d").drawImage(img, x, y, w, hh, 0, 0, w, hh)
        resolve(c.toDataURL("image/png"))
      }
      img.onerror = function () { reject(new Error("Bad screenshot")) }
      img.src = png.indexOf("data:") === 0 ? png : "data:image/png;base64," + png
    })
  }
  var capTimers = {}
  function scheduleCapture(id) {
    if (!S.data.capture && S.data.capture !== undefined && S.data.capture !== null) return
    if (capTimers[id]) clearTimeout(capTimers[id])
    capTimers[id] = setTimeout(function () { delete capTimers[id]; doCapture(id) }, 400)
  }
  function doCapture(id) {
    var d = find(id)
    if (!d) return Promise.resolve()
    var c = capOf(id), seq = ++c.seq, cur = d.value, atOriginal = eq(d.value, d.original)
    c.busy = true; drawCrops()
    return api("POST", "/api/capture", { id: id, devices: devs() }).then(function (res) {
      if (seq !== c.seq) return
      return Promise.all(normRes(res).map(function (r) {
        if (r.error || !r.png) return { dev: r.device, err: r.error || "No screenshot" }
        return crop(r).then(function (url) { return { dev: r.device, url: url } }, function (e) { return { dev: r.device, err: e.message } })
      })).then(function (out) {
        if (seq !== c.seq) return
        c.busy = false; c.err = ""
        out.forEach(function (o) {
          if (o.err) { c.err = (o.dev ? o.dev + ": " : "") + o.err; return }
          var rec = { url: o.url, v: cur }
          c.after[o.dev] = rec
          if (atOriginal && !c.before[o.dev]) c.before[o.dev] = rec
        })
        drawCrops()
      })
    }).catch(function (e) { if (seq !== c.seq) return; c.busy = false; c.err = e.message; drawCrops() })
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms) }) }
  function captureBefore(id) {
    var d = find(id)
    if (!d) return
    var cur = d.value
    if (eq(cur, d.original)) { doCapture(id); return }
    var c = capOf(id)
    c.busy = true; drawCrops()
    setLocal(id, d.original)
    post(id, d.original).then(function () { return wait(250) }).then(function () { return doCapture(id) }).then(function () {
      setLocal(id, cur)
      post(id, cur)
      scheduleCapture(id)
    })
  }
  function captureVariants(id) {
    S.busyVar[id] = true; S.mainSig = ""; renderMain()
    api("POST", "/api/capture-variants", { id: id, devices: devs() }).then(function (res) {
      var keys = Object.keys(res || {}), out = S.thumbs[id] || (S.thumbs[id] = {})
      return Promise.all(keys.map(function (k) {
        var r = normRes(res[k]).filter(function (x) { return x && x.png })[0]
        if (!r) return null
        return crop(r).then(function (url) { out[k] = url }, function () {})
      }))
    }).catch(function (e) { showError(e.message) }).then(function () {
      S.busyVar[id] = false; S.mainSig = ""; renderMain()
    })
  }

  /* ---------- controls ---------- */
  function ctlNumber(d, bare) {
    var range = h("input", { type: "range", class: "rg", "aria-label": lab(d) })
    var exact = h("input", { type: "text", class: "field", inputmode: "decimal", "aria-label": lab(d) + " exact value" })
    var back = h("button", { type: "button", class: "btn", onclick: function () { release(d.id, d.original) } })
    var lo = h("span"), hi = h("span")
    var minus = h("button", { type: "button", class: "sq", "aria-label": "Down", text: "−" })
    var plus = h("button", { type: "button", class: "sq", "aria-label": "Up", text: "+" })
    function bounds() {
      var v = Number(d.value) || 0
      var mn = d.min != null ? d.min : Math.min(0, v)
      var mx = d.max != null ? d.max : Math.max(100, Math.ceil(v * 2))
      var st = d.step || (mx - mn <= 2 ? 0.01 : 1)
      return { mn: mn, mx: mx, st: st }
    }
    function round(v, st) { var p = (String(st).split(".")[1] || "").length; return Number(v.toFixed(p)) }
    function clamp(v) { var b = bounds(); return Math.min(b.mx, Math.max(b.mn, round(v, b.st))) }
    function step(dir) { var b = bounds(); release(d.id, clamp(Number(d.value) + dir * b.st)) }
    minus.addEventListener("click", function () { step(-1) })
    plus.addEventListener("click", function () { step(1) })
    range.addEventListener("input", function () { throttled(d.id, Number(range.value)) })
    range.addEventListener("change", function () { release(d.id, Number(range.value)) })
    exact.addEventListener("change", function () {
      var n = Number(exact.value)
      if (isNaN(n)) { exact.value = String(d.value); return }
      release(d.id, round(n, bounds().st))
    })
    exact.addEventListener("keydown", function (e) { if (e.key === "Enter") exact.dispatchEvent(new Event("change")) })
    var el = h("div", { class: "num", style: "display:flex;flex-direction:column;gap:8px" }, [
      range, h("div", { class: "ticks" }, [lo, hi]),
      h("div", { class: "nrow" }, [minus, plus, h("label", { class: "lbl" }, ["Exact", exact]), h("span", { style: "margin-left:auto" }, back)])
    ])
    return { el: el, refresh: function (nd) {
      d = nd
      var b = bounds(), v = Number(d.value)
      range.min = b.mn; range.max = b.mx; range.step = b.st; range.value = v
      var pct = b.mx > b.mn ? Math.max(0, Math.min(100, (v - b.mn) / (b.mx - b.mn) * 100)) : 0
      range.style.background = "linear-gradient(to right,var(--live) 0 " + pct + "%,var(--line) " + pct + "% 100%)"
      lo.textContent = b.mn; hi.textContent = b.mx
      if (document.activeElement !== exact) exact.value = String(v)
      back.textContent = "Back to " + d.original
      back.hidden = !changed(d)
    } }
  }

  function tileOf(d, o, onpick) {
    var weight = isWeightOpts(d.options)
    var b = h("button", { type: "button", class: "tile" + (weight ? " w" : ""), "aria-pressed": "false", onclick: function () { onpick(o) } }, [
      h("span", { class: "t", text: weight ? "Aa" : String(o), style: weight ? "font-weight:" + wnum(o) : "" }),
      h("span", { class: "s" })
    ])
    return b
  }
  function ctlEnum(d) {
    var tiles = {}
    var el = h("div", { class: "tiles", role: "group", "aria-label": lab(d) }, (d.options || []).map(function (o) {
      var t = tileOf(d, o, function (v) { release(d.id, v) })
      if (isWeightOpts(d.options)) t.setAttribute("aria-label", String(o))
      tiles[o] = t
      return t
    }))
    return { el: el, refresh: function (nd) {
      d = nd
      Object.keys(tiles).forEach(function (k) {
        var t = tiles[k], on = String(d.value) === k, orig = String(d.original) === k
        t.className = "tile" + (isWeightOpts(d.options) ? " w" : "") + (on ? " on" : orig && changed(d) ? " orig" : "")
        t.setAttribute("aria-pressed", on ? "true" : "false")
        t.lastChild.textContent = on ? (isWeightOpts(d.options) ? k + " · live" : "live") : orig && changed(d) ? (isWeightOpts(d.options) ? k + " · original" : "original") : isWeightOpts(d.options) ? k : ""
      })
    } }
  }

  function ctlBool(d) {
    var tx = h("span", { class: "tx" })
    var b = h("button", { type: "button", role: "switch", class: "switch", "aria-label": lab(d) }, [h("span", { class: "tr" }), tx])
    b.addEventListener("click", function () { release(d.id, !d.value) })
    return { el: b, refresh: function (nd) {
      d = nd
      b.setAttribute("aria-checked", d.value ? "true" : "false")
      tx.textContent = (d.value ? "On" : "Off") + (changed(d) ? " · was " + (d.original ? "on" : "off") : "")
    } }
  }

  function ctlText(d) {
    var f = h("input", { type: "text", class: "field", "aria-label": lab(d) })
    f.addEventListener("input", function () { throttled(d.id, f.value) })
    f.addEventListener("change", function () { release(d.id, f.value) })
    return { el: f, refresh: function (nd) { d = nd; if (document.activeElement !== f) f.value = String(d.value == null ? "" : d.value) } }
  }

  function cardGrid(items, isOn, isOrig, pick, preview) {
    var el = h("div", { class: "cards", role: "group" })
    var nodes = items.map(function (it) {
      var b = h("button", { type: "button", class: "card", "aria-pressed": "false", onclick: function () { pick(it) } }, [
        preview(it),
        h("span", { class: "meta" }, [
          h("span", { class: "nm", text: it.name }),
          h("span", { class: it.path ? "pa" : "vl", text: it.path || "" }),
          h("span", { class: "vl", text: it.vtext })
        ])
      ])
      el.appendChild(b)
      return { it: it, b: b }
    })
    function paint() {
      nodes.forEach(function (n) {
        var on = isOn(n.it), orig = isOrig(n.it)
        n.b.className = "card" + (on ? " on" : orig ? " orig" : "")
        n.b.setAttribute("aria-pressed", on ? "true" : "false")
      })
    }
    return { el: el, paint: paint }
  }

  function ctlColor(d) {
    var info = tokenInfo()
    var colors = flat().filter(function (t) { return isColor(t.value) }).slice(0, 40)
    var pick = h("input", { type: "color", "aria-label": lab(d) + " colour picker" })
    var hex = h("input", { type: "text", class: "field mono", "aria-label": lab(d) + " hex value", maxlength: "9" })
    pick.addEventListener("input", function () { hex.value = pick.value; throttled(d.id, pick.value) })
    pick.addEventListener("change", function () { release(d.id, pick.value) })
    hex.addEventListener("change", function () { var v = hex.value.trim(); if (isColor(v)) release(d.id, v); else hex.value = String(d.value) })
    var grid = null
    if (colors.length) {
      grid = cardGrid(colors.map(function (t) { return { name: tokenLabel(t.path), path: t.path, value: t.value, vtext: String(t.value) } }),
        function (it) { return eq(it.value, d.value) }, function (it) { return eq(it.value, d.original) && changed(d) },
        function (it) { release(d.id, it.value) },
        function (it) { return h("span", { class: "pv", style: "background:" + it.value }) })
    }
    var el = h("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
      h("div", { class: "sw" }, [pick, hex]),
      grid ? [h("span", { class: "gh", text: (info.labels[colors[0].path.split(".")[0]] || colors[0].path.split(".")[0]) + " tokens" }), grid.el] : null
    ])
    return { el: el, refresh: function (nd) {
      d = nd
      pick.value = hex6(String(d.value))
      if (document.activeElement !== hex) hex.value = String(d.value)
      if (grid) grid.paint()
    } }
  }

  function tokenGroup(path) { return String(path).split(".")[0] }
  function ctlToken(d) {
    var info = tokenInfo()
    var grp = tokenGroup(d.tokenPath || d.original || "")
    var list = flat().filter(function (t) { return tokenGroup(t.path) === grp })
    if (!list.some(function (t) { return t.path === d.original })) list.unshift({ path: String(d.original), value: tokenValue(d.original) })
    var grid = cardGrid(list.map(function (t) { return { name: tokenLabel(t.path), path: t.path, value: t.value, vtext: t.value === undefined ? "" : String(t.value) } }),
      function (it) { return it.path === d.value }, function (it) { return it.path === d.original && changed(d) },
      function (it) { release(d.id, it.path) },
      function (it) {
        var v = it.value
        if (isColor(v)) return h("span", { class: "pv", style: "background:" + v })
        if (/weight/i.test(it.path)) return h("span", { class: "pv", style: "font-family:var(--sans);font-weight:" + wnum(v), text: "Aa" })
        return h("span", { class: "pv", text: v === undefined ? "?" : String(v) })
      })
    return { el: h("div", { style: "display:flex;flex-direction:column;gap:12px" }, [
      h("span", { class: "gh", text: (info.labels[grp] || grp) + " tokens" }), grid.el
    ]), refresh: function (nd) { d = nd; grid.paint() } }
  }

  function ctlVariant(d) {
    var thumbs = S.thumbs[d.id] || {}
    var items = (d.options || []).map(function (o) { return { name: String(o), url: thumbs[o] } })
    var nodes = {}
    var grid = h("div", { class: "cards", style: "grid-template-columns:repeat(auto-fill,minmax(150px,1fr))", role: "group", "aria-label": lab(d) }, items.map(function (it) {
      var b = h("button", { type: "button", class: "card", "aria-pressed": "false", onclick: function () { release(d.id, it.name) } }, [
        h("span", { class: "thumb" }, it.url ? h("img", { src: it.url, alt: it.name }) : h("span", { text: it.name })),
        h("span", { class: "row" }, [h("span", { text: it.name }), h("span", { class: "tag" })])
      ])
      nodes[it.name] = b
      return b
    }))
    var busy = !!S.busyVar[d.id]
    var cap = S.data.capture === false ? null : h("button", { type: "button", class: "btn", disabled: busy, onclick: function () { captureVariants(d.id) }, text: busy ? "Capturing…" : "Capture variants" })
    return { el: h("div", { style: "display:flex;flex-direction:column;gap:12px" }, [grid, cap ? h("div", { class: "cact" }, cap) : null]), refresh: function (nd) {
      d = nd
      Object.keys(nodes).forEach(function (k) {
        var on = String(d.value) === k, orig = String(d.original) === k
        nodes[k].className = "card" + (on ? " on" : orig && changed(d) ? " orig" : "")
        nodes[k].setAttribute("aria-pressed", on ? "true" : "false")
        nodes[k].lastChild.lastChild.textContent = on ? "live" : orig && changed(d) ? "was" : ""
      })
    } }
  }

  function makeControl(d, bare) {
    switch (d.type) {
      case "number": return ctlNumber(d, bare)
      case "enum": return ctlEnum(d)
      case "boolean": return ctlBool(d)
      case "color": return ctlColor(d)
      case "token": return ctlToken(d)
      case "variant": return ctlVariant(d)
      default: return ctlText(d)
    }
  }

  /* one dial block */
  function dialBlock(d, bare) {
    var c = makeControl(d, bare)
    var now = h("span", { class: "now" }), was = h("span", { class: "was" })
    var reset = h("button", { type: "button", class: "btn sm", text: "Reset", "aria-label": "Reset " + lab(d), onclick: function () { resetDial(d.id) } })
    var src = d.source && d.source.file ? d.id + " · " + d.source.file + (d.source.line ? ":" + d.source.line : "") : d.id
    var head = bare ? null : h("div", { class: "dh" }, [
      h("div", null, [h("h3", { text: lab(d) }), h("span", { class: "src", text: src })]),
      h("div", { class: "dv" }, [now, was, reset])
    ])
    var el = h("section", { class: "dial", "data-id": d.id, "aria-label": lab(d) }, [head, c.el])
    el.addEventListener("mouseenter", function () { highlight(d.id) })
    el.addEventListener("mouseleave", function () { if (!el.contains(document.activeElement)) highlight(null) })
    el.addEventListener("focusin", function () { highlight(d.id); S.active = d.id; drawCrops() })
    el.addEventListener("focusout", function (e) { if (!el.contains(e.relatedTarget) && !el.matches(":hover")) highlight(null) })
    el.addEventListener("pointerdown", function () { if (S.active !== d.id) { S.active = d.id; drawCrops() } })
    function refresh(nd) {
      d = nd
      el.className = "dial" + (changed(d) ? " changed" : "")
      now.textContent = fmt(d, d.value)
      was.textContent = changed(d) ? "was " + fmt(d, d.original) : ""
      reset.hidden = !changed(d)
      c.refresh(d)
    }
    refresh(d)
    return { el: el, refresh: refresh }
  }

  /* ---------- crops ---------- */
  function shotBox(kind, rec, id) {
    var c = capOf(id), d = find(id)
    var label = (kind === "before" ? "Before" : "After") + (rec && d ? " · " + fmt(d, rec.v) : "")
    return h("div", { class: "shot" }, [
      h("span", { class: "cap" + (kind === "after" ? " live" : ""), text: label }),
      h("div", { class: "frame" + (kind === "after" && rec ? " after" : "") }, rec ? h("img", { src: rec.url, alt: label }) : h("span", { class: "none", text: c.busy ? "Capturing…" : "No capture yet" }))
    ])
  }
  function cropsView(id) {
    var d = find(id), box = h("div", { style: "display:flex;flex-direction:column;gap:16px" })
    if (!d) return box
    var c = capOf(id)
    var names = Object.keys(c.after).concat(Object.keys(c.before)).filter(function (n, i, a) { return a.indexOf(n) === i })
    if (S.data.capture === false && !names.length) {
      box.appendChild(h("div", { class: "empty", style: "padding:0", text: "No screenshot source" }))
      return box
    }
    if (!names.length) names = [null]
    names.forEach(function (n) {
      box.appendChild(h("div", { class: "cdev" }, [
        n ? h("span", { class: "cap", text: n }) : null,
        h("div", { class: "pair" }, [shotBox("before", n ? c.before[n] : null, id), shotBox("after", n ? c.after[n] : null, id)])
      ]))
    })
    var hasBefore = Object.keys(c.before).length > 0
    box.appendChild(h("div", { class: "cact" }, [
      hasBefore ? null : h("button", { type: "button", class: "btn", "data-fk": "capbefore", disabled: c.busy, onclick: function () { captureBefore(id) }, text: "Capture before" }),
      h("button", { type: "button", class: "btn", "data-fk": "capnow", disabled: c.busy, onclick: function () { doCapture(id) }, text: c.busy ? "Capturing…" : "Capture now" })
    ]))
    if (c.err) box.appendChild(h("div", { class: "cerr", role: "alert", text: c.err }))
    return box
  }
  function keepFocus(fn) {
    var a = document.activeElement, fk = a && a.getAttribute && a.getAttribute("data-fk")
    fn()
    if (fk) { var n = document.querySelector('[data-fk="' + fk + '"]'); if (n && !n.disabled) n.focus() }
  }
  function drawCrops() {
    var host = $("crops")
    if (!host) return
    var el = currentElement(tree())
    var id = effLayout() === "dial" ? S.dialId : S.active
    var d = id && find(id)
    if (effLayout() === "element" && el && (!d || !el.dials.some(function (x) { return x.id === id }))) {
      var withCap = el.dials.filter(function (x) { return S.caps[x.id] && Object.keys(S.caps[x.id].after).length })[0]
      d = withCap || el.dials[0]
    }
    keepFocus(function () {
      clear(host)
      if (!d) return
      if (effLayout() === "element") host.appendChild(h("span", { class: "cap", text: lab(d) }))
      host.appendChild(cropsView(d.id))
    })
  }

  /* ---------- main regions ---------- */
  function valuePreview(d) {
    if (d.type === "color") return h("span", { class: "sq2", style: "background:" + d.value })
    if (d.type === "token") { var v = tokenValue(d.value); return isColor(v) ? h("span", { class: "sq2", style: "background:" + v }) : h("span", { class: "pvw", text: String(v == null ? "" : v) }) }
    if (d.type === "boolean") return h("span", { class: "pvw", text: d.value ? "on" : "off" })
    return h("span", { class: "pvw", text: String(d.value) })
  }

  function renderNav(secs) {
    var nav = $("nav")
    if (!nav) return
    var el = currentElement(secs), list = $("navlist")
    keepFocus(function () {
      clear(list)
      if (!secs.length) { list.appendChild(h("div", { class: "empty", text: S.filter ? "Nothing matches" : "" })); return }
      secs.forEach(function (s) {
        list.appendChild(h("div", { class: "sec", text: s.name }))
        s.els.forEach(function (e) {
          var n = nChanged(e.dials)
          var on = el && el.sec === e.sec && el.name === e.name
          list.appendChild(h("button", { type: "button", class: "navi", "data-fk": "nav:" + e.sec + "/" + e.name, "aria-current": on ? "true" : "false", onclick: function () { S.sec = e.sec; S.el = e.name; S.active = null; renderAll(true) } }, [
            h("span", { text: e.name }), n ? h("span", { class: "n", text: String(n) }) : null
          ]))
        })
      })
    })
  }
  function renderStrip() {
    var host = $("strip")
    if (!host) return
    keepFocus(function () {
      clear(host)
      dials().forEach(function (d) {
        var g = split(d), on = d.id === S.dialId
        host.appendChild(h("button", { type: "button", class: "chip", "data-fk": "chip:" + d.id, "aria-current": on ? "true" : "false", onclick: function () { S.dialId = d.id; renderAll(true) } }, [
          valuePreview(d), g.el + " · " + lab(d), changed(d) ? h("span", { class: "dot", title: "Changed" }) : null
        ]))
      })
    })
  }

  function structSig(parts) {
    return JSON.stringify([effLayout(), S.sec, S.el, S.dialId, S.filter, tokenInfo().labels, S.data.capture, parts.map(function (d) {
      return [d.id, d.type, d.options, d.min, d.max, d.step, d.label, d.group, d.source, d.tokenPath, d.original]
    }), Object.keys(S.thumbs).map(function (k) { return [k, Object.keys(S.thumbs[k]).length] }), S.busyVar, flat().length])
  }

  function ownDials(v, secs, el) {
    if (!v.group) return null
    var kids = dials().filter(function (x) {
      if (x.id === v.id || !x.group || x.group.indexOf(v.group) !== 0) return false
      var g = split(x)
      return !(g.sec === el.sec && g.el === el.name)
    })
    if (!kids.length) return null
    return h("div", { class: "own" }, [
      h("span", { class: "gh", text: fmt(v, v.value) + " dials" }),
      kids.map(function (k) {
        var g = split(k)
        return h("button", { type: "button", onclick: function () { S.sec = g.sec; S.el = g.el; S.dialId = k.id; S.active = k.id; renderAll(true) } }, [
          h("span", { text: g.el + " · " + lab(k) }), changed(k) ? h("span", { class: "n", text: "changed" }) : null
        ])
      })
    ])
  }

  function renderMain() {
    var main = $("main")
    if (!main) return
    var secs = tree(), el = currentElement(secs), lay = effLayout()
    if (lay === "dial") {
      if (!find(S.dialId)) S.dialId = dials().length ? dials()[0].id : null
    }
    var shown = lay === "dial" ? dials().filter(function (d) { return d.id === S.dialId }) : el ? el.dials : []
    var sig = structSig(shown)
    if (sig === S.mainSig && !(S.ctlStale)) { shown.forEach(function (d) { var c = S.ctl[d.id]; if (c) c.refresh(d) }); updateBig(); return }
    S.mainSig = sig; S.ctlStale = false
    var a = document.activeElement, fk = a && main.contains(a) && a.closest("[data-id]") ? a.closest("[data-id]").getAttribute("data-id") : null
    clear(main); S.ctl = {}
    if (!shown.length) {
      main.appendChild(h("div", { class: "empty", text: S.loaded ? "No dials yet" : "Loading…" }))
      return
    }
    if (lay === "dial") {
      var d = shown[0], g = split(d), blk = dialBlock(d, true)
      S.ctl[d.id] = blk
      var src = d.source && d.source.file ? d.id + " · " + d.source.file + (d.source.line ? ":" + d.source.line : "") : d.id
      main.appendChild(h("div", { class: "mh" }, [
        h("div", { class: "col" }, [h("h1", { text: g.el + " " + lab(d).toLowerCase() }), h("span", { class: "sub", text: src })]),
        h("div", { class: "big" }, [h("span", { class: "was", id: "bigwas" }), h("span", { class: "v", id: "bigv" })])
      ]))
      main.appendChild(blk.el)
      var own = d.type === "variant" ? ownDials(d, secs, { sec: g.sec, name: g.el }) : null
      if (own) main.appendChild(own)
      main.appendChild(h("aside", { class: "crops", id: "crops", "aria-label": "Before and after" }))
      updateBig()
    } else {
      var sub = el.sec === el.name ? "" : el.sec + " · "
      var first = el.dials[0]
      var srcs = first && first.source && first.source.file ? first.source.file + (first.source.line ? ":" + first.source.line : "") : ""
      main.appendChild(h("div", { class: "mh" }, [
        h("div", { class: "col" }, [h("h1", { text: el.name }), h("span", { class: "sub", text: sub + srcs })]),
        h("button", { type: "button", class: "btn sm", style: "border:1px solid var(--line2)", hidden: !nChanged(el.dials), "data-fk": "resetel", onclick: function () { el.dials.filter(changed).forEach(function (x) { resetDial(x.id) }) }, text: "Reset element" })
      ]))
      el.dials.forEach(function (d) {
        var b = dialBlock(d, false)
        S.ctl[d.id] = b
        main.appendChild(b.el)
        if (d.type === "variant") { var own2 = ownDials(d, secs, el); if (own2) main.appendChild(own2) }
      })
    }
    if (fk && S.ctl[fk]) { var t = main.querySelector('[data-id="' + fk + '"] button, [data-id="' + fk + '"] input'); if (t) t.focus() }
    drawCrops()
  }
  function updateBig() {
    var v = $("bigv"), w = $("bigwas"), d = find(S.dialId)
    if (!v || !d) return
    v.textContent = fmt(d, d.value)
    w.textContent = changed(d) ? "was " + fmt(d, d.original) : ""
  }

  function buildShell() {
    var shell = $("shell"), lay = effLayout()
    var want = lay === "dial" ? "one" : "el"
    if (shell.getAttribute("data-lay") === want) return
    shell.setAttribute("data-lay", want)
    shell.className = "shell " + want
    clear(shell)
    S.mainSig = ""
    if (lay === "dial") {
      shell.appendChild(h("div", { class: "strip", id: "strip", role: "group", "aria-label": "Dials" }))
      shell.appendChild(h("main", { id: "main" }))
    } else {
      var inp = h("input", { type: "text", placeholder: "Filter dials", "aria-label": "Filter dials", value: S.filter })
      inp.addEventListener("input", function () { S.filter = inp.value; renderAll(true) })
      shell.appendChild(h("nav", { id: "nav", "aria-label": "Elements" }, [h("label", { class: "filter" }, inp), h("div", { id: "navlist" })]))
      shell.appendChild(h("main", { id: "main" }))
      shell.appendChild(h("aside", { class: "crops", id: "crops", "aria-label": "Before and after" }))
    }
  }

  /* ---------- header ---------- */
  function renderHeader() {
    $("app").textContent = S.data.app || S.data.project || ""
    $("app").hidden = !$("app").textContent
    var segs = $("layoutSeg").querySelectorAll("button")
    for (var i = 0; i < segs.length; i++) segs[i].setAttribute("aria-pressed", segs[i].getAttribute("data-l") === S.layout ? "true" : "false")
    var devsEl = $("devs"), sig = JSON.stringify([S.data.devices, S.off])
    if (devsEl.getAttribute("data-sig") !== sig) {
      devsEl.setAttribute("data-sig", sig)
      keepFocus(function () {
        clear(devsEl)
        S.data.devices.forEach(function (dv) {
          devsEl.appendChild(h("button", { type: "button", class: "dev", "data-fk": "dev:" + dv.name, "aria-pressed": S.off[dv.name] ? "false" : "true", onclick: function () {
            var on = S.data.devices.filter(function (x) { return !S.off[x.name] })
            if (S.off[dv.name]) delete S.off[dv.name]
            else if (on.length > 1) S.off[dv.name] = true
            renderHeader()
          } }, [h("i"), dv.name]))
        })
      })
    }
    var ch = dials().filter(changed), n = ch.length
    var count = $("count")
    count.className = "count" + (n ? "" : " none")
    count.textContent = n ? n + " changed · " + (ch.every(function (d) { return d.saved }) ? "saved" : "unsaved") : "No changes"
    var cb = $("commitBtn")
    cb.textContent = NARROW.matches ? (n ? "Commit " + n : "Commit") : n ? "Commit " + n + " change" + (n === 1 ? "" : "s") : "Commit"
    cb.disabled = !n && !S.data.commit
    $("resetAll").disabled = !n
    $("copy").disabled = !n
    $("copy").textContent = S.copied ? "Copied" : "Copy values"
  }

  function refreshValues() {
    renderHeader()
    var secs = tree()
    renderNav(secs); renderStrip()
    var lay = effLayout()
    var el = currentElement(secs)
    var shown = lay === "dial" ? dials().filter(function (d) { return d.id === S.dialId }) : el ? el.dials : []
    shown.forEach(function (d) { var c = S.ctl[d.id]; if (c) c.refresh(d) })
    var rb = document.querySelector('[data-fk="resetel"]')
    if (rb && el) rb.hidden = !nChanged(el.dials)
    updateBig()
    renderCommit()
  }

  function renderAll(force) {
    buildShell()
    var secs = tree()
    var el = currentElement(secs)
    if (el) { S.sec = el.sec; S.el = el.name }
    renderHeader(); renderNav(secs); renderStrip()
    if (force) S.mainSig = ""
    renderMain()
    drawCrops()
    renderCommit()
  }

  /* ---------- commit drawer ---------- */
  var STEPS = ["requested", "taken", "writing", "done"]
  function inFlight() { var c = S.data.commit; return !!c && (c.status === "requested" || c.status === "taken" || c.status === "writing") }
  function valChip(d, v) {
    var t = d.type === "color" ? v : d.type === "token" ? tokenValue(v) : null
    return [t && isColor(t) ? h("i", { style: "background:" + t }) : null, fmt(d, v)]
  }
  var lastFocus = null
  function openCommit() {
    lastFocus = document.activeElement
    S.commitOpen = true
    var dr = $("drawer")
    dr.hidden = false
    clear(dr)
    S.sel = {}
    var note = h("textarea", { id: "note", rows: "3", "aria-label": "Note for the agent" })
    note.value = S.note
    note.addEventListener("input", function () { S.note = note.value })
    var revert = h("input", { type: "checkbox", id: "revert" })
    revert.checked = S.revert
    revert.addEventListener("change", function () { S.revert = revert.checked })
    dr.appendChild(h("div", { class: "dt" }, [
      h("h2", { id: "dtitle", tabindex: "-1", text: "Commit to source" }),
      h("button", { type: "button", class: "btn sm", text: "Close", onclick: closeCommit })
    ]))
    dr.appendChild(h("div", { class: "list", id: "clist" }))
    dr.appendChild(h("label", { class: "fl" }, ["Note for the agent", note]))
    dr.appendChild(h("label", { class: "ck" }, [revert, "Revert the unticked ones"]))
    dr.appendChild(h("button", { type: "button", class: "btn primary", id: "doCommit", style: "padding:12px;font-size:14px", onclick: sendCommit }))
    dr.appendChild(h("div", { class: "cstat", id: "cstat" }))
    renderCommit()
    $("dtitle").focus()
  }
  function closeCommit() {
    S.commitOpen = false
    $("drawer").hidden = true
    if (lastFocus && lastFocus.focus) lastFocus.focus()
  }
  function renderCommit() {
    if (!S.commitOpen) return
    var list = $("clist"), ch = dials().filter(changed)
    var sig = JSON.stringify([ch.map(function (d) { return [d.id, d.value, d.original] }), S.sel])
    if (list.getAttribute("data-sig") !== sig) {
      list.setAttribute("data-sig", sig)
      keepFocus(function () {
        clear(list)
        if (!ch.length) list.appendChild(h("div", { class: "empty", text: "No changes" }))
        ch.forEach(function (d) {
          var cb = h("input", { type: "checkbox", "data-fk": "ck:" + d.id, "aria-label": "Include " + lab(d) })
          cb.checked = S.sel[d.id] !== false
          cb.addEventListener("change", function () { S.sel[d.id] = cb.checked; renderCommit() })
          var g = split(d)
          list.appendChild(h("label", { class: "item" }, [
            cb,
            h("span", { class: "a" }, [h("span", { text: g.el === lab(d) ? lab(d) : g.el + " · " + lab(d) }), h("span", { text: d.source && d.source.file ? d.source.file + (d.source.line ? ":" + d.source.line : "") : d.id })]),
            h("span", { class: "d" }, [h("span", null, valChip(d, d.original)), h("span", { text: "→" }), h("b", null, valChip(d, d.value))])
          ]))
        })
      })
    }
    var n = ch.filter(function (d) { return S.sel[d.id] !== false }).length
    var btn = $("doCommit")
    btn.textContent = "Commit " + n + " change" + (n === 1 ? "" : "s")
    btn.disabled = !n || S.posting || inFlight()
    var st = $("cstat"), c = S.data.commit
    clear(st)
    if (c) {
      var idx = STEPS.indexOf(c.status), failed = c.status === "failed"
      st.appendChild(h("span", { class: "cap", text: "Status" }))
      st.appendChild(h("div", { class: "steps", role: "status" }, STEPS.map(function (s, i) {
        var cls = "step" + (failed ? (s === "writing" ? " bad" : i < 2 ? " done" : "") : i < idx ? " done" : i === idx ? (s === "done" ? " done" : " now") : "")
        return h("span", { class: cls, text: s })
      }).concat(failed ? [h("span", { class: "step bad", text: "failed" })] : [])))
      if (c.message) st.appendChild(h("span", { class: failed ? "cerr" : "sub", text: c.message }))
    }
  }
  function sendCommit() {
    var ids = dials().filter(function (d) { return changed(d) && S.sel[d.id] !== false }).map(function (d) { return d.id })
    if (!ids.length) return
    S.posting = true; renderCommit()
    api("POST", "/api/commit", { ids: ids, note: S.note || undefined, revertOthers: S.revert }).then(function (res) {
      clearError()
      if (res && res.commit) { S.data.commit = res.commit }
    }).catch(function (e) { showError(e.message) }).then(function () { S.posting = false; renderHeader(); renderCommit() })
  }

  /* ---------- data ---------- */
  function ingest(data) {
    if (Array.isArray(data)) data = { dials: data }
    if (!data || !data.dials) return
    var now = Date.now()
    data.dials.forEach(function (d) {
      if (S.local[d.id] !== undefined) {
        if (now - (S.touched[d.id] || 0) < 1200) d.value = S.local[d.id]
        else delete S.local[d.id]
      }
    })
    var prev = S.data
    S.data = {
      devices: data.devices || prev.devices || [],
      dials: data.dials,
      tokens: "tokens" in data ? data.tokens : prev.tokens,
      labels: data.labels || prev.labels || {},
      commit: "commit" in data ? data.commit : prev.commit,
      capture: "capture" in data ? data.capture : prev.capture,
      app: data.app || prev.app || "",
      project: data.project || prev.project
    }
    S.loaded = true
    var wasFirst = !S.sec
    if (wasFirst || !find(S.dialId)) { var f = dials()[0]; if (f && !find(S.dialId)) S.dialId = f.id }
    var live = {}
    S.data.devices.forEach(function (d) { live[d.name] = true })
    Object.keys(S.off).forEach(function (k) { if (!live[k]) delete S.off[k] })
    var sig = structSig(dials())
    if (sig !== S.lastSig || wasFirst) { S.lastSig = sig; renderAll(false) }
    else refreshValues()
  }

  var source = null
  function connect() {
    if (source) return
    try { source = new EventSource("/api/events?key=" + encodeURIComponent(KEY)) } catch (e) { showError("Cannot reach the dials server."); return }
    source.onopen = function () { clearError() }
    source.onmessage = function (ev) { var d; try { d = JSON.parse(ev.data) } catch (e) { return } clearError(); ingest(d) }
    source.onerror = function () { showError("Lost the dials server. Reconnecting.") }
  }
  function load() {
    api("GET", "/api/dials").then(function (d) { clearError(); ingest(d); connect() }).catch(function (e) {
      showError(e.message === "Unauthorized. Reopen the panel URL with its key." ? e.message : "Cannot reach the dials server.")
      setTimeout(load, 2000)
    })
  }

  /* ---------- wiring ---------- */
  $("layoutSeg").addEventListener("click", function (e) {
    var b = e.target.closest("button")
    if (!b) return
    S.layout = b.getAttribute("data-l")
    try { localStorage.setItem("dials.layout", S.layout) } catch (x) {}
    if (S.layout === "dial" && !S.dialId && dials()[0]) S.dialId = dials()[0].id
    renderAll(true)
  })
  $("resetAll").addEventListener("click", function () { dials().filter(changed).forEach(function (d) { release(d.id, d.original) }) })
  $("copy").addEventListener("click", function () {
    var out = {}
    dials().filter(changed).forEach(function (d) { out[d.id] = d.value })
    var text = JSON.stringify(out, null, 2)
    function done() { S.copied = true; renderHeader(); setTimeout(function () { S.copied = false; renderHeader() }, 1500) }
    function fallback() {
      var t = h("textarea", { style: "position:fixed;opacity:0" }); t.value = text; document.body.appendChild(t); t.select()
      try { document.execCommand("copy"); done() } catch (e) { showError("Copy failed") }
      document.body.removeChild(t)
    }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback)
    else fallback()
  })
  $("commitBtn").addEventListener("click", function () { if (S.commitOpen) closeCommit(); else openCommit() })
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && S.commitOpen) closeCommit() })
  if (NARROW.addEventListener) NARROW.addEventListener("change", function () { renderAll(true) })

  renderAll(true)
  load()
})()
</script>
</body>
</html>
`
