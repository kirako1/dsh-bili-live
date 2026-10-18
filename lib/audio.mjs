/**
 * audio.mjs —— 从 B站直播流里「只听声音」
 *
 * 做的事：
 *   ① getPlayUrl()：房间号 → flv 直链（不需要 WBI，普通 GET 就够）
 *   ② AudioTap：拉这条 flv 长连接，按 FLV tag 解析，**只留音频 tag**，
 *      每 sliceMs 毫秒攒成一个小的 flv 文件丢给上层转写。
 *
 * 为什么要在 Node 里自己拆 FLV：
 *   - 直播是持续字节流，不能等它结束；只能切成一片一片
 *   - 分片必须从 tag 边界开始、且带 AAC 的 AudioSpecificConfig，否则解码器打不开
 *   - 视频 tag 全部丢掉：转写用不上，还能让临时文件小一半以上
 *     （⚠️ 流量省不掉 —— 视频字节还是得从 HTTP 流里读进来才能丢弃；
 *       想真省只能选最低清晰度。qn=80 实测约 175KB/s。）
 *
 * 断流/过期：上层给的是 getUrl 回调，每次重连都重新换一条新直链。
 */
import fs from 'node:fs'
import { headersOf } from './live.mjs'

const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x04, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00])

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function getJson(url, cred) {
  const r = await fetch(url, { headers: headersOf(cred) })
  const t = await r.text()
  try { return JSON.parse(t) } catch { return { code: -1, message: `非 JSON 响应：${t.slice(0, 80)}` } }
}

/** 房间号 → flv 直链 + 该流的信息 */
export async function getPlayUrl(realRoomId, cred, { qn = '80' } = {}) {
  const q = new URLSearchParams({
    room_id: String(realRoomId),
    protocol: '0',        // 0=flv（1=hls，分片多，按需时可换）
    format: '0',
    codec: '0',
    qn: String(qn),
    platform: 'web',
    ptype: '8',
    dolby: '5',
  })
  const j = await getJson('https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?' + q.toString(), cred)
  if (j.code !== 0) throw new Error(`取直播流地址失败：code=${j.code} ${j.message || ''}`.trim())
  const info = j?.data?.playurl_info?.playurl
  const streams = info?.stream || []
  for (const s of streams) {
    if (s.protocol_name !== 'http_stream') continue
    for (const f of s.format || []) {
      for (const c of f.codec || []) {
        const ui = (c.url_info || [])[0]
        if (!ui) continue
        return {
          url: ui.host + c.base_url + (ui.extra || ''),
          codec: c.codec_name,
          qn: Number(c.current_qn) || Number(qn),
          acceptQn: c.accept_qn || '',
        }
      }
    }
  }
  throw new Error('这个房间没有可用的 flv 流（可能未开播，或只提供 HLS）')
}

/* ────────────────────────── FLV 拆包 ────────────────────────── */

/**
 * 增量 FLV 解析器：吐完整的 tag（type=8 音频 / 9 视频 / 18 脚本）。
 * 首包带 'FLV' 头时跳过 13 字节；中途接入时扫描第一个合法 tag 头对齐。
 */
export class FlvSplitter {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.aligned = false
    this.dropped = 0
  }

  #tryAlign() {
    if (this.buf.length < 13) return false
    if (this.buf[0] === 0x46 && this.buf[1] === 0x4c && this.buf[2] === 0x56) {
      const off = this.buf.readUInt32BE(5) || 9
      if (this.buf.length < off + 4) return false
      this.buf = this.buf.subarray(off + 4)
      this.aligned = true
      return true
    }
    const limit = Math.min(this.buf.length - 11, 8192)
    for (let i = 0; i < limit; i++) {
      const t = this.buf[i]
      if (t !== 8 && t !== 9 && t !== 18) continue
      const ds = this.buf.readUIntBE(i + 1, 3)
      if (ds <= 0 || ds > 2 * 1024 * 1024) continue
      if (this.buf.readUIntBE(i + 8, 3) !== 0) continue
      if (i > 0) this.dropped += i
      this.buf = this.buf.subarray(i)
      this.aligned = true
      return true
    }
    if (this.buf.length > 16384) {
      this.dropped += this.buf.length - 64
      this.buf = this.buf.subarray(this.buf.length - 64)
    }
    return false
  }

  /** 喂字节，返回这次凑齐的完整 tag 列表 */
  push(chunk) {
    // ⚠️ undici 的 fetch body 吐的是 Uint8Array，不是 Buffer —— 首包直接当 Buffer 用会炸
    const c = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.buf = this.buf.length ? Buffer.concat([this.buf, c]) : c
    const out = []
    for (;;) {
      if (!this.aligned) {
        if (!this.#tryAlign()) break
      }
      if (this.buf.length < 11) break
      const type = this.buf[0]
      if (type !== 8 && type !== 9 && type !== 18) { this.aligned = false; continue }
      const dataSize = this.buf.readUIntBE(1, 3)
      if (dataSize <= 0 || dataSize > 4 * 1024 * 1024) { this.aligned = false; continue }
      const total = 11 + dataSize + 4
      if (this.buf.length < total) break
      this.aligned = true
      const ts = ((this.buf.readUIntBE(4, 3) | (this.buf[7] << 24)) >>> 0)
      const raw = Buffer.from(this.buf.subarray(0, total))
      this.buf = this.buf.subarray(total)
      out.push({ type, ts, raw })
    }
    return out
  }
}

