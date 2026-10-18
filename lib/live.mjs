/**
 * lib/live.mjs —— B站直播的全部"脏活"
 * ============================================================================
 * 2026-10-17 真机实测跑通的那条路（探针脚本见 _tmp_live_probe/probe2.mjs）：
 *
 *   ① 主播 UID → 直播间短号  GET /room/v1/Room/getRoomInfoOld?mid=<uid>
 *   ② 短号 → 真实房间号      GET /room/v1/Room/get_info?room_id=<短号>
 *   ③ 真实房间号 → 弹幕 token  GET /xlive/web-room/v1/index/getDanmuInfo?id=<真实号>&type=0
 *      🔴 **必须带 WBI 签名（w_rid + wts），否则 code=-352**（不带签名只给 -352，带 cookie 也没用）
 *   ④ wss://<host>:<wss_port>/sub 发鉴权包（op=7, protover=3）→ op=8 表示通过
 *   ⑤ 消息包 op=5；protover=3 的包体是 **brotli 压缩的多个子包**，要递归解
 *
 * ⚠️ Node 全局 WebSocket 的 onmessage 里 ev.data 默认是 **Blob**，必须 `binaryType='arraybuffer'`，
 *    否则 `Buffer.from(blob)` 直接抛 ERR_INVALID_ARG_TYPE（踩过一次）。
 * ============================================================================
 */
import { createHash } from 'node:crypto'
import { brotliDecompressSync, inflateSync } from 'node:zlib'

export const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const LIVE_REF = 'https://live.bilibili.com/'

/** 把登录凭证拼成 Cookie 头 */
export function cookieOf(cred) {
  if (!cred?.sessdata) return ''
  const parts = [`SESSDATA=${cred.sessdata}`]
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`)
  return parts.join('; ')
}

export function headersOf(cred, referer = LIVE_REF) {
  const h = { 'User-Agent': UA, Referer: referer }
  const c = cookieOf(cred)
  if (c) h.Cookie = c
  return h
}

async function getJson(url, cred, referer) {
  const r = await fetch(url, { headers: headersOf(cred, referer) })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { code: -1, message: `非 JSON 响应：${t.slice(0, 80)}` } }
}

/* ────────────────────────── WBI 签名 ────────────────────────── */

const MIXIN_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
]

let wbiCache = { key: '', at: 0 }

async function mixinKey(cred) {
  if (wbiCache.key && Date.now() - wbiCache.at < 6 * 3600 * 1000) return wbiCache.key
  const j = await getJson('https://api.bilibili.com/x/web-interface/nav', cred)
  const img = j?.data?.wbi_img?.img_url?.split('/').pop()?.split('.')[0] || ''
  const sub = j?.data?.wbi_img?.sub_url?.split('/').pop()?.split('.')[0] || ''
  if (!img || !sub) throw new Error('拿不到 WBI 密钥（nav 接口没给 wbi_img）')
  const orig = img + sub
  const key = MIXIN_TAB.map((n) => orig[n]).join('').slice(0, 32)
  wbiCache = { key, at: Date.now() }
  return key
}

/** 生成 `id=..&type=..&wts=..&w_rid=..` 形式的查询串 */
export async function wbiSign(params, cred) {
  const mixin = await mixinKey(cred)
  const wts = Math.round(Date.now() / 1000)
  const merged = { ...params, wts }
  const qs = Object.keys(merged)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(merged[k]))}`)
    .join('&')
  const w_rid = createHash('md5').update(qs + mixin).digest('hex')
  return `${qs}&w_rid=${w_rid}`
}

/* ────────────────────────── 房间查询 ────────────────────────── */

/** 昵称缓存：room 接口不再回 uname，得问 Master/info */
const unameCache = new Map()

