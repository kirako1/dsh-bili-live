/**
 * lib/config.mjs —— 插件配置的形状与清洗
 * ============================================================================
 * 配置存 `<家>/config.json`，由设置页通过 /api/bili-live/config 改写。
 * 这里只做两件事：给默认值、把外面传进来的脏数据洗成能用的形状。
 * ============================================================================
 */

import { DEFAULT_WEIGHTS } from './rating.mjs'

export const DEFAULTS = {
  /** 总开关：关掉就完全不连直播间 */
  enabled: true,
  /** 你的 B站 昵称 —— 自我介绍用它，也是识别「有人在叫我」的主要依据 */
  username: '',
  /** 额外触发词（别人可能叫你别的叫法） */
  aliases: [],
  /** 被叫到时是否自动回复 */
  autoReply: true,
  /**
   * 自由回复：**固定开启、不给关** —— 除第一次自我介绍外，
   * 每次被叫到都由模型看着当前弹幕临场回一句。
   */
  freeReply: true,
  /** 固定回复兜底：模型没接上 / 生成失败时，退回下面这句模板；关掉就宁可不发 */
  fixedReply: true,
  /** 固定回复用的那句话 */
  replyTemplate: '在的，有事叫我～',
  /**
   * 用宿主哪个模型自由回复 / 写直播总结。
   * **留空 = 跟随 DSH 当前的默认模型**（推荐）；填了才强制走那条路由。
   */
  llmProvider: '',
  llmModel: '',
  /** 一场直播结束后要不要写总结 */
  recapEnabled: true,
  /** 弹幕少于这么多条就不写了（空直播间不值得记） */
  recapMinDanmaku: 3,
  /** 每个直播间第一次回复时的自我介绍；{name} 会换成上面的昵称 */
  introTemplate: '我是bilibili用户{name}的ai小助手',
  /** 同一房间两条回复的最小间隔（毫秒） */
  cooldownMs: 20000,
  /** 每天最多回几条（0 = 不回） */
  dailyLimit: 30,
  /**
   * 启用关注名单（优先级）。关掉 = 完全不看名单、改成随机巡场，
   * 但名单内容原样保留（再打开就接着用，不会丢）。
   */
  priorityEnabled: true,
  /** 随机巡场在每个直播间看多久就换台（默认 30 分钟） */
  randomWatchMs: 1_800_000,
  /** 随机逛直播的喜好关键词：标题或分区命中就优先（空 = 纯随机） */
  randomKeywords: [],
  /** 一场直播结束给主播打分（0~10） */
  ratingEnabled: true,
  /** 分数达到多少值得推送（用户要求：高于 8 分） */
  ratingPushScore: 8,
  /**
   * 高分推送给哪个 B站 UID。留空 = 只在面板/笔记里留分，不发私信。
   * 注意：B站 不允许给自己发私信（code 21026），所以这里不能填当前登录账号。
   */
  ratingPushUid: '',
  /**
   * 评分八维权重（百分数）。用户可以在设置页自己拖 —— 默认就是原来那套
   * 15/10/20/20/10/15/5/5。不要求和等于 100，算分时按总和归一。
   */
  ratingWeights: { ...DEFAULT_WEIGHTS },
  /** 多久检查一次主播开播状态（毫秒） */
  pollMs: 60000,
  /** 单条弹幕最多几个字（B站普通用户上限 20） */
  maxLen: 20,
  /**
   * 听直播里的声音：拉音频 → 本地 faster-whisper 转写 → 关键词命中就接话。
   * 默认关：它吃 CPU（转写约 0.25 倍速实时）和流量（约 175KB/s）。
   */
  listenAudio: false,
  /** 每片声音多长（毫秒）：越短延迟越小，但切得越碎、识别越差 */
  audioSliceMs: 15000,
  /** 拉流清晰度（qn 越小越省流量，80=流畅） */
  audioQn: 80,
  /** Whisper 模型：tiny / base / small / medium（越大越准也越慢） */
  asrModel: 'small',
  /** 语音语言：auto=每片自动识别（主播会中日英混说），也可钉死 zh / ja / en */
  asrLang: 'auto',
  /** 指定 python 解释器（留空 = 自动找 bili-duty 装好的那套 ASR 环境） */
  asrPython: '',
  /** 听到这些词就接一句（留空 = 只记录不开口） */
  audioKeywords: [],
  /** 语音命中关键词后是否真的发弹幕（还要 autoReply 开着） */
  audioReply: true,
  /** 语音触发的两条之间至少隔多久（毫秒） */
  audioReplyCooldownMs: 60000,
  /** 转写出来的话要不要一起写进直播总结 */
  audioInRecap: true,
  /** 调试用：保留分片音频文件不删（默认删） */
  audioKeepFiles: false,
  /**
   * 看直播的画面：另拉一路视频流，隔一阵抽一帧存成图，
   * 这场直播结束时把几张图一起交给模型，让它说说画面上在干什么。
   * 默认关：多一路流量（qn=150 约 100~200KB/s），且每张图都要花 token。
   */
  visionEnabled: false,
  /** 隔多久抽一帧（毫秒）；越小越贵，5 分钟够用了 */
  visionIntervalMs: 300000,
  /** 一场直播最多留几张（到量就不再抽） */
  visionMaxShots: 24,
  /** 写总结时要不要把画面一起给模型看 */
  visionInRecap: true,
  /** 总结里最多塞几张（越多越贵，3 张足够代表一场） */
  visionShotsInRecap: 3,
  /**
   * 关注的主播，**数组顺序就是优先级**（越靠前越优先）。
   * 形如 { id, mid, roomId, name, enabled }
   *   mid    = 主播 UID（推荐，主播改名/换房间跟着人走）
   *   roomId = 直播间号（只给了房间号时用）
   */
  streams: [],
}