/** 这是一条 AAC 的 AudioSpecificConfig 吗（每个分片都要带上，否则解不了码） */
function isAacSeqHeader(data) {
  return data.length >= 2 && (data[0] >> 4) === 0x0a && data[1] === 0x00
}

/* ────────────────────────── 拉流分片 ────────────────────────── */

/**
 * 持续拉流，每 sliceMs 毫秒的声音切一片写盘。
 * 用法：new AudioTap({...}).start() / .stop()
 */
export class AudioTap {
  constructor({ getUrl, roomId, dir, sliceMs = 10000, onSegment = () => {}, onLog = () => {} }) {
    this.getUrl = getUrl
    this.roomId = roomId
    this.dir = dir
    this.sliceMs = Math.max(3000, Math.min(60000, Number(sliceMs) || 10000))
    this.onSegment = onSegment
    this.onLog = onLog
    this.stopped = false
    this.ac = null
    this.seq = 0
    this.segStartTs = null
    this.segTags = []
    this.segBytes = 0
    this.seqHeader = null
    this.lastTs = 0
    this.stats = { segments: 0, audioMs: 0, bytesIn: 0, reconnects: 0, lastError: '' }
  }

  start() {
    if (!this.stopped) this.#loop()
    return this
  }

  stop() {
    this.stopped = true
    try { this.ac?.abort() } catch { /* 忽略 */ }
    this.#flush('stop')
  }

  async #loop() {
    while (!this.stopped) {
      try {
        await this.#pump()
      } catch (e) {
        if (this.stopped) break
        this.stats.lastError = String(e?.message || e)
        this.onLog(`拉流断开：${this.stats.lastError}（3 秒后重连）`)
      }
      if (this.stopped) break
      this.stats.reconnects++
      await sleep(3000)
    }
  }

  async #pump() {
    const { url } = await this.getUrl()
    const ac = new AbortController()
    this.ac = ac
    const r = await fetch(url, { headers: headersOf(null), signal: ac.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const splitter = new FlvSplitter()
    let lastData = Date.now()
    // 90 秒没数据当断流（直播流平时几毫秒就有）
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 90000) { try { ac.abort() } catch { /* 忽略 */ } }
    }, 15000)
    try {
      for await (const chunk of r.body) {
        if (this.stopped) break
        lastData = Date.now()
        this.stats.bytesIn += chunk.length
        for (const tag of splitter.push(chunk)) {
          if (tag.type !== 8) continue          // 只要音频
          const data = tag.raw.subarray(11, tag.raw.length - 4)
          if (isAacSeqHeader(data)) { this.seqHeader = tag.raw; continue }
          this.#addTag(tag)
        }
      }
    } finally {
      clearInterval(watchdog)
      if (this.ac === ac) this.ac = null
    }
  }

  #addTag(tag) {
    if (this.segStartTs === null) this.segStartTs = tag.ts
    this.segTags.push(tag)
    this.segBytes += tag.raw.length
    this.lastTs = tag.ts
    if (tag.ts - this.segStartTs >= this.sliceMs) this.#flush('slice')
  }

  #flush(reason) {
    if (!this.segTags.length) return
    const tags = this.segTags
    const audioMs = Math.max(0, this.lastTs - this.segStartTs)
    this.segTags = []
    this.segStartTs = null
    this.segBytes = 0
    const seq = ++this.seq
    const parts = [FLV_HEADER]
    if (this.seqHeader) parts.push(this.seqHeader)
    for (const t of tags) parts.push(t.raw)
    const buf = Buffer.concat(parts)
    const file = `${this.dir}/seg-${this.roomId}-${Date.now()}-${seq}.flv`
    try {
      fs.writeFileSync(file, buf)
      this.stats.segments++
      this.stats.audioMs += audioMs
      this.onSegment({ file, audioMs, tags: tags.length, bytes: buf.length, reason })
    } catch (e) {
      this.onLog(`写分片失败：${e?.message || e}`)
    }
  }

  status() {
    return { ...this.stats, stopped: this.stopped, sliceMs: this.sliceMs }
  }
}