async function unameOf(uid, cred) {
  const key = String(uid || '')
  if (!key) return ''
  if (unameCache.has(key)) return unameCache.get(key)
  try {
    const j = await getJson(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${encodeURIComponent(key)}`, cred)
    const u = j?.code === 0 ? String(j?.data?.info?.uname || '') : ''
    if (u) unameCache.set(key, u)
    return u
  } catch { return '' }
}

/** 通过主播 UID 找直播间 */
export async function getRoomByUid(mid, cred) {
  const j = await getJson(`https://api.live.bilibili.com/room/v1/Room/getRoomInfoOld?mid=${encodeURIComponent(mid)}`, cred)
  if (j.code !== 0) throw new Error(`查主播 ${mid} 的直播间失败：${j.message || j.code}`)
  const d = j.data || {}
  return {
    roomId: Number(d.roomid) || 0,
    liveStatus: Number(d.liveStatus) || 0,
    title: d.title || '',
    uname: d.uname || await unameOf(mid, cred),
    online: Number(d.online) || 0,
  }
}

/** 通过房间号取真实房间信息（短号会被换成真实号） */
export async function getRoomInfo(roomId, cred) {
  const j = await getJson(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(roomId)}`, cred)
  if (j.code !== 0) throw new Error(`查房间 ${roomId} 失败：${j.message || j.code}`)
  const d = j.data || {}
  return {
    realRoomId: Number(d.room_id) || 0,
    uid: Number(d.uid) || 0,
    liveStatus: Number(d.live_status) || 0,
    title: d.title || '',
    uname: d.uname || await unameOf(d.uid, cred),
    online: Number(d.online) || 0,
  }
}

/** 拿弹幕服务器地址 + token（必须 WBI 签名，否则 -352） */
/**
 * 逛直播间：拿一批「此刻正在播」的房间，供随机挑一个。
 * 两个数据源都免 WBI 签名：user_recommend 是扁平 6 条；index/getList 覆盖多种分区。
 */
export async function getRandomLiveRooms(
  cred,
  { minOnline = 100, maxOnline = 600000, want = 12, keywords = [] } = {},
) {
  const out = []
  const push = (r) => {
    const roomId = Number(r?.roomid || r?.room_id || 0)
    if (!roomId) return
    const online = Number(r?.online || 0)
    if (online < minOnline) return // 太冷清：进去也可能没人说话
    if (online > maxOnline) return // 太热闹：基本是官方赛事/大主播，满屏刷屏不好总结
    if (out.some((x) => x.roomId === roomId)) return
    out.push({
      roomId,
      mid: String(r?.uid || r?.up_id || r?.mid || ''),
      uname: String(r?.uname || '').trim() || `房间${roomId}`,
      title: String(r?.title || '').trim(),
      online,
    })
  }

  // ① 首页分区模块：覆盖虚拟主播/唱见/电台等「有真人在说话」的分区
  try {
    const j = await getJson('https://api.live.bilibili.com/xlive/web-interface/v1/index/getList?platform=web', cred)
    const d = j?.data || {}
    for (const mod of d.room_list || []) for (const r of mod?.list || []) push(r)
    for (const r of d.recommend_room_list || []) push(r)
  } catch { /* 这个源挂了不影响下一个 */ }

  // ② 推荐位：补一些，但排在分区房间后面
  try {
    const j = await getJson('https://api.live.bilibili.com/room/v1/room/get_user_recommend?page=1&page_size=6', cred)
    const d = j?.data || {}
    for (const k of Object.keys(d)) if (d[k] && typeof d[k] === 'object') push(d[k])
  } catch { /* 同上 */ }

  // ③ 有喜好关键词时，额外把常去分区按人气翻一遍 —— 首页推荐位覆盖不到冷门分区，
  //    只看推荐位很容易「一个关键词都不命中」。分区号：9 虚拟主播、1 娱乐、2 网游、3 手游、6 单机、10 电台。
  const kws = (Array.isArray(keywords) ? keywords : []).map((k) => String(k || '').trim().toLowerCase()).filter(Boolean)
  if (kws.length) {
    for (const pid of [9, 1, 2, 3, 6, 10]) {
      try {
        const j = await getJson(
          `https://api.live.bilibili.com/room/v1/Area/getRoomList?platform=web&parent_area_id=${pid}&area_id=0&sort_type=online&page_no=1&page_size=20`,
          cred,
        )
        for (const r of j?.data || []) push(r)
      } catch { /* 某个分区挂了就跳过 */ }
    }
  }

  const shuffle = (arr) => {
    for (let i = arr.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[arr[i], arr[j]] = [arr[j], arr[i]]
    }
    return arr
  }

  // 有喜好时：命中的排前面（内部同样打散），没命中的仍然垫在后面，
  // 避免「关键词没命中就干待着」。
  if (kws.length) {
    const hit = (r) => kws.some((k) => `${r.title} ${r.uname}`.toLowerCase().includes(k))
    const yes = shuffle(out.filter(hit))
    const no = shuffle(out.filter((r) => !hit(r)))
    for (const r of yes) r.matched = true
    return [...yes, ...no].slice(0, want)
  }

  return shuffle(out).slice(0, want)
}

export async function getDanmuServer(realRoomId, cred) {
  const qs = await wbiSign({ id: realRoomId, type: 0, web_location: '444.8' }, cred)
  const j = await getJson(`https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${qs}`, cred)
  if (j.code !== 0) throw new Error(`取弹幕服务器失败：code=${j.code} ${j.message || ''}`.trim())
  const token = j?.data?.token
  const hosts = j?.data?.host_list || []
  if (!token || !hosts.length) throw new Error('弹幕服务器返回里没有 token/host')
  const h = hosts[0]
  return { token, url: `wss://${h.host}:${h.wss_port}/sub` }
}

/* ────────────────────────── 发弹幕 ────────────────────────── */

