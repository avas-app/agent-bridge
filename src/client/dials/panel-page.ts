// The Dials panel served at GET /. One self-contained page: inline CSS and JS,
// no external requests, no build step. It talks only to the routes below and
// authenticates every request with the key from location.search.
export const PANEL_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dials</title>
<style>
*{box-sizing:border-box}
:root{--bg:#fff;--fg:#111;--muted:#666;--line:#e3e3e3;--card:#fff;--accent:#1f7a4d;--chip:#f0f0f0;--err:#c0332b}
@media (prefers-color-scheme:dark){:root{--bg:#111;--fg:#eee;--muted:#999;--line:#333;--card:#1a1a1a;--accent:#3fae7a;--chip:#262626;--err:#a5261f}}
html,body{margin:0;padding:0}
body{background:var(--bg);color:var(--fg);overflow-x:hidden;font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:8px 10px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
header strong{font-size:14px;font-weight:600}
#devices{display:flex;gap:4px;flex-wrap:wrap}
button{font:inherit;color:inherit;background:var(--chip);border:1px solid var(--line);border-radius:7px;padding:5px 9px;cursor:pointer}
button.on{background:var(--accent);color:#fff;border-color:var(--accent)}
#status{padding:8px 10px;font-size:13px}
#status.err{color:#fff;background:var(--err)}
[hidden]{display:none}
main{padding:6px 10px 48px}
section{margin-bottom:12px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:14px 0 6px;font-weight:600}
.row{border:1px solid var(--line);background:var(--card);border-radius:9px;padding:8px;margin-bottom:8px}
.head{display:flex;align-items:center;gap:6px;margin-bottom:7px}
.label{font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
.dot{width:7px;height:7px;border-radius:50%;border:1px solid var(--line);flex:0 0 auto}
.dot.on{background:var(--accent);border-color:var(--accent)}
.reset{font-size:11px;padding:3px 7px}
.ctrl{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ctrl input[type=range]{flex:1 1 120px;min-width:0}
.ctrl input[type=text],.ctrl input[type=number]{min-width:0;padding:5px 6px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:inherit;font:inherit}
.ctrl .hex{width:86px}
.ctrl .num{width:66px}
.color input[type=color]{width:38px;height:31px;padding:0;border:1px solid var(--line);border-radius:7px;background:none}
.swatches{display:flex;gap:5px;flex-wrap:wrap;width:100%}
.swatch{width:22px;height:22px;border-radius:5px;border:1px solid var(--line);padding:0;cursor:pointer}
.enum button{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.toggle{display:inline-flex;align-items:center;cursor:pointer}
.toggle input{position:absolute;opacity:0;width:0;height:0}
.toggle .track{width:40px;height:22px;border-radius:11px;background:var(--chip);border:1px solid var(--line);position:relative;transition:background .12s}
.toggle .track:after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--fg);transition:transform .12s}
.toggle input:checked+.track{background:var(--accent);border-color:var(--accent)}
.toggle input:checked+.track:after{transform:translateX(18px);background:#fff}
</style>
</head>
<body>
<header>
<strong>Dials</strong>
<div id="devices"></div>
</header>
<div id="status" hidden></div>
<main id="groups"></main>
<script>
(function () {
  var params = new URLSearchParams(location.search)
  var KEY = params.get("key") || ""
  var statusEl = document.getElementById("status")
  var devicesEl = document.getElementById("devices")
  var groupsEl = document.getElementById("groups")
  var source = null
  var state = { devices: [], dials: [], tokens: null }
  var selected = null
  var rows = {}
  var sig = ""

  function authHeaders(extra) {
    var h = {}
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) h[k] = extra[k]
    h["x-dials-key"] = KEY
    return h
  }

  function showError(msg) {
    statusEl.textContent = msg
    statusEl.className = "err"
    statusEl.hidden = false
  }

  function clearError() {
    statusEl.hidden = true
    statusEl.textContent = ""
  }

  function byId(id) {
    for (var i = 0; i < state.dials.length; i++) if (state.dials[i].id === id) return state.dials[i]
    return null
  }

  function groupOf(id) {
    var i = id.indexOf(".")
    return i > 0 ? id.slice(0, i) : id
  }

  function eq(a, b) {
    if (a === b) return true
    if (a == null || b == null) return false
    return String(a) === String(b)
  }

  function isColor(v) {
    if (typeof v !== "string") return false
    var s = v.trim()
    if (s.charAt(0) === "#" && !/[^0-9a-f]/i.test(s.slice(1)) && (s.length === 4 || s.length === 5 || s.length === 7 || s.length === 9))
      return true
    var low = s.toLowerCase()
    return low.indexOf("rgb(") === 0 || low.indexOf("rgba(") === 0 || low.indexOf("hsl(") === 0 || low.indexOf("hsla(") === 0 || low === "transparent" || low === "currentcolor"
  }

  function byte(n) {
    var v = Math.max(0, Math.min(255, Math.round(Number(n))))
    var s = v.toString(16)
    return s.length < 2 ? "0" + s : s
  }

  function toHex(v) {
    if (typeof v !== "string") return "#000000"
    var s = v.trim()
    if (s.charAt(0) === "#") {
      var hex = s.slice(1)
      if (hex.length === 3 || hex.length === 4) return "#" + hex.charAt(0) + hex.charAt(0) + hex.charAt(1) + hex.charAt(1) + hex.charAt(2) + hex.charAt(2)
      if (hex.length >= 6) return "#" + hex.slice(0, 6)
    }
    var low = s.toLowerCase()
    if (low.indexOf("rgb") === 0) {
      var open = s.indexOf("(")
      var close = s.lastIndexOf(")")
      if (open >= 0 && close > open) {
        var raw = s.slice(open + 1, close)
        var parts = []
        var cur = ""
        for (var i = 0; i < raw.length; i++) {
          var c = raw.charAt(i)
          if (c === "," || c === " " || c === "\\t" || c === "/") {
            if (cur) { parts.push(cur); cur = "" }
          } else cur += c
        }
        if (cur) parts.push(cur)
        if (parts.length >= 3) return "#" + byte(parts[0]) + byte(parts[1]) + byte(parts[2])
      }
    }
    return "#000000"
  }

  function walkTokens(node, path, fn) {
    if (typeof node === "string") { fn(path, node); return }
    if (node && typeof node === "object") {
      for (var k in node) if (node.hasOwnProperty(k)) walkTokens(node[k], path.concat(k), fn)
    }
  }

  function colorSwatches() {
    var out = []
    walkTokens(state.tokens, [], function (path, value) {
      if (isColor(value)) out.push({ path: path.join("."), value: value })
    })
    return out
  }

  function tokenLeaves(tokenPath) {
    if (typeof tokenPath !== "string" || !state.tokens) return []
    var top = tokenPath.split(".")[0]
    var node = state.tokens[top]
    if (!node || typeof node !== "object") return []
    var out = []
    walkTokens(node, [top], function (path, value) {
      out.push({ path: path.join("."), short: path.slice(1).join("."), value: value })
    })
    return out
  }

  // Throttle a dial's posts to one per 50 ms; flush() sends the last value at release.
  var pending = {}
  var timers = {}
  var lastAt = {}

  function selectedNames() {
    var out = []
    for (var k in selected) if (selected.hasOwnProperty(k) && selected[k]) out.push(k)
    return out
  }

  function countSelected() {
    var n = 0
    for (var k in selected) if (selected.hasOwnProperty(k) && selected[k]) n++
    return n
  }

  function postSet(id, value) {
    var body = { id: id, value: value }
    if (selected && state.devices.length > 1 && countSelected() !== state.devices.length)
      body.devices = selectedNames()
    fetch("/api/dials/set", {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (r.status === 401) showError("Unauthorized. Reopen the panel URL with its key.")
    }).catch(function () {
      showError("Lost the dials server. Retrying.")
      scheduleLoad()
    })
  }

  function flush(id) {
    if (timers[id]) { clearTimeout(timers[id]); timers[id] = 0 }
    if (!(id in pending)) return
    var value = pending[id]
    delete pending[id]
    lastAt[id] = Date.now()
    postSet(id, value)
  }

  function send(id, value) {
    pending[id] = value
    var wait = 50 - (Date.now() - (lastAt[id] || 0))
    if (wait <= 0) { flush(id); return }
    if (!timers[id]) timers[id] = setTimeout(function () { flush(id) }, wait)
  }

  function release(id) { flush(id) }

  function setLocal(id, value) {
    var d = byId(id)
    if (!d) return
    d.value = value
    updateRow(d)
  }

  function updateRow(d) {
    var r = rows[d.id]
    if (!r) return
    r.refresh(d)
    r.dot.className = "dot" + (eq(d.value, d.original) ? "" : " on")
  }

  function set(id, value) { setLocal(id, value); send(id, value) }
  function commit(id, value) { setLocal(id, value); send(id, value); release(id) }

  function field(type, cls) {
    var input = document.createElement("input")
    input.type = type
    if (cls) input.className = cls
    return input
  }

  function colorControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl color"
    var picker = field("color")
    picker.value = toHex(d.value)
    var hex = field("text", "hex")
    hex.value = d.value == null ? "" : String(d.value)
    function commitColor(v) { setLocal(d.id, v); send(d.id, v) }
    picker.oninput = function () { hex.value = picker.value; commitColor(picker.value) }
    picker.onchange = function () { hex.value = picker.value; setLocal(d.id, picker.value); release(d.id) }
    hex.oninput = function () { var v = hex.value.trim(); if (isColor(v)) { picker.value = toHex(v); commitColor(v) } }
    hex.onchange = function () {
      var v = hex.value.trim()
      var cur = byId(d.id)
      if (isColor(v)) { picker.value = toHex(v); commit(d.id, v) }
      else if (cur) hex.value = cur.value == null ? "" : String(cur.value)
    }
    wrap.appendChild(picker)
    wrap.appendChild(hex)
    var sw = colorSwatches()
    if (sw.length) {
      var bar = document.createElement("div")
      bar.className = "swatches"
      sw.forEach(function (s) {
        var b = document.createElement("button")
        b.className = "swatch"
        b.title = s.path
        b.style.background = s.value
        b.onclick = function () {
          picker.value = toHex(s.value)
          hex.value = s.value
          commit(d.id, s.value)
        }
        bar.appendChild(b)
      })
      wrap.appendChild(bar)
    }
    wrap.refresh = function (dd) {
      if (document.activeElement !== hex) hex.value = dd.value == null ? "" : String(dd.value)
      if (document.activeElement !== picker) picker.value = toHex(dd.value)
    }
    return wrap
  }

  function numberControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl number"
    var min = d.min == null ? 0 : d.min
    var max = d.max == null ? 100 : d.max
    var step = d.step == null ? 1 : d.step
    var range = field("range")
    range.min = min; range.max = max; range.step = step; range.value = String(d.value)
    var num = field("number", "num")
    num.min = min; num.max = max; num.step = step; num.value = String(d.value)
    function commitNumber(v) { if (isNaN(v)) return; setLocal(d.id, v); send(d.id, v) }
    range.oninput = function () { var v = Number(range.value); num.value = range.value; commitNumber(v) }
    range.onchange = function () { release(d.id) }
    num.oninput = function () { if (num.value === "" || isNaN(Number(num.value))) return; range.value = num.value; commitNumber(Number(num.value)) }
    num.onchange = function () { release(d.id) }
    wrap.appendChild(range)
    wrap.appendChild(num)
    wrap.refresh = function (dd) {
      var v = String(dd.value)
      if (document.activeElement !== range) range.value = v
      if (document.activeElement !== num) num.value = v
    }
    return wrap
  }

  function enumControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl enum"
    var buttons = []
    ;(d.options || []).forEach(function (opt) {
      var b = document.createElement("button")
      b.textContent = String(opt)
      b.onclick = function () { commit(d.id, opt) }
      wrap.appendChild(b)
      buttons.push({ el: b, value: opt })
    })
    wrap.refresh = function (dd) {
      buttons.forEach(function (p) { p.el.className = eq(p.value, dd.value) ? "on" : "" })
    }
    return wrap
  }

  function booleanControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl bool"
    var label = document.createElement("label")
    label.className = "toggle"
    var box = field("checkbox")
    box.checked = !!d.value
    var track = document.createElement("span")
    track.className = "track"
    box.onchange = function () { commit(d.id, box.checked) }
    label.appendChild(box)
    label.appendChild(track)
    wrap.appendChild(label)
    wrap.refresh = function (dd) { box.checked = !!dd.value }
    return wrap
  }

  function textControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl text"
    var input = field("text")
    input.value = d.value == null ? "" : String(d.value)
    input.oninput = function () { set(d.id, input.value) }
    input.onchange = function () { release(d.id) }
    wrap.appendChild(input)
    wrap.refresh = function (dd) {
      if (document.activeElement !== input) input.value = dd.value == null ? "" : String(dd.value)
    }
    return wrap
  }

  function tokenControl(d) {
    var wrap = document.createElement("div")
    wrap.className = "ctrl token"
    var leaves = tokenLeaves(d.tokenPath)
    var buttons = []
    if (!leaves.length) {
      var input = field("text")
      input.value = d.value == null ? "" : String(d.value)
      input.oninput = function () { set(d.id, input.value) }
      input.onchange = function () { release(d.id) }
      wrap.appendChild(input)
      wrap.refresh = function (dd) {
        if (document.activeElement !== input) input.value = dd.value == null ? "" : String(dd.value)
      }
      return wrap
    }
    leaves.forEach(function (leaf) {
      var b = document.createElement("button")
      b.textContent = leaf.short || leaf.path
      b.title = leaf.path
      b.onclick = function () { commit(d.id, leaf.path) }
      wrap.appendChild(b)
      buttons.push({ el: b, value: leaf.path })
    })
    wrap.refresh = function (dd) {
      buttons.forEach(function (p) { p.el.className = eq(p.value, dd.value) ? "on" : "" })
    }
    return wrap
  }

  function buildControl(d) {
    if (d.type === "color") return colorControl(d)
    if (d.type === "number") return numberControl(d)
    if (d.type === "enum") return enumControl(d)
    if (d.type === "boolean") return booleanControl(d)
    if (d.type === "token") return tokenControl(d)
    return textControl(d)
  }

  function buildRow(d) {
    var row = document.createElement("div")
    row.className = "row"
    var head = document.createElement("div")
    head.className = "head"
    var dot = document.createElement("span")
    dot.className = "dot"
    var label = document.createElement("span")
    label.className = "label"
    label.textContent = d.label || d.id
    label.title = d.id
    var reset = document.createElement("button")
    reset.className = "reset"
    reset.textContent = "Reset"
    reset.onclick = function () { commit(d.id, d.original) }
    head.appendChild(dot)
    head.appendChild(label)
    head.appendChild(reset)
    var control = buildControl(d)
    row.appendChild(head)
    row.appendChild(control)
    rows[d.id] = { dot: dot, refresh: control.refresh || function () {} }
    return row
  }

  function signature() {
    return state.dials.map(function (d) { return d.id + ":" + d.type + ":" + (d.group || groupOf(d.id)) + ":" + (d.options ? d.options.join(",") : "") + ":" + (d.tokenPath || "") }).join("|")
  }

  function renderDevices() {
    devicesEl.textContent = ""
    if (state.devices.length <= 1) return
    var all = document.createElement("button")
    all.textContent = "All"
    all.className = countSelected() === state.devices.length ? "on" : ""
    all.onclick = function () {
      state.devices.forEach(function (d) { selected[d.name] = true })
      renderDevices()
    }
    devicesEl.appendChild(all)
    state.devices.forEach(function (dev) {
      var b = document.createElement("button")
      b.textContent = dev.name
      b.className = selected[dev.name] ? "on" : ""
      b.onclick = function () {
        if (selected[dev.name]) { if (countSelected() > 1) delete selected[dev.name] }
        else selected[dev.name] = true
        renderDevices()
      }
      devicesEl.appendChild(b)
    })
  }

  function render() {
    rows = {}
    groupsEl.textContent = ""
    var order = []
    var byGroup = {}
    state.dials.forEach(function (d) {
      var g = d.group || groupOf(d.id)
      if (!byGroup[g]) { byGroup[g] = []; order.push(g) }
      byGroup[g].push(d)
    })
    order.forEach(function (g) {
      var section = document.createElement("section")
      var h = document.createElement("h2")
      h.textContent = g
      section.appendChild(h)
      byGroup[g].forEach(function (d) { section.appendChild(buildRow(d)) })
      groupsEl.appendChild(section)
    })
    renderDevices()
    sig = signature()
    state.dials.forEach(updateRow)
  }

  function sync() {
    if (signature() !== sig) { render(); return }
    state.dials.forEach(function (d) { var r = rows[d.id]; if (r) { r.refresh(d); r.dot.className = "dot" + (eq(d.value, d.original) ? "" : " on") } })
  }

  var loadTimer = null
  function scheduleLoad() {
    if (loadTimer) return
    loadTimer = setTimeout(function () { loadTimer = null; load() }, 2000)
  }

  function load() {
    fetch("/api/dials", { headers: authHeaders() }).then(function (r) {
      if (r.status === 401) { showError("Unauthorized. Reopen the panel URL with its key."); return null }
      if (!r.ok) throw new Error("HTTP " + r.status)
      return r.json()
    }).then(function (data) {
      if (!data) return
      if (loadTimer) { clearTimeout(loadTimer); loadTimer = null }
      clearError()
      state.devices = data.devices || []
      state.dials = data.dials || []
      state.tokens = data.tokens || null
      if (!selected) selected = {}
      var names = {}
      state.devices.forEach(function (d) { names[d.name] = true })
      if (!Object.keys(selected).length) state.devices.forEach(function (d) { selected[d.name] = true })
      for (var k in selected) if (selected.hasOwnProperty(k) && !names[k]) delete selected[k]
      render()
      connect()
    }).catch(function () {
      showError("Cannot reach the dials server.")
      scheduleLoad()
    })
  }

  function connect() {
    if (source) return
    try {
      source = new EventSource("/api/events?key=" + encodeURIComponent(KEY))
    } catch (e) {
      showError("Cannot reach the dials server.")
      return
    }
    source.onopen = function () { clearError() }
    source.onmessage = function (ev) {
      var data
      try { data = JSON.parse(ev.data) } catch (e) { return }
      var list = Array.isArray(data) ? data : (data && data.dials)
      if (!list) return
      clearError()
      state.dials = list
      if (data && data.devices) state.devices = data.devices
      if (data && "tokens" in data) state.tokens = data.tokens || null
      sync()
      renderDevices()
    }
    source.onerror = function () { showError("Lost the dials server. Reconnecting.") }
  }

  load()
})()
</script>
</body>
</html>
`
