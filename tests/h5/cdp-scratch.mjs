/**
 * H5 自验脚本（零第三方依赖）：
 * 启动的 headless Chromium（Playwright 缓存）+ Chrome DevTools Protocol，
 * 在真实 canvas 上派发 TouchEvent，验证：
 *   A. 涂层绘制完成（全不透明像素占比 > 99%）
 *   B. 刮擦后 canvas alpha 变化（被刮区域变透明）
 *   C. 达标自动揭开（canvas 被 v-if 移除 / display none）
 *   D. complete 恰好触发 1 次
 *   E. T02 对角线不误触发
 *   F. T05 快速甩动不断线（被擦像素沿对角线连续，无大间隙）
 *   G. T08 多指只追踪首指（两指间无贯穿擦除）
 *
 * 用法：node tests/h5/cdp-scratch.mjs [scenarioUrl]
 */

import { spawn } from 'node:child_process'
import http from 'node:http'
import net from 'node:net'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'

const CHROME =
  process.env.CHROME_BIN ||
  process.env.HOME +
    '/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'
const BASE = process.env.H5_BASE || 'http://localhost:5173'
const PAGE = BASE + '/#/pages/scratch/index'

const results = []
function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  const line = (pass ? 'PASS' : 'FAIL') + ' | ' + name + (detail ? ' | ' + detail : '')
  console.log(line)
  try { appendFileSync('/tmp/cdp-results.txt', line + '\n') } catch {}
}

/* ---------------- 极简 CDP 客户端 ---------------- */

function getJson(path) {
  return new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port: debugPort, path }, (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => resolve(JSON.parse(data)))
      })
      .on('error', reject)
  })
}

let debugPort = 9333
let ws = null
let msgId = 0
const pending = new Map()
const eventWaiters = new Map()

const sessionDispatchers = []

function pickFreePort() {
  return new Promise((resolve) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port
      srv.close(() => resolve(p))
    })
  })
}

async function getVersion(port) {
  const ver = await new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        let d = ''
        res.on('data', (c) => (d += c))
        res.on('end', () => resolve(JSON.parse(d)))
      })
      .on('error', reject)
  })
  return ver
}

async function connectCdp() {
  let ver
  for (let i = 0; i < 40; i++) {
    try {
      ver = await getVersion(debugPort)
      break
    } catch {
      await sleep(250)
    }
  }
  if (!ver) throw new Error('chrome devtools endpoint not found')
  wsUrl = ver.webSocketDebuggerUrl
  if (!wsUrl) throw new Error('chrome devtools endpoint not found')

  ws = new WebSocket(wsUrl)
  await once(ws, 'open')
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    // flatten 模式：会话消息直接顶层下发（带 sessionId），优先按会话路由。
    if (msg.sessionId && (msg.id || msg.method)) {
      sessionDispatchers.slice().forEach((fn) => fn({ sessionId: msg.sessionId, message: JSON.stringify(msg) }))
      return
    }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(JSON.stringify(msg.error)))
      else resolve(msg.result)
    }
    // flatten 模式下会话事件与部分回执（如 attachToTarget 的 sessionId）走事件通道。
    if (msg.method === 'Target.receivedMessageFromTarget') {
      const list = sessionDispatchers
      list.slice().forEach((fn) => fn(msg.params))
    }
    if (msg.method) {
      const list = eventWaiters.get(msg.method)
      if (list) list.slice().forEach((fn) => fn(msg.params))
    }
    if (msg.params) {
      const list = eventWaiters.get('__raw__')
      if (list) list.slice().forEach((fn) => fn(msg))
    }
  })
}

let wsUrl = null
function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
function on(method, fn) {
  if (!eventWaiters.has(method)) eventWaiters.set(method, [])
  eventWaiters.get(method).push(fn)
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function waitRawEvent(predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('raw event timeout')), timeoutMs)
    const fn = (msg) => {
      if (predicate(msg)) {
        clearTimeout(timer)
        const list = eventWaiters.get('__raw__')
        if (list) list.splice(list.indexOf(fn), 1)
        resolve(msg.params || msg)
      }
    }
    if (!eventWaiters.has('__raw__')) eventWaiters.set('__raw__', [])
    eventWaiters.get('__raw__').push(fn)
  })
}

