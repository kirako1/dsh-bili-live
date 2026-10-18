/**
 * lib/recap.mjs —— 一场直播的笔记
 * ============================================================================
 * 进来的每一条弹幕都记着（有人说话说明这一刻有内容），主播下播时把这场直播
 * 收成一张 txt：什么时间、谁在播、多热闹、大概发生了什么。
 *
 * 文件名就是用户要的「年-月-日 主播名字.txt」，统一躺在 `<家>/recaps/` 下，
 * 插件面板上那个「打开文件夹」按钮直接把这个目录交给资源管理器。
 * ============================================================================
 */
import { mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_ITEMS = 20000 // 记太多没意义，留最近这些
const MAX_SPEECH = 4000 // 语音转写的段落也要封顶（一场几小时能转几千句）

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 2026-10-17 */
export function dayStamp(ms = Date.now()) {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 21:03 */
export function clockStamp(ms = Date.now()) {
  const d = new Date(ms)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 1 小时 19 分 */
export function humanSpan(ms) {
  const min = Math.max(0, Math.round(ms / 60000))
  if (min < 60) return `${min} 分钟`
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`
}

/** Windows 文件名里不能出现的字符，一律换成空格 */
function safeName(s) {
  return String(s || '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40)
}

/* ────────────────────────── 记录器 ────────────────────────── */

export class LiveRecorder {
  /**
   * @param {{roomId:number, uid:string, uname:string, title:string, startedAt?:number}} o
   */
  constructor(o) {
    this.roomId = o.roomId
    this.uid = String(o.uid || '')
    this.uname = String(o.uname || '')
    this.title = String(o.title || '')
    this.startedAt = o.startedAt || Date.now()
    this.endedAt = 0
    this.items = [] // {t, name, text, uid}
    this.speech = [] // 主播说话的转写 {t, text}
    this.dropped = 0
  }

  /** 记一段主播说话（ASR 转写结果） */
  addSpeech(text, at = Date.now()) {
    const s = String(text || '').replace(/\s+/g, ' ').trim()
    if (s.length < 2) return
    // 重复的转写（同一句被两次切片带出来）就只留一条
    const last = this.speech[this.speech.length - 1]
    if (last && last.text === s && at - last.t < 8000) return
    this.speech.push({ t: at, text: s.slice(0, 300) })
    if (this.speech.length > MAX_SPEECH) this.speech.splice(0, this.speech.length - MAX_SPEECH)
  }

  get speechSize() {
    return this.speech.length
  }

  /** 均匀抽几段主播原话 */
  speechSample(n = 30) {
    const list = this.speech
    if (list.length <= n) return list
    const step = list.length / n
    const out = []
    for (let i = 0; i < n; i += 1) out.push(list[Math.floor(i * step)])
    return out
  }

  /** 喂给模型的「主播说了什么」 */
  speechDigest(n = 40) {
    if (!this.speech.length) return ''
    return this.speechSample(n)
      .map((it) => `${clockStamp(it.t)} ${it.text}`)
      .join('\n')
      .slice(0, 6000)
  }

  push(d) {
    // 弹幕客户端给的字段是 { uid, uname, text, ts }，这里兼容 name/t 两种叫法，
    // 否则昵称和时间都会静默丢成空串（2026-10-18 的笔记就只剩纯文本）。
    const at = typeof d?.t === 'number' ? d.t : (typeof d?.ts === 'number' ? d.ts : Date.now())
    this.items.push({
      t: at,
      name: String(d?.name || d?.uname || ''),
      text: String(d?.text || '').slice(0, 200),
      uid: String(d?.uid || ''),
    })
    if (this.items.length > MAX_ITEMS) {
      this.items.splice(0, this.items.length - MAX_ITEMS)
      this.dropped += 1
    }
  }

  get size() {
    return this.items.length
  }

  /** 结束时间只认第一次（重复调用不往后拖） */
  close(at = Date.now()) {
    if (!this.endedAt) this.endedAt = at
    return this.endedAt
  }

  /** 按分钟统计，找出最热闹的那一分钟 */
  hotMinute() {
    if (!this.items.length) return null
    const bag = new Map()
    for (const it of this.items) {
      const k = Math.floor(it.t / 60000)
      bag.set(k, (bag.get(k) || 0) + 1)
    }
    let best = null
    for (const [k, n] of bag) if (!best || n > best.n) best = { k, n }
    return best ? { at: best.k * 60000, count: best.n } : null
  }

  /** 均匀抽样 n 条（首尾都留，别只留开头） */
  sample(n = 60) {
    const list = this.items
    if (list.length <= n) return list
    const step = list.length / n
    const out = []
    for (let i = 0; i < n; i += 1) out.push(list[Math.floor(i * step)])
    return out
  }

  /** 参与人数（没 uid 的按昵称算） */
  speakers() {
    const s = new Set()
    for (const it of this.items) s.add(it.uid || `n:${it.name}`)
    return s.size
  }

  /** 粗略高频词：中文按 2 字切，不要标点 */
  keywords(top = 12) {
    const stop = new Set(['什么', '这个', '那个', '就是', '不是', '没有', '可以', '我们', '你们', '他们', '哈哈', '哈哈哈', '一个', '现在', '真的', '怎么', '还是', '已经', '这样', '然后'])
    const bag = new Map()
    for (const it of this.items) {
      const clean = it.text.replace(/[\s\p{P}\p{S}\d]/gu, '')
      for (let i = 0; i + 2 <= clean.length; i += 1) {
        const w = clean.slice(i, i + 2)
        if (stop.has(w)) continue
        bag.set(w, (bag.get(w) || 0) + 1)
      }
    }
    return [...bag.entries()]
      .filter(([, n]) => n >= 3)
      .sort((a, b) => b[1] - a[1])
      .slice(0, top)
      .map(([w, n]) => ({ w, n }))
  }

  /** 喂给模型的那段采样文本 */
  digest(n = 70) {
    return this.sample(n)
      .map((it) => `${clockStamp(it.t)} ${it.name}：${it.text}`)
      .join('\n')
      .slice(0, 6000)
  }

  /** 落盘的正文（summary 为空时走本地统计版） */
  toText(summary, extra = {}) {
    const end = this.endedAt || Date.now()
    const lines = []
    lines.push(`${dayStamp(this.startedAt)} · ${this.uname || '未知主播'} 的直播`)
    lines.push('='.repeat(46))
    lines.push(`直播间：https://live.bilibili.com/${this.roomId}`)
    if (this.title) lines.push(`开播标题：${this.title}`)
    lines.push(`观看时段：${clockStamp(this.startedAt)} ~ ${clockStamp(end)}（${humanSpan(end - this.startedAt)}）`)
    lines.push(`弹幕：共 ${this.size} 条${this.size ? `，${this.speakers()} 人发言` : ''}`)
    if (this.speech.length) lines.push(`语音：转写出 ${this.speech.length} 段主播说的话`)
    // 记的是「真实在线人数」（rank 接口的 onlineNum）；B站 的 room.online 是虚高几百倍的人气值，别混
    if (extra.online) lines.push(`同接峰值：${extra.online} 人在看`)
    if (extra.rating) {
      const r = extra.rating
      const p = r.parts || {}
      lines.push(`评分：${r.score}/10${r.tier ? `（${r.tier.tier} 档 · ${r.tier.text}）` : ''}`)
      // 逐项列出来，方便日后回看「这个分是怎么来的」；新加的维度会自动出现在这里
      const items = Object.values(p)
      if (items.length) {
        const half = Math.ceil(items.length / 2)
        const fmt = (x) => `${x.label} ${x.value}（${x.points} 分）`
        lines.push(`　${items.slice(0, half).map(fmt).join(' · ')}`)
        if (items.length > half) lines.push(`　${items.slice(half).map(fmt).join(' · ')}`)
      }
    }
    lines.push('='.repeat(46))
    lines.push('')
    lines.push('【这场直播大概发生了什么】')
    if (summary) {
      lines.push(summary)
    } else {
      const hot = this.hotMinute()
      const kw = this.keywords(8)
      lines.push(`这场直播从 ${clockStamp(this.startedAt)} 持续到 ${clockStamp(end)}，记录到 ${this.size} 条弹幕。`)
      if (hot) lines.push(`最热闹的时候是 ${clockStamp(hot.at)} 前后，一分钟里刷了 ${hot.count} 条。`)
      if (kw.length) lines.push(`聊得最多的词：${kw.map((k) => k.w).join('、')}。`)
    }
    lines.push('')

    // 模型自己写的那段主观评价，单独成一节（没接上模型时就没有）
    if (extra.aiWords) {
      lines.push('【大肥鱼的评价】')
      lines.push(extra.aiWords)
      lines.push('')
    }

    const hot = this.hotMinute()
    if (hot) {
      lines.push('【最热闹的一分钟】')
      lines.push(`${clockStamp(hot.at)} 前后（${hot.count} 条）`)
      lines.push('')
    }

    const picks = this.sample(40)
    if (picks.length) {
      lines.push('【弹幕摘录】')
      for (const it of picks) lines.push(`${clockStamp(it.t)} ${it.name}：${it.text}`)
      lines.push('')
    }

    const said = this.speechSample(60)
    if (said.length) {
      lines.push('【主播说了什么】（本机语音转写，可能有错字）')
      for (const it of said) lines.push(`${clockStamp(it.t)} ${it.text}`)
      lines.push('')
    }

    lines.push('— 由 DSH bili-live 插件自动记录 —')
    return lines.join('\n')
  }
}

/* ────────────────────────── 落盘 ────────────────────────── */

export function recapDir(home) {
  const dir = join(home, 'recaps')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * 写一张直播笔记。
 * @returns {{path:string, name:string}}
 */
export function writeRecap(home, recorder, summary, extra) {
  const dir = recapDir(home)
  // 文件名带上开始时刻（21-03 这种）：同一主播一天看两次也不会互相覆盖
  const clock = clockStamp(recorder.startedAt).replace(':', '-')
  const name = `${dayStamp(recorder.startedAt)} ${safeName(recorder.uname) || '未知主播'} ${clock}.txt`
  let path = join(dir, name)
  // 同一天同一个人两场（比如断线重开）就别覆盖，加个序号
  if (statSync0(path)) {
    let i = 2
    while (statSync0(join(dir, `${name.replace(/\.txt$/, '')} (${i}).txt`))) i += 1
    path = join(dir, `${name.replace(/\.txt$/, '')} (${i}).txt`)
  }
  writeFileSync(path, recorder.toText(summary, extra), 'utf8')
  return { path, name }
}

function statSync0(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** 最近的笔记（面板上列出来用） */
export function listRecaps(home, limit = 12) {
  try {
    const dir = recapDir(home)
    return readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => {
        const full = join(dir, f)
        const st = statSync(full)
        return { name: f, path: full, size: st.size, mtime: st.mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } catch {
    return []
  }
}