const clampNum = (v, lo, hi, dflt) => {
  const n = Number(v)
  if (!Number.isFinite(n)) return dflt
  return Math.min(hi, Math.max(lo, Math.round(n)))
}

const cleanStr = (v, max) => String(v ?? '').trim().slice(0, max)

/** 清洗一条主播记录；认不出身份就返回 null */
export function normalizeStream(raw) {
  if (!raw || typeof raw !== 'object') return null
  const mid = cleanStr(raw.mid, 20).replace(/\D/g, '')
  const roomId = cleanStr(raw.roomId, 20).replace(/\D/g, '')
  if (!mid && !roomId) return null
  const name = cleanStr(raw.name, 30)
  return {
    id: cleanStr(raw.id, 40) || (mid ? `mid:${mid}` : `room:${roomId}`),
    mid,
    roomId,
    name: name || (mid ? `主播 ${mid}` : `房间 ${roomId}`),
    enabled: raw.enabled !== false,
  }
}

/** 把任意输入洗成一份完整配置（保留数组顺序 = 优先级） */
export function normalizeConfig(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const streams = Array.isArray(r.streams) ? r.streams.map(normalizeStream).filter(Boolean).slice(0, 30) : []
  return {
    enabled: r.enabled !== false,
    username: cleanStr(r.username, 20),
    aliases: Array.isArray(r.aliases)
      ? [...new Set(r.aliases.map((x) => cleanStr(x, 20)).filter(Boolean))].slice(0, 10)
      : [],
    autoReply: r.autoReply !== false,
    freeReply: true,
    fixedReply: r.fixedReply !== false,
    replyTemplate: cleanStr(r.replyTemplate, 40) || DEFAULTS.replyTemplate,
    llmProvider: cleanStr(r.llmProvider, 40),
    llmModel: cleanStr(r.llmModel, 60),
    recapEnabled: r.recapEnabled !== false,
    recapMinDanmaku: clampNum(r.recapMinDanmaku, 1, 500, DEFAULTS.recapMinDanmaku),
    priorityEnabled: r.priorityEnabled !== false,
    randomWatchMs: clampNum(r.randomWatchMs, 60_000, 14_400_000, DEFAULTS.randomWatchMs),
    randomKeywords: Array.isArray(r.randomKeywords)
      ? [...new Set(r.randomKeywords.map((x) => cleanStr(x, 20)).filter(Boolean))].slice(0, 12)
      : [],
    ratingEnabled: r.ratingEnabled !== false,
    ratingPushScore: clampNum(r.ratingPushScore, 1, 10, DEFAULTS.ratingPushScore),
    ratingPushUid: cleanStr(r.ratingPushUid, 20).replace(/\D/g, ''),
    ratingWeights: (() => {
      const given = r.ratingWeights && typeof r.ratingWeights === 'object' ? r.ratingWeights : {}
      const out = {}
      for (const [k, fallback] of Object.entries(DEFAULT_WEIGHTS)) {
        out[k] = clampNum(given[k] === undefined ? fallback : given[k], 0, 100, fallback)
      }
      return out
    })(),
    introTemplate: cleanStr(r.introTemplate, 60) || DEFAULTS.introTemplate,
    cooldownMs: clampNum(r.cooldownMs, 5000, 600000, DEFAULTS.cooldownMs),
    dailyLimit: clampNum(r.dailyLimit, 0, 200, DEFAULTS.dailyLimit),
    pollMs: clampNum(r.pollMs, 20000, 600000, DEFAULTS.pollMs),
    maxLen: clampNum(r.maxLen, 5, 40, DEFAULTS.maxLen),
    listenAudio: r.listenAudio === true,
    audioSliceMs: clampNum(r.audioSliceMs, 6000, 60000, DEFAULTS.audioSliceMs),
    audioQn: clampNum(r.audioQn, 80, 10000, DEFAULTS.audioQn),
    asrModel: ['tiny', 'base', 'small', 'medium'].includes(String(r.asrModel)) ? String(r.asrModel) : DEFAULTS.asrModel,
    asrLang: ['auto', 'zh', 'ja', 'en'].includes(String(r.asrLang)) ? String(r.asrLang) : DEFAULTS.asrLang,
    asrPython: cleanStr(r.asrPython, 300),
    audioKeywords: Array.isArray(r.audioKeywords)
      ? [...new Set(r.audioKeywords.map((x) => cleanStr(x, 20)).filter(Boolean))].slice(0, 20)
      : [],
    audioReply: r.audioReply !== false,
    audioReplyCooldownMs: clampNum(r.audioReplyCooldownMs, 15000, 1800000, DEFAULTS.audioReplyCooldownMs),
    audioInRecap: r.audioInRecap !== false,
    audioKeepFiles: r.audioKeepFiles === true,
    visionEnabled: r.visionEnabled === true,
    visionIntervalMs: clampNum(r.visionIntervalMs, 30000, 1800000, DEFAULTS.visionIntervalMs),
    visionMaxShots: clampNum(r.visionMaxShots, 1, 120, DEFAULTS.visionMaxShots),
    visionInRecap: r.visionInRecap !== false,
    visionShotsInRecap: clampNum(r.visionShotsInRecap, 1, 6, DEFAULTS.visionShotsInRecap),
    streams,
  }
}

/** 只把 patch 里出现过的字段合并进旧配置（设置页可以只传改动的那几项） */
export function mergeConfig(oldCfg, patch) {
  const base = normalizeConfig(oldCfg)
  if (!patch || typeof patch !== 'object') return base
  const merged = { ...base }
  for (const k of Object.keys(DEFAULTS)) {
    if (k in patch) merged[k] = patch[k]
  }
  return normalizeConfig(merged)
}

/** 单条弹幕截到 maxLen（B站超长会直接被拒） */
export function clipText(text, maxLen) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return s.length > maxLen ? s.slice(0, maxLen) : s
}