async function newPage() {
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const attachPromise = waitRawEvent(
    (m) => m.method === 'Target.attachedToTarget' && m.params?.targetInfo?.targetId === targetId,
  )
  await send('Target.attachToTarget', { targetId, flatten: true })
  const attached = await attachPromise
  const sessionId = attached.sessionId
  const client = new BufferedSession(sessionId)
  return { targetId, client }
}

class BufferedSession {
  constructor(sessionId) {
    this.sessionId = sessionId
    this.id = 0
    this.pending = new Map()
    this.events = []
    this.eventWaiters = new Map()
    sessionDispatchers.push((p) => {
      if (p.sessionId !== this.sessionId) return
      const msg = JSON.parse(p.message)
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params })
        const list = this.eventWaiters.get(msg.method)
        if (list) list.slice().forEach((fn) => fn(msg.params))
      }
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // flatten 模式：命令直接顶层发送并携带 sessionId，回执也顶层返回。
      ws.send(JSON.stringify({ id, sessionId: this.sessionId, method, params }))
    })
  }
  wait(method, predicate = () => true, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('wait timeout: ' + method)), timeoutMs)
      const fn = (params) => {
        if (predicate(params)) {
          clearTimeout(timer)
          this.eventWaiters.get(method)?.splice(this.eventWaiters.get(method).indexOf(fn), 1)
          resolve(params)
        }
      }
      if (!this.eventWaiters.has(method)) this.eventWaiters.set(method, [])
      this.eventWaiters.get(method).push(fn)
    })
  }
  async eval(fnOrExpr, ...args) {
    const expression =
      typeof fnOrExpr === 'function'
        ? '(' + fnOrExpr.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')'
        : fnOrExpr
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }
}

/* ---------------- 页面内辅助函数（序列化为字符串注入） ---------------- */

const pageHelpers = `
window.__h = (function () {
  function hostOf() { return document.getElementById('scratchCanvas'); }
  function realCanvas() {
    const host = document.getElementById('scratchCanvas');
    if (!host) return null;
    return host.tagName === 'CANVAS' ? host : host.querySelector('canvas');
  }
  function rectOf() {
    const c = hostOf();
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  function getCtx() {
    const c = realCanvas();
    return c ? c.getContext('2d') : null;
  }
  // 全尺寸 alpha 统计：ground truth（03 文档口径，alpha<=24 视为净）。
  function stats() {
    const c = realCanvas();
    if (!c) return { exists: false, opaqueRatio: 0, cleanRatio: 0 };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let opaque = 0;
    let clean = 0;
    for (let i = 3; i < d.length; i += 4) {
      if (d[i] >= 120) opaque++;
      if (d[i] <= 24) clean++;
    }
    const n = d.length / 4;
    return { exists: true, opaqueRatio: opaque / n, cleanRatio: clean / n, pw: c.width, ph: c.height };
  }
  function touch(target, type, points) {
    const t = points.map((p, i) => new Touch({
      identifier: i, clientX: p.x, clientY: p.y, pageX: p.x, pageY: p.y,
      target, screenX: p.x, screenY: p.y, radiusX: 1, radiusY: 1, force: 1,
    }));
    const ev = new TouchEvent(type, {
      bubbles: true, cancelable: true,
      touches: type === 'touchend' ? [] : t,
      targetTouches: type === 'touchend' ? [] : t,
      changedTouches: t,
    });
    target.dispatchEvent(ev);
  }
  // 沿路径以 step 间隔派发 start/move.../end（单指 identifier=0）
  function strokePath(waypoints, step, delay) {
    const c = hostOf();
    if (!c) return 'no-canvas';
    const pts = [];
    for (let i = 0; i < waypoints.length - 1; i++) {
      const a = waypoints[i], b = waypoints[i + 1];
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.round(d / step));
      for (let k = 0; k < n; k++) pts.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n });
    }
    pts.push(waypoints[waypoints.length - 1]);
    touch(c, 'touchstart', [pts[0]]);
    for (let i = 1; i < pts.length; i++) touch(c, 'touchmove', [pts[i]]);
    touch(c, 'touchend', [pts[pts.length - 1]]);
    return pts.length;
  }
  function clearRatio() { window.__scratchRatio = 0; window.__ratioLog = []; }
  return { hostOf, realCanvas, rectOf, stats, touch, strokePath, clearRatio };
})();
`