const SEND_ERR = {
  '-101': '账号未登录（凭证失效，重新扫码）',
  '-111': 'csrf 校验失败（bili_jct 不对）',
  '10030': '弹幕内容包含敏感词或被限制',
  '1003212': '发得太快了（B站限流，歇几秒再发）',
  '1003211': '该直播间禁止弹幕',
  '10031': '发送失败，可能被风控',
}

/** 往直播间发一条弹幕（会消耗账号的发言额度，只在被叫到时用） */
export async function sendDanmaku(cred, realRoomId, text) {
  if (!cred?.bili_jct) return { ok: false, code: -101, message: '没有登录凭证（bili_jct 缺失）' }
  const body = new URLSearchParams({
    color: '16777215',
    fontsize: '25',
    mode: '1',
    msg: text,
    rnd: String(Math.floor(Date.now() / 1000)),
    roomid: String(realRoomId),
    bubble: '0',
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
  })
  let j
  try {
    const r = await fetch('https://api.live.bilibili.com/msg/send', {
      method: 'POST',
      headers: {
        ...headersOf(cred, `${LIVE_REF}${realRoomId}`),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    j = await r.json()
  } catch (e) {
    return { ok: false, code: -1, message: `网络错误：${e?.message || e}` }
  }
  const code = Number(j?.code)
  const ok = code === 0
  return {
    ok,
    code,
    message: ok ? '已发送' : SEND_ERR[String(code)] || j?.message || `code=${code}`,
    data: j?.data,
  }
}

/* ────────────────────────── 私信 ────────────────────────── */

const DM_ERR = {
  '-101': '账号未登录（凭证失效，重新扫码）',
  '-111': 'csrf 校验失败（bili_jct 不对）',
  '-400': '请求参数不对',
  21026: 'B站 不允许给自己发私信（换一个接收 UID）',
  25005: '对方设置了「不接受未关注人私信」',
}

/**
 * 给某个 B站 UID 发一条私信。
 *
 * 注意：B站 明令不允许「自己给自己发私信」（code 21026），而本插件登录的通常
 * 就是用户本人的号 —— 所以推送目标必须另填一个 UID，填了当前账号会直接被挡回。
 */
export async function sendPrivateMsg(cred, toUid, text) {
  if (!cred?.bili_jct) return { ok: false, code: -101, message: '没有登录凭证（bili_jct 缺失）' }
  const sender = String(cred.dedeuserid || '').replace(/\D/g, '')
  const receiver = String(toUid || '').replace(/\D/g, '')
  if (!sender) return { ok: false, code: -1, message: '凭证里没有 dedeuserid' }
  if (!receiver) return { ok: false, code: -1, message: '没有填接收 UID' }
  if (receiver === sender) return { ok: false, code: 21026, message: DM_ERR[21026] }

  const body = new URLSearchParams({
    'msg[sender_uid]': sender,
    'msg[receiver_id]': receiver,
    'msg[receiver_type]': '1', // 1 = 用户
    'msg[msg_type]': '1', // 1 = 文本
    'msg[dev_id]': 'A1B2C3D4-1234-5678-9ABC-DEF012345678',
    'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
    'msg[content]': JSON.stringify({ content: String(text).slice(0, 800) }),
    csrf: cred.bili_jct,
    csrf_token: cred.bili_jct,
  })

  let j
  try {
    const r = await fetch('https://api.vc.bilibili.com/web_im/v1/web_im/send_msg', {
      method: 'POST',
      headers: {
        ...headersOf(cred, 'https://message.bilibili.com/'),
        Origin: 'https://message.bilibili.com',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    })
    j = await r.json()
  } catch (e) {
    return { ok: false, code: -1, message: `网络错误：${e?.message || e}` }
  }
  const code = Number(j?.code)
  return {
    ok: code === 0,
    code,
    message: code === 0 ? '已发送' : DM_ERR[String(code)] || j?.message || `code=${code}`,
  }
}

/* ────────────────────────── 弹幕 WS ────────────────────────── */

function pack(op, body, ver = 1) {
  const data = Buffer.from(body, 'utf8')
  const buf = Buffer.alloc(16 + data.length)
  buf.writeUInt32BE(16 + data.length, 0)
  buf.writeUInt16BE(16, 4)
  buf.writeUInt16BE(ver, 6)
  buf.writeUInt32BE(op, 8)
  buf.writeUInt32BE(1, 12)
  data.copy(buf, 16)
  return buf
}

function unpack(buf, out = []) {
  let off = 0
  while (off + 16 <= buf.length) {
    const total = buf.readUInt32BE(off)
    if (total < 16 || off + total > buf.length) break
    const hlen = buf.readUInt16BE(off + 4)
    const ver = buf.readUInt16BE(off + 6)
    const op = buf.readUInt32BE(off + 8)
    const body = buf.subarray(off + hlen, off + total)
    off += total
    if (ver === 3) {
      try { unpack(brotliDecompressSync(body), out) } catch { /* 压缩包坏了就跳过 */ }
    } else if (ver === 2) {
      /* zlib 压缩（老客户端）；brotli 之外的少数包会走这里 */
      try { unpack(inflateSync(body), out) } catch { /* 跳过 */ }
    } else {
      out.push({ op, ver, body })
    }
  }
  return out
}

/** 从 op=5 的 body 里解析出 JSON 消息（可能一个包塞多条，用 \0 分隔） */
function parseMessages(body) {
  const text = body.toString('utf8')
  const out = []
  // 先整体试一次（大多数情况是单条）
  try {
    const j = JSON.parse(text)
    if (j && typeof j === 'object') out.push(j)
    return out
  } catch { /* 多半是多条拼在一起 */ }
  for (const line of text.split('\u0000')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* 忽略脏片 */ }
  }
  return out
}

/** 从 DANMU_MSG 里抠出「谁、说了什么」 */
export function parseDanmaku(msg) {
  /* 注意：2025 年后的弹幕 cmd 常带后缀（DANMU_MSG:4:0:2:2:2:0），必须前缀匹配 */
  if (!String(msg?.cmd || '').startsWith('DANMU_MSG')) return null
  const info = msg.info || []
  const text = String(info[1] ?? '')
  const user = info[2] || []
  const uid = String(user[0] ?? '')
  const uname = String(user[1] ?? '')
  if (!text) return null
  return { uid, uname, text, ts: Number(info[0]?.[4]) || Date.now() }
}

/**
 * 一个直播间的弹幕连接：连上、鉴权、心跳、断线重连、把弹幕回调出去。
 * 只负责"听"，发消息走 sendDanmaku。
 */
export class DanmakuClient {
  constructor({ roomId, cred, onDanmaku, onStatus, onLog }) {
    this.realRoomId = roomId
    this.cred = cred
    this.onDanmaku = onDanmaku || (() => {})
    this.onStatus = onStatus || (() => {})
    this.onLog = onLog || (() => {})
    this.ws = null
    this.heart = null
    this.retry = 0
    this.stopped = false
    this.connected = false
    this.startedAt = 0
  }

  async start() {
    this.stopped = false
    await this.connect()
  }

  async connect() {
    if (this.stopped) return
    try {
      const { token, url } = await getDanmuServer(this.realRoomId, this.cred)
      const WS = globalThis.WebSocket
      if (!WS) throw new Error('当前运行环境没有 WebSocket')
      this.onLog(`连接弹幕服务器 ${url}`)
      const ws = new WS(url)
      ws.binaryType = 'arraybuffer'
      this.ws = ws

      ws.onopen = () => {
        this.startedAt = Date.now()
        ws.send(pack(7, JSON.stringify({
          uid: Number(this.cred?.dedeuserid) || 0,
          roomid: this.realRoomId,
          protover: 3,
          platform: 'web',
          type: 2,
          key: token,
        })))
        this.startHeartbeat()
      }

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return
        const buf = Buffer.from(ev.data)
        for (const p of unpack(buf)) {
          if (p.op === 8) {
            this.connected = true
            this.retry = 0
            this.onStatus('connected')
            this.onLog(`房间 ${this.realRoomId} 弹幕已连上`)
          } else if (p.op === 5) {
            for (const msg of parseMessages(p.body)) {
              const d = parseDanmaku(msg)
              if (d) this.onDanmaku(d)
            }
          }
        }
      }

      ws.onerror = () => { /* onclose 会接着处理 */ }

      ws.onclose = () => {
        this.connected = false
        this.stopHeartbeat()
        this.onStatus('closed')
        if (this.stopped) return
        this.retry++
        const wait = Math.min(30000, 1000 * 2 ** Math.min(this.retry, 5))
        this.onLog(`弹幕连接断了，${Math.round(wait / 1000)}s 后重连`)
        setTimeout(() => this.connect(), wait)
      }
    } catch (e) {
      this.connected = false
      this.onStatus('error')
      this.onLog(`连弹幕失败：${e?.message || e}`)
      if (this.stopped) return
      this.retry++
      const wait = Math.min(60000, 2000 * 2 ** Math.min(this.retry, 5))
      setTimeout(() => this.connect(), wait)
    }
  }

  startHeartbeat() {
    this.stopHeartbeat()
    this.heart = setInterval(() => {
      try { this.ws?.send(pack(2, '')) } catch { /* 断了会走进 onclose */ }
    }, 30000)
  }

  stopHeartbeat() {
    if (this.heart) { clearInterval(this.heart); this.heart = null }
  }

  stop() {
    this.stopped = true
    this.stopHeartbeat()
    try { this.ws?.close() } catch { /* 收摊 */ }
    this.connected = false
  }
}
