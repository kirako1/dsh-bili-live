/**
 * 直播画面采样：自己拉一路 flv（只要视频），每 intervalMs 把「最近一个完整 GOP」
 * 落成一个临时 flv 分片，交给上层去抽帧。
 *
 * 为什么不复用 AudioTap 的流：那条流只留音频 tag，塞视频进去会破坏音频分片；
 * 独立拉一路代价只是本地带宽（qn=150 约 100~200KB/s），不影响转写路径的稳定。
 *
 * 分片必须从 I 帧开始，并且带上 AVCDecoderConfigurationRecord（序列头），
 * 否则 PyAV 解不开 —— 这是「抽帧」能不能跑通的关键，不是可选优化。
 */
import fs from 'node:fs'
import { getPlayUrl, FlvSplitter } from './audio.mjs'
import { headersOf } from './live.mjs'

const FLV_HEADER = Buffer.from([0x46, 0x4c, 0x56, 0x01, 0x05, 0x00, 0x00, 0x00, 0x09, 0x00, 0x00, 0x00, 0x00])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export class VisionTap {
  constructor({ getUrl, roomId, dir, intervalMs = 300000, qn = '150', onSlice = () => {}, onLog = () => {} }) {
    this.getUrl = getUrl
    this.roomId = roomId
    this.dir = dir
    this.qn = qn
    this.intervalMs = Math.max(10000, Math.min(1800000, Number(intervalMs) || 300000))
    this.onSlice = onSlice
    this.onLog = onLog
    this.stopped = true
    this.ac = null
    this.seqHeader = null   // AVC 序列头（raw tag）
    this.gop = []           // 从最近一个主帧开始累积的 raw tag
    this.gopBytes = 0
    this.seq = 0
    this.timer = null
    this.stats = { slices: 0, tags: 0, bytesIn: 0, reconnects: 0, lastError: '', lastShotAt: 0 }
  }

  start() {
    if (!this.stopped) return this
    this.stopped = false
    this.timer = setInterval(() => this.#emit('tick'), this.intervalMs)
    this.#loop()
    return this
  }

  stop() {
    this.stopped = true
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    try { this.ac?.abort() } catch { /* 忽略 */ }
  }

  status() {
    return { ...this.stats, stopped: this.stopped, intervalMs: this.intervalMs, gopTags: this.gop.length }
  }

  async #loop() {
    while (!this.stopped) {
      try {
        await this.#pump()
      } catch (e) {
        if (this.stopped) break
        this.stats.lastError = String(e?.message || e)
        this.onLog(`画面流断开：${this.stats.lastError}（5 秒后重连）`)
      }
      if (this.stopped) break
      this.stats.reconnects++
      await sleep(5000)
    }
  }

  async #pump() {
    const { url } = await this.getUrl(this.qn)
    const ac = new AbortController()
    this.ac = ac
    const r = await fetch(url, { headers: headersOf(null), signal: ac.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const splitter = new FlvSplitter()
    let lastData = Date.now()
    const watchdog = setInterval(() => {
      if (Date.now() - lastData > 90000) { try { ac.abort() } catch { /* 忽略 */ } }
    }, 15000)
    try {
      for await (const chunk of r.body) {
        if (this.stopped) break
        lastData = Date.now()
        this.stats.bytesIn += chunk.length
        for (const tag of splitter.push(chunk)) {
          if (tag.type === 9) this.#videoTag(tag)
        }
      }
    } finally {
      clearInterval(watchdog)
      if (this.ac === ac) this.ac = null
    }
  }

  #videoTag(tag) {
    const data = tag.raw.subarray(11, tag.raw.length - 4)
    if (data.length < 5) return
    const frameType = data[0] >> 4
    const codecId = data[0] & 0x0f
    if (codecId !== 7) return
    if (data[1] === 0) { this.seqHeader = tag.raw; return }   // AVCDecoderConfigurationRecord
    if (data[1] !== 1) return
    this.stats.tags++
    if (frameType === 1) {
      this.gop = [tag.raw]
      this.gopBytes = tag.raw.length
      return
    }
    if (!this.gop.length) return
    this.gop.push(tag.raw)
    this.gopBytes += tag.raw.length
    // 一个 GOP 留 4 秒就够抽帧了，再长纯浪费内存
    while (this.gopBytes > 4 * 1024 * 1024 && this.gop.length > 2) this.gopBytes -= this.gop.shift().length
  }

  #emit(reason) {
    if (this.stopped) return
    if (!this.seqHeader || !this.gop.length) return
    const parts = [FLV_HEADER, this.seqHeader, ...this.gop]
    const buf = Buffer.concat(parts)
    const seq = ++this.seq
    const file = `${this.dir}/shot-${this.roomId}-${Date.now()}-${seq}.flv`
    try {
      fs.writeFileSync(file, buf)
      this.stats.slices++
      this.stats.lastShotAt = Date.now()
      this.onSlice({ file, tagCount: this.gop.length, bytes: buf.length, reason })
    } catch (e) {
      this.onLog(`写画面分片失败：${e?.message || e}`)
    }
  }
}

/** 序列头只在流开头出现一次，跟着 tag 一起存下来 */
export function isAvcSeqHeader(data) {
  return data.length >= 5 && (data[0] & 0x0f) === 7 && data[1] === 0x00
}

export { getPlayUrl }