async function loadScratchPage(client, urlSuffix = '') {
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  })
  await client.send('Page.navigate', { url: PAGE + urlSuffix })
  // 等真实 canvas 涂层画好（opaqueRatio>0.99）。uni H5 真实节点在 <uni-canvas> 内部。
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const s = await client.eval(() => {
      const host = document.getElementById('scratchCanvas')
      const c = host ? (host.tagName === 'CANVAS' ? host : host.querySelector('canvas')) : null
      if (!c || !c.width) return null
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let opaque = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] >= 120) opaque++
      return { exists: true, opaqueRatio: opaque / (d.length / 4), pw: c.width, ph: c.height }
    })
    if (s && s.exists && s.opaqueRatio > 0.99) {
      await ensureHelpers(client)
      return s
    }
    await sleep(150)
  }
  throw new Error('涂层绘制超时')
}

async function ensureHelpers(client) {
  // 必须在页面加载完成后注入（导航会清空页面上下文）。
  await client.eval(pageHelpers)
}

async function launchChrome() {
  const port = await pickFreePort()
  debugPort = port
  const profileDir = '/tmp/cdp-scratch-profile-' + port
  const libPath = '/tmp/pwlibs/root/usr/lib/x86_64-linux-gnu'
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--remote-debugging-port=' + port,
      '--remote-allow-origins=*',
      '--window-size=390,844',
      '--user-data-dir=' + profileDir,
      'about:blank',
    ],
    {
      stdio: 'ignore',
      env: { ...process.env, LD_LIBRARY_PATH: [libPath, process.env.LD_LIBRARY_PATH || ''].filter(Boolean).join(':') },
    },
  )
  // 等待 devtools 就绪
  for (let i = 0; i < 40; i++) {
    try {
      await getJson('/json/version')
      return proc
    } catch {
      await sleep(250)
    }
  }
  throw new Error('chrome launch timeout')
}

/* ---------------- 测试场景 ---------------- */

async function testCoverPainted(client) {
  const s = await client.eval(() => window.__h.stats())
  record('A 涂层绘制完成', s.exists && s.opaqueRatio > 0.99,
    `opaqueRatio=${(s.opaqueRatio * 100).toFixed(2)}% size=${s.pw}x${s.ph}`)
}

async function testScratchAndReveal(client) {
  // 记录刮擦前 alpha
  const before = await client.eval(() => window.__h.stats())

  // B：刮一条横线，检查被刮区域变透明
  const probe = await client.eval(() => {
    const r = window.__h.rectOf()
    const y = r.top + r.height / 2
    const n = window.__h.strokePath(
      [{ x: r.left + 10, y }, { x: r.left + r.width - 10, y }],
      4, 0)
    return n
  })
  await sleep(300)
  const afterStroke = await client.eval(() => window.__h.stats())
  record('B 刮擦后 alpha 变化',
    afterStroke.cleanRatio > before.cleanRatio + 0.02,
    `cleanRatio ${(before.cleanRatio * 100).toFixed(1)}% -> ${(afterStroke.cleanRatio * 100).toFixed(1)}% (pathPts=${probe})`)

  // C/D：密集水平排线刮满 >50%，等待自动揭开 + complete
  await client.eval(() => {
    const r = window.__h.rectOf()
    const spacing = 12 // CSS px，笔刷半径 28rpx≈14.5px(390宽)，排线重叠保证覆盖
    for (let y = 6; y < r.height - 6; y += spacing) {
      window.__h.strokePath(
        [{ x: r.left + 4, y: r.top + y }, { x: r.left + r.width - 4, y: r.top + y }],
        5, 0)
    }
  })
  // 等揭晓：采样 120ms + 淡出 260ms，给 6s 上限
  let revealed = false
  let complete = 0
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    const st = await client.eval(() => ({
      exists: !!document.getElementById('scratchCanvas'),
      complete: window.__scratchComplete || 0,
      ratio: window.__scratchRatio || 0,
    }))
    complete = st.complete
    if (!st.exists) {
      revealed = true
      break
    }
  }
  record('C 达标自动揭开(canvas 移除)', revealed, revealed ? '' : 'canvas 仍存在')
  record('D complete 恰好 1 次', complete === 1, `completeCount=${complete}`)

  // 幂等再确认：揭晓后再派发触摸，complete 不增加
  await client.eval(() => {
    const c = document.getElementById('scratchCanvas')
    if (c) window.__h.touch(c, 'touchstart', [{ x: 10, y: 10 }])
  })
  await sleep(300)
  const complete2 = await client.eval(() => window.__scratchComplete || 0)
  record('D2 揭晓后触摸不再触发 complete', complete2 === 1, `completeCount=${complete2}`)
}

async function testDiagonalNoFalseTrigger(client) {
  // T02：两条对角线各一次，等待采样，断言不揭开
  await client.eval(() => {
    const r = window.__h.rectOf()
    window.__h.strokePath([
      { x: r.left + 2, y: r.top + 2 },
      { x: r.left + r.width - 2, y: r.top + r.height - 2 },
    ], 5, 0)
    window.__h.strokePath([
      { x: r.left + r.width - 2, y: r.top + 2 },
      { x: r.left + 2, y: r.top + r.height - 2 },
    ], 5, 0)
  })
  await sleep(600) // 覆盖多个 120ms 采样周期
  const st = await client.eval(() => ({
    exists: !!document.getElementById('scratchCanvas'),
    ratio: window.__scratchRatio || 0,
    clean: window.__h.stats().cleanRatio,
  }))
  record('T02 对角线不误触发',
    st.exists && st.ratio < 0.5 && st.clean < 0.4,
    `engineRatio=${(st.ratio * 100).toFixed(1)}% refClean=${(st.clean * 100).toFixed(1)}%`)
}

async function testFastFling(client) {
  // T05：左上→右下一笔，800px+ 距离、点间隔很大（模拟 240Hz 稀疏回调的极端甩动）
  const info = await client.eval(() => {
    const r = window.__h.rectOf()
    // 只给很少几个原始点（间距 ~200px），验证插值补点连续
    const n = window.__h.strokePath([
      { x: r.left - 200, y: r.top - 200 },
      { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      { x: r.left + r.width + 200, y: r.top + r.height + 200 },
    ], 200, 0)
    return { pts: n, r }
  })
  await sleep(400)
  // 沿对角线检查像素连续性：等间隔采样对角线物理像素，连续透明段不得出现 >2px 的不透明确口
  const continuity = await client.eval(() => {
    const c = window.__h.realCanvas(); if (!c) return null
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let maxGap = 0, gap = 0
    const N = 400
    for (let i = 0; i <= N; i++) {
      const x = Math.min(c.width - 1, Math.max(0, Math.round(c.width * i / N)))
      const y = Math.min(c.height - 1, Math.max(0, Math.round(c.height * i / N)))
      const a = d[(y * c.width + x) * 4 + 3]
      const erased = a <= 120
      if (erased) { gap = 0 } else { gap++; if (gap > maxGap) maxGap = gap }
    }
    return { maxGap, N }
  })
  // 对角线点在笔刷外的角落本来就有涂层（起点/终点在界外被 clamp），只检查中段。
  const mid = await client.eval(() => {
    const c = window.__h.realCanvas(); if (!c) return null
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    let maxGap = 0, gap = 0
    for (let i = 50; i <= 350; i++) {
      const x = Math.round(c.width * i / 400)
      const y = Math.round(c.height * i / 400)
      const a = d[(y * c.width + x) * 4 + 3]
      if (a <= 120) { gap = 0 } else { gap++; if (gap > maxGap) maxGap = gap }
    }
    return maxGap
  })
  record('T05 快速甩动不断线',
    continuity && mid <= 2,
    `rawPts=${info.pts} 对角线中段最大不透明确口=${mid}px/300采样`)
}

async function testMultiTouch(client) {
  // T08：首指划左半，第二指落在右半并划动；断言右半未被擦（无跨指连线/无次指擦除）
  // 等待 host 就绪（快速新建 target 时首帧可能尚未挂载 canvas）。
  for (let i = 0; i < 40; i++) {
    const ok = await client.eval(() => !!(window.__h && window.__h.hostOf()))
    if (ok) break
    await sleep(150)
  }
  const res = await client.eval(() => {
    try {
    const c = window.__h.hostOf()
    if (!c) return { __error: 'host missing', hash: location.hash }
    const r = c.getBoundingClientRect()
    const mk = (id, x, y) => new Touch({ identifier: id, clientX: x, clientY: y, pageX: x, pageY: y, target: c, screenX: x, screenY: y })
    const P = (x, y) => mk(0, x, y)
    const P2 = (x, y) => mk(1, x, y)
    const ev = (type, touches, changed) => new TouchEvent(type, {
      bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: changed,
    })
    // 双指同时落下
    c.dispatchEvent(ev('touchstart',
      [P(r.left + 20, r.top + 40), P2(r.left + r.width - 20, r.top + 40)],
      [P(r.left + 20, r.top + 40), P2(r.left + r.width - 20, r.top + 40)]))
    // 首指在左半移动（事件只带首指，模拟 identifier=0 的 touchmove）
    for (let i = 1; i <= 10; i++) {
      const p = P(r.left + 20 + i * 12, r.top + 40 + (i % 2))
      c.dispatchEvent(ev('touchmove', [p], [p]))
    }
    // 次指移动（只带 identifier=1），必须被忽略
    for (let i = 1; i <= 10; i++) {
      const p = P2(r.left + r.width - 20 - i * 12, r.top + 80)
      c.dispatchEvent(ev('touchmove', [p], [p]))
    }
    // 两指同时含在一个 move 里（touches 顺序首指在前）
    const a = P(r.left + 150, r.top + 60)
    const b = P2(r.left + r.width - 150, r.top + 120)
    c.dispatchEvent(ev('touchmove', [a, b], [a, b]))
    const ratioBeforeEnd = window.__scratchRatio
    c.dispatchEvent(ev('touchend', [], [a, b]))
    const hostAfterEnd = document.getElementById('scratchCanvas')
    return {
      ratioBeforeEnd,
      ratioAfterEnd: window.__scratchRatio,
      hostAfterTouch: !!hostAfterEnd,
    }
    } catch (e) { return { __error: String(e && e.stack || e) } }
  })
  if (res && res.__error) throw new Error('multi-touch: ' + res.__error)
  void res
  await sleep(400)
  const halves = await client.eval(() => {
    const c = window.__h.realCanvas()
    if (!c) return { __nocanvas: true, hostExists: !!document.getElementById('scratchCanvas') }
    const ctx = c.getContext('2d')
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    function cleanIn(x0, x1, y0, y1) {
      let clean = 0, n = 0
      for (let y = y0; y < y1; y += 3)
        for (let x = x0; x < x1; x += 3) {
          if (d[(y * c.width + x) * 4 + 3] <= 24) clean++
          n++
        }
      return clean / n
    }
    const midX = Math.round(c.width / 2)
    return {
      left: cleanIn(Math.round(c.width * 0.05), Math.round(c.width * 0.45),
        Math.round(c.height * 0.1), Math.round(c.height * 0.5)),
      right: cleanIn(Math.round(c.width * 0.55), Math.round(c.width * 0.95),
        Math.round(c.height * 0.1), Math.round(c.height * 0.7)),
    }
  })
  if (halves && halves.__nocanvas) {
    record('T08 多指只追踪首指', false, 'canvas 在测试中被意外移除（疑似误触发揭晓）')
  } else {
    record('T08 多指只追踪首指',
      halves && halves.left > 0.02 && halves.right < 0.005,
      `左半clean=${(halves.left * 100).toFixed(1)}% 右半clean=${(halves.right * 100).toFixed(2)}%`)
  }
}

async function testIdempotentRapid(client) {
  // T30：达标瞬间快速连滑/多次抬按；通过排线刮到临界后继续乱划，断言 complete 仅 1 次
  await client.eval(() => {
    const r = window.__h.rectOf()
    for (let y = 8; y < r.height - 8; y += 13) {
      window.__h.strokePath(
        [{ x: r.left + 4, y: r.top + y }, { x: r.left + r.width - 4, y: r.top + y + 6 }],
        5, 0)
    }
    // 临界附近疯狂乱划 + 多次起笔抬笔
    for (let i = 0; i < 20; i++) {
      window.__h.strokePath([
        { x: r.left + 10 + (i * 37) % (r.width - 20), y: r.top + 10 + (i * 53) % (r.height - 20) },
        { x: r.left + 20 + (i * 61) % (r.width - 30), y: r.top + 20 + (i * 43) % (r.height - 30) },
      ], 6, 0)
    }
  })
  let complete = 0
  let revealed = false
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    const st = await client.eval(() => ({
      exists: !!document.getElementById('scratchCanvas'),
      complete: window.__scratchComplete || 0,
    }))
    complete = st.complete
    if (!st.exists) {
      revealed = true
      break
    }
  }
  await sleep(500)
  complete = await client.eval(() => window.__scratchComplete || 0)
  record('T30 幂等：快速连滑 complete 恰好 1 次',
    revealed && complete === 1, `revealed=${revealed} completeCount=${complete}`)
}

async function testPrizeFail(client) {
  await client.send('Page.navigate', { url: PAGE + '?scenario=prizeFail' })
  await sleep(1500)
  const failed = await client.eval(() => {
    const txt = document.body.innerText || ''
    return txt.includes('奖品加载失败') && !document.getElementById('scratchCanvas')
  })
  record('T13 奖品拉取失败进 Failed 态且无涂层可刮', failed,
    failed ? '' : '未显示失败态或 canvas 仍存在')
}

async function testSettleFail(client) {
  // T15：结算上报失败 → 写入本地补偿队列；视觉仍揭晓、complete 仅 1 次。
  await client.send('Page.enable')
  await client.send('Runtime.enable')
  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
  })
  await client.send('Page.navigate', { url: BASE + '/' })
  await sleep(300)
  await client.eval(() => {
    Object.keys(localStorage)
      .filter((k) => k.indexOf('scratch_') === 0)
      .forEach((k) => localStorage.removeItem(k))
  })
  await client.send('Page.navigate', { url: PAGE + '?scenario=settleFail' })
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const ok = await client.eval(() => {
      const host = document.getElementById('scratchCanvas')
      const c = host ? (host.tagName === 'CANVAS' ? host : host.querySelector('canvas')) : null
      if (!c || !c.width) return false
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data
      let op = 0
      for (let i = 3; i < d.length; i += 4) if (d[i] >= 120) op++
      return op / (d.length / 4) > 0.99
    })
    if (ok) break
    await sleep(150)
  }
  await ensureHelpers(client)
  // 排线刮满达标
  await client.eval(() => {
    const r = window.__h.rectOf()
    for (let y = 6; y < r.height - 6; y += 12) {
      window.__h.strokePath(
        [{ x: r.left + 4, y: r.top + y }, { x: r.left + r.width - 4, y: r.top + y }],
        5, 0)
    }
  })
  let revealed = false
  for (let i = 0; i < 60; i++) {
    await sleep(100)
    const st = await client.eval(() => ({
      exists: !!document.getElementById('scratchCanvas'),
      complete: window.__scratchComplete || 0,
    }))
    if (!st.exists) { revealed = true; break }
  }
  await sleep(300)
  const queueAfterFail = await client.eval(() => {
    // H5 下 uni storage 落在 localStorage
    const raw = localStorage.getItem('scratch_settle_queue')
    return raw ? JSON.parse(raw) : null
  })
  record('T15a 结算失败仍揭晓且 complete=1',
    revealed && (await client.eval(() => window.__scratchComplete || 0)) === 1,
    `revealed=${revealed}`)
  record('T15b 失败写入补偿队列',
    Array.isArray(queueAfterFail) && queueAfterFail.length === 1 &&
      String(queueAfterFail[0].prizeId) === '88',
    JSON.stringify(queueAfterFail))

  // 网络恢复：移除 settleFail 参数（reportSettlement 恢复成功），派发 online 触发补报。
  await client.eval(() => {
    history.replaceState(null, '', location.pathname + location.hash.split('?')[0])
    window.dispatchEvent(new Event('online'))
  })
  let queueAfterFlush = queueAfterFail
  for (let i = 0; i < 20; i++) {
    await sleep(100)
    queueAfterFlush = await client.eval(() => {
      const raw = localStorage.getItem('scratch_settle_queue')
      return raw ? JSON.parse(raw) : []
    })
    if (Array.isArray(queueAfterFlush) && queueAfterFlush.length === 0) break
  }
  const finalComplete = await client.eval(() => window.__scratchComplete || 0)
  record('T15c 网络恢复后补报成功且队列清空',
    Array.isArray(queueAfterFlush) && queueAfterFlush.length === 0 && finalComplete === 1,
    `remain=${JSON.stringify(queueAfterFlush)} complete=${finalComplete}`)
}

/* ---------------- 主流程 ---------------- */

async function withFreshPage(run, suffix = '') {
  const { client } = await newPage()
  await loadScratchPage(client, suffix)
  await ensureHelpers(client)
  try {
    await run(client)
  } finally {
    // 留待统一关闭浏览器
  }
  return client
}

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null
async function main() {
  console.log('[step] launching chrome')
  const proc = await launchChrome()
  console.log('[step] chrome up, connecting cdp')
  await connectCdp()
  console.log('[step] cdp connected')

  const want = (k) => !ONLY || ONLY.includes(k)
  if (want('ABCD')) {
    console.log('[step] scenario A-D')
    await withFreshPage(async (client) => {
      await testCoverPainted(client)
      await testScratchAndReveal(client)
    })
  }
  if (want('T02')) {
    console.log('[step] T02')
    await withFreshPage(testDiagonalNoFalseTrigger)
  }
  if (want('T05')) await withFreshPage(testFastFling)
  if (want('T08')) await withFreshPage(testMultiTouch)
  if (want('T30')) await withFreshPage(testIdempotentRapid)
  if (want('T15')) {
    const { client: c15 } = await newPage()
    await testSettleFail(c15)
  }
  if (want('T13')) {
    const { client } = await newPage()
    await client.send('Page.enable')
    await client.send('Runtime.enable')
    await testPrizeFail(client)
  }

  await send('Browser.close').catch(() => {})
  proc.kill('SIGKILL')

  const failed = results.filter((r) => !r.pass)
  console.log('\n==== 汇总: ' + (results.length - failed.length) + '/' + results.length + ' 通过 ====')
  if (failed.length) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
