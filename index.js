/**
 * dsh-bili-live —— host 半端
 * ============================================================================
 * 它做什么：用你的 B站 账号做直播助手：看直播、写笔记、给主播打分。
 *   1. 定时看关注的主播谁在播，**按数组顺序（优先级）**进第一个开播的房间；
 *   2. 进去只「听」弹幕，**不说话**；
 *   3. 只有弹幕里出现你的昵称 / @你 / 别名时，才回一句
 *      —— 第一次先自我介绍，之后让模型自己想说什么（不用预定词）；
 *   4. 一场直播结束，把这段直播收成一张 txt 笔记（`<家>/recaps/2026-10-17 主播.txt`）。
 *
 * 家目录：`$DSH_HOME/bili-live/`
 *   config.json      设置页写的那份
 *   state.json       今天回了几条、哪些房间已经介绍过自己
 *   credential.json  本插件自己扫码登录得到的凭证（有这个就优先用）
 *   live.log         运行日志
 *   recaps/          直播笔记
 *
 * 凭证只认本插件自己扫码登录得到的 `credential.json`，不借用其它插件的登录态。
 * ============================================================================
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DanmakuClient,
  getRandomLiveRooms,
  getRoomByUid,
  getRoomInfo,
  isOwnMedal,
  parseBlockEvent,
  parseInteractWord,
  sendDanmaku,
  sendPrivateMsg,
} from './lib/live.mjs'
import { DEFAULTS, clipText, mergeConfig, normalizeConfig, normalizeStream } from './lib/config.mjs'
import { generateQr, pollQr, qrSvg, whoAmI } from './lib/auth.mjs'
import { makeLlm } from './lib/llm.mjs'
import { LiveRecorder, listRecaps, recapDir, writeRecap } from './lib/recap.mjs'
import { AudioTap, getPlayUrl } from './lib/audio.mjs'
import { VisionTap } from './lib/vision.mjs'
import { AsrWorker, findPython } from './lib/asr.mjs'
import { clearRoomTmp, mb, sweepTmp } from './lib/cleanup.mjs'
import { collectStats, computeScore, scoreTier, buildWeights } from './lib/rating.mjs'
import { makeModerator } from './lib/moderation.mjs'

export const name = 'bili-live'
export const inject = ['webServer']

const MAX_LOGS = 60

function stateDirOf(ctx) {
  let dir = ''
  try {
    const p = ctx?.get?.('dshHomePath')
    if (typeof p === 'function') {
      const v = p('bili-live')
      if (v) dir = String(v)
    } else if (typeof p === 'string' && p) {
      dir = join(p, 'bili-live')
    }
  } catch { /* 拿不到就兜底 */ }
  if (!dir) dir = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'bili-live')
  mkdirSync(dir, { recursive: true })
  return dir
}

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, value) {
  try { writeFileSync(file, JSON.stringify(value, null, 2), 'utf8') } catch { /* 写不动就算了 */ }
}

function dayKey() {
  const d = new Date(Date.now() + 8 * 3600 * 1000) // 北京时间
  return d.toISOString().slice(0, 10)
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.statusCode = code
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (c) => {
      s += c
      if (s.length > 1e6) { req.destroy(); resolve({}) }
    })
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')) } catch { resolve({}) } })
  })
}

export function apply(ctx) {
  const home = stateDirOf(ctx)
  const cfgFile = join(home, 'config.json')
  const stateFile = join(home, 'state.json')
  const pushedFile = join(home, 'pushed.json')
  const logFile = join(home, 'live.log')

  /** 已经推送过的主播（upUid → {uname, score, at, roomId}），同一个主播只推一次 */
  const loadPushed = () => readJson(pushedFile, {})
  const savePushed = (m) => writeJson(pushedFile, m)

  const pluginDir = dirname(fileURLToPath(import.meta.url))
  let version = ''
  try { version = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8')).version || '' } catch { version = '' }

  const cfg = normalizeConfig(readJson(cfgFile, DEFAULTS))
  const st = readJson(stateFile, {})
  const state = {
    introDone: st?.introDone && typeof st.introDone === 'object' ? st.introDone : {},
    today: st?.today || dayKey(),
    replyCount: Number(st?.replyCount) || 0,
    lastReplyAt: st?.lastReplyAt && typeof st.lastReplyAt === 'object' ? st.lastReplyAt : {},
  }
  if (state.today !== dayKey()) {
    state.today = dayKey()
    state.replyCount = 0
  }

  const logs = []
  const log = (msg) => {
    const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`
    logs.push(line)
    if (logs.length > MAX_LOGS) logs.shift()
    try { appendFileSync(logFile, line + '\n', 'utf8') } catch { /* 不致命 */ }
  }

  const saveCfg = () => writeJson(cfgFile, cfg)
  const saveState = () => writeJson(stateFile, state)
  const rollDay = () => {
    if (state.today !== dayKey()) {
      state.today = dayKey()
      state.replyCount = 0
      saveState()
    }
  }

  /* ── 凭证：只认本插件自己扫码登录得到的这一份 ──
     不再回退去借「刷B站」的 bili_credential.json —— 插件没登录，就该显示没登录。 */
  const ownCredFile = join(home, 'credential.json')
  /* 用户点过「退出登录」就落个记号，重新扫码时清掉。 */
  const loggedOutFile = join(home, 'logged-out.json')
  const isLoggedOut = () => existsSync(loggedOutFile)
  const loadCred = () => {
    if (isLoggedOut()) return null
    const v = readJson(ownCredFile, null)
    return v?.sessdata ? v : null
  }
  const credSourceOf = () => (loadCred() ? 'own' : '')
  const saveOwnCred = (cred) => {
    try { if (existsSync(loggedOutFile)) unlinkSync(loggedOutFile) } catch { /* 清不掉也不影响登录 */ }
    writeJson(ownCredFile, {
      sessdata: String(cred.sessdata || ''),
      bili_jct: String(cred.bili_jct || ''),
      buvid3: String(cred.buvid3 || ''),
      dedeuserid: String(cred.dedeuserid || ''),
      uname: String(cred.uname || ''),
      saved_at: new Date().toISOString(),
    })
    return ownCredFile
  }

  /* ── 借宿主的模型说人话（拿不到就退化成本地统计） ── */
  const llm = makeLlm(ctx, cfg)
  // 恶意内容审核（隐藏项）：结算时单独问一次模型，失败就不扣分
  const moderator = makeModerator(llm, cfg, (m) => log(m))
  const qrLibFile = join(pluginDir, 'vendor', 'qrcode.js')

  /* ── 运行时 ── */
  const rt = {
    current: null,      // { realRoomId, uname, title, status, since, client }
    recorder: null,     // 当前这场直播的笔记
    lastRecap: null,    // 最近写出来的一张
    timer: null,
    busy: false,
    lastCheckAt: 0,
    lastError: '',
    myUid: '',
    danmakuCount: 0,
    qr: null,           // 正在等扫的那张二维码 { key, at }
    asr: null,          // 转写进程（懒创建，全局一个）
    audio: null,        // 正在听声的这场：{ tap, roomId, transcribed, chars, dropped, lastText }
    audioLastReplyAt: 0,
  }

  const statusOfCurrent = () => {
    const c = rt.current
    if (!c) return null
    return {
      realRoomId: c.realRoomId,
      uname: c.uname,
      title: c.title,
      status: c.status,
      since: c.since,
      url: `https://live.bilibili.com/${c.realRoomId}`,
    }
  }

  /**
   * 主播数据采样：同接和付费人数在直播中途最高，只在结束时采一次会拿到
   * 「人都散了」的回落值，所以中途每 90 秒采一次、各项取历史最大。
   */
  const startRating = (realRoomId, uid, cred) => {
    stopRating()
    rt.rating = { best: null, timer: null }
    const take = () => {
      collectStats(cred, realRoomId, uid)
        .then((s) => {
          const cur = rt.rating
          if (!cur) return
          const b = cur.best
          // 开场关注数要单独记一份：best 里存的是峰值，增量得用「峰值 − 开场」
          if (cur.firstAttn == null && s.attention) cur.firstAttn = s.attention
          // 粉丝团人数同理：开播那一次采到的当基准，结束时拿最后一次采到的，相减就是本场新增
          if (cur.firstFansClub == null && s.fansClub) cur.firstFansClub = s.fansClub
          if (s.fansClub) cur.lastFansClub = s.fansClub
          cur.best = {
            online: Math.max(b?.online || 0, s.online),
            // 任何一次采样采到了同接，这一场就算「已知」——不要求最后一次也成功
            onlineKnown: Boolean(s.onlineKnown || b?.onlineKnown),
            attention: Math.max(b?.attention || 0, s.attention),
            follower: Math.max(b?.follower || 0, s.follower || 0),
            likes: Math.max(b?.likes || 0, s.likes),
            likesPerVideo: s.likesPerVideo || b?.likesPerVideo || 0,
            // 投稿频率是账号属性，不随采样涨落，取最近一次采到的值
            posts30d: s.posts30d || b?.posts30d || 0,
            videoCount: s.videoCount || b?.videoCount || 0,
            popularity: Math.max(b?.popularity || 0, s.popularity),
            payerCount: Math.max(b?.payerCount || 0, s.payerCount),
            // 付费人数、粉丝付费、路人付费必须取自同一次采样，否则分子分母对不上。
            // 这次采到的付费人数不比上次少，就以这次为准
            payerFans: (s.payerCount || 0) >= (b?.payerCount || 0) ? s.payerFans || 0 : b?.payerFans || 0,
            payerStrangers: (s.payerCount || 0) >= (b?.payerCount || 0) ? s.payerStrangers || 0 : b?.payerStrangers || 0,
            guardCount: Math.max(b?.guardCount || 0, s.guardCount),
            upUid: s.upUid || b?.upUid || '',
            area: s.area || b?.area || '',
            title: s.title || b?.title || '',
          }
        })
        .catch(() => { /* 少一次采样不影响大局 */ })
    }
    take()
    rt.rating.timer = setInterval(take, 90000)
    if (rt.rating.timer.unref) rt.rating.timer.unref()
  }

  /** 停采样，把这一场采到的最好成绩交出去（顺便带上开场关注数，算增量要用） */
  const stopRating = () => {
    const r = rt.rating
    if (r?.timer) clearInterval(r.timer)
    rt.rating = null
    if (!r?.best) return null
    // 本场新增粉丝团成员 = 结束时的人数 − 开播时的人数（退团的会是负数，按 0 记）
    const fanGain =
      r.firstFansClub != null && r.lastFansClub != null ? Math.max(0, r.lastFansClub - r.firstFansClub) : 0
    return { ...r.best, firstAttn: r.firstAttn ?? null, fansClub: r.lastFansClub ?? 0, fanGain }
  }

  /**
   * 把本场采样到的画面读成「模型能直接吃的」附件引用。
   * 均匀挑几张（首/中/尾），比全塞进去便宜，也比只塞一张更有代表性。
   */
  const shotRefs = async (shots, max) => {
    const list = Array.isArray(shots) ? shots : []
    if (!list.length) return []
    const att = (() => { try { return ctx.get('attachments') } catch { return null } })()
    if (!att?.saveImage) { log('宿主没有 attachments 服务，画面只能存盘不能进总结'); return [] }
    const n = Math.max(1, Math.min(6, Number(max) || 3))
    const picked = list.length <= n
      ? list
      : n === 1
        // 只要一张时取中间那张（原来的 ((i*(len-1))/(n-1)) 在 n=1 会除以 0）
        ? [list[Math.floor(list.length / 2)]]
        : Array.from({ length: n }, (_, i) => list[Math.round((i * (list.length - 1)) / (n - 1))])
    const refs = []
    for (const s of picked) {
      try {
        const data = readFileSync(s.file)
        refs.push(await att.saveImage({ data: new Uint8Array(data), mediaType: 'image/jpeg', name: 'live-frame.jpg' }))
      } catch (e) {
        log(`画面没有进总结：${e?.message || e}`)
        break
      }
    }
    return refs
  }

  /**
   * 给高分主播写一段「风格 + 评价」，用于私信推送。
   * 单独问一次而不是塞进总结 prompt：只在真要推送时才花这份钱。
   */
  const describeAnchor = async (rec, rating, summary) => {
    if (!llm.available) return ''
    const s = rating.sample || {}
    const prompt = [
      '你刚看完一场 B站 直播。',
      `主播：${rec.uname || '未知'}；分区：${s.area || '未知'}；标题：${rec.title || '（没写）'}；`,
      `这一场：在线 ${s.onlineKnown ? s.online : '未知'} 人、月投稿 ${s.posts30d || 0} 条、获赞率 ${s.likesPerVideo || 0}/稿（满分线 ${Math.round(rating.likeCap)}）、付费 ${s.payerCount || 0} 人（其中路人 ${s.payerStrangers || 0} 人、自家粉丝 ${s.payerFans || 0} 人）、大航海 ${s.guardCount || 0} 位、${rating.speakers || 0} 人开口说话、每分钟 ${rating.dpm} 条弹幕，机器评分 ${rating.score}/10。`,
      summary ? `现场记录：${summary}` : '',
      '',
      '写两小段，各一到两句，用中文：',
      '1）这位主播的直播风格是什么样的（画面、讲话方式、和观众怎么互动）；',
      '2）你看完这场之后对 ta 的评价（值不值得再看）。',
      '要求：平实具体，不要客套、不要吹捧、不要编造这儿没出现的东西。只输出正文，不要编号。',
    ].filter(Boolean).join('\n')
    const out = await llm.generate({
      prompt,
      maxTokens: 1200,
      timeoutMs: 60000,
      onError: (e) => log(`主播评价没接上模型：${e?.message ?? e}`),
    })
    return String(out || '').trim()
  }

  /** 分数过线就推一条私信给用户（接收 UID 在设置页里填；B站不允许发给自己） */
  const pushHighlight = async (rec, rating, summary) => {
    const toUid = String(cfg.ratingPushUid || '').replace(/\D/g, '')
    if (!toUid) {
      log(`本场 ${rating.score} 分（${rating.tier.tier} 档，超过 ${cfg.ratingPushScore}），但没填推送 UID，分数只留在笔记里`)
      return
    }
    const cred = loadCred()
    if (!cred) return
    // 同一个主播一个月内只推一次：按 upUid 判重（改名不影响判重），拿不到 uid 才退回名字
    const s0 = rating.sample || {}
    const pushKey = String(s0.upUid || rec.uname || '').trim()
    if (pushKey) {
      const old = loadPushed()[pushKey]
      const monthMs = 30 * 24 * 3600 * 1000
      const agoMs = Date.now() - (Number(old?.at) || 0)
      if (old && agoMs < monthMs) {
        const days = Math.max(1, Math.round(agoMs / 86400000))
        log(
          `「${rec.uname || pushKey}」${days} 天前推过（${old.score} 分），一个月内不重复推，这场 ${rating.score} 分跳过`,
        )
        return
      }
    }
    const words = await describeAnchor(rec, rating, summary)
    const s = rating.sample || {}
    const lines = [
      `【直播评分 ${rating.score}/10 · ${rating.tier.tier} 档】`,
      `${rec.uname || '未知主播'}｜${s.area || '未知分区'}`,
      s.online
        ? `在线 ${s.online} 人 · 月投稿 ${s.posts30d} 条 · 获赞率 ${s.likesPerVideo}/稿 · 大航海 ${s.guardCount} 位 · 付费 ${s.payerCount} 人（路人 ${s.payerStrangers || 0}）· 这场 ${rating.speakers} 人开口说话`
        : '',
      rec.title ? `标题：${rec.title}` : '',
      '',
      words || summary || '',
      '',
      `https://live.bilibili.com/${rec.roomId}`,
    ]
      .filter((x) => Boolean(x))
      .join('\n')
    const r = await sendPrivateMsg(cred, toUid, lines)
    rt.lastPush = { at: Date.now(), uname: rec.uname, score: rating.score, uid: toUid, ok: r.ok, error: r.ok ? '' : r.message }
    // 只有真发成功才记进判重表 —— 发失败还记账的话，这位主播就永远没机会再被推一次
    if (r.ok && pushKey) {
      const pushed = loadPushed()
      pushed[pushKey] = { uname: rec.uname || '', score: rating.score, at: Date.now(), roomId: rec.roomId }
      savePushed(pushed)
    }
    log(r.ok ? `高分已推送给 ${toUid}：「${rec.uname}」${rating.score} 分` : `高分推送失败：${r.message}`)
  }

  // 评分门槛：同接低于这个数就整场不打分（用户 m06239 定 30，m06298 改 20）。
  // 20 人以下的比率类维度（观众参与、粉丝浓度、两个付费率）分母太小，
  // 一两个人就能顶满，分数会被噪声主导。
  const MIN_ONLINE = 20

  /**
   * 一场直播收尾：评分 → 写笔记 → 高分推送 → 清理中间文件。
   * 不阻塞主流程 —— 调用方不 await 这个函数。
   */
  const finishRecap = async (rec, why, shots, sample) => {
    rec.close()

    // ① 评分：不管笔记写不写都算，面板要显示
    let rating = null
    // 审核结果要留到写总结时用（waived 时得在评价里交代一句），所以提到外面
    let mod = null
    const liveSec = Math.max(0, (rec.endedAt - rec.startedAt) / 1000)
    if (cfg.ratingEnabled && sample && liveSec < 60) {
      // 看得太短就换台（比如被优先级主播挤掉）时样本不够，分数会失真，干脆不打
      log(`这场只看了 ${Math.round(liveSec)} 秒，样本太少，不打分`)
    } else if (cfg.ratingEnabled && sample && !sample.onlineKnown) {
      // 同接是大多数人均维度的分母。拿不到时 computeScore 会退到 crowd=30 / heads=5 的保底值，
      // 20 个人发言就顶到 400% 直接封顶——「因为没数据反而拿满分」，比不打分更糟。
      log('这场没采到同接人数（付费榜接口没返回 onlineNum），人数类维度的分母会失真，这场不打分')
    } else if (cfg.ratingEnabled && sample && sample.online < MIN_ONLINE) {
      // 20 人以下的房间不评。个位数同接时任何小分母比率都会被放大——实测 8 人房 3 人开口
      // （37%）就顶满观众参与、2 个粉丝付费（25%）就顶满粉丝付费率，总分 8.1 A，
      // 和 1871 人、290 人发言、354 人付费的房间只差 1.5 分。样本太小，分数没有意义。
      log(`这场同接只有 ${sample.online} 人（低于 ${MIN_ONLINE}），比率类维度会被小分母放大，不打分`)
    } else if (cfg.ratingEnabled && sample) {
      const minutes = Math.max(1, liveSec / 60)
      const dpm = Math.round((rec.size / minutes) * 10) / 10
      const speakers = rec.speakers()
      // 自家粉人数：弹幕和进房事件里挂着本房牌子的人（两边去重后的并集）
      const fansPresent = rec.fansPresent
      // 本场出现过的总人数（含挂牌的）：粉丝浓度的分母，和挂牌人数同量纲
      const seenCount = rec.seenCount
      // 本场新增关注：关注数只增不减，用「结束值 − 开场值」；没采到开场值就不算
      const attentionGain = sample.firstAttn == null ? 0 : Math.max(0, (sample.attention || 0) - sample.firstAttn)
      // 本场新增粉丝团成员：开播/下播两次采样 fansclub 的差（见 stopRating），路人转化的真实口径
      const fanGain = Number(rec.fanGain) || 0
      const { score, parts, likeCap } = computeScore(
        { ...sample, dpm, speakers, fansPresent, seenCount, attentionGain, fanGain },
        buildWeights(cfg.ratingWeights),
      )
      // likeCap 一定要带出来：它是按粉丝数现算的获赞满分线，日志和评价 prompt 都要用它，
      // 漏了会打成「满分 NaN」（2026-10-20 实测事故）
      rating = { score, parts, likeCap, dpm, speakers, fansPresent, attentionGain, fanGain, tier: scoreTier(score), sample }

      // ①.5 恶意内容审核（隐藏项）：判完再定最终分。它不参与写总结，所以总结正文
      // 不会提到扣分；只有下面两行日志和笔记里的算式会说。
      mod = await moderator.judge(rec)
      if (mod && (mod.penalty || mod.bonus)) {
        const final = Math.min(10, Math.max(0, Math.round((score - mod.penalty + mod.bonus) * 10) / 10))
        rating.rawScore = score
        rating.score = final
        rating.mod = mod
        rating.tier = scoreTier(final)
      }

      // 期望值归一之后，「补正 ×N」那套说法没意义了：现在每项都显示「这场是同规模平均水平的几倍」，
      // 四舍五入到两位，能直接看出这个主播相对同行强在哪、弱在哪
      const expLine = ['interaction', 'speakerRate', 'fansPayRate', 'strangerPayRate']
        .map((k) => rating.parts?.[k])
        .filter((p) => p && p.ratio > 0)
        .map((p) => `${p.label} ×${p.ratio.toFixed(2)}`)
        .join('、')
      log(
        `本场评分 ${rating.score}/10（${rating.tier.tier} 档）：同接 ${sample.online}、${speakers} 人发言、全场挂牌 ${fansPresent} 人、每分钟 ${dpm} 条弹幕、新增粉丝团 ${fanGain} 人（涨粉 ${attentionGain}）、月投稿 ${sample.posts30d}、获赞率 ${sample.likesPerVideo}/稿（满分 ${Math.round(rating.likeCap)}）、付费 ${sample.payerCount}（路人 ${sample.payerStrangers || 0}、自己人 ${sample.payerFans || 0}）、大航海 ${sample.guardCount}${expLine ? `｜相对同规模：${expLine}` : ''}`,
      )
      if (rating.mod) {
        const m = rating.mod
        const sign = `${m.penalty ? ` − ${m.penalty}` : ''}${m.bonus ? ` + ${m.bonus}` : ''}`
        log(
          `权重分 ${rating.rawScore}${sign} = ${rating.score} 分（${rating.tier.tier} 档）｜恶意内容估算 ${m.malicious} 条${m.blocks ? `、封禁 ${m.blocks} 次` : ''}${m.samples.length ? `｜示例「${m.samples[0]}」` : ''}`,
        )
      } else if (mod && mod.blocked) {
        log(
          `恶意内容审核：本场有 ${mod.blocks} 次封禁，已制止过，不扣分（估算 ${mod.malicious} 条）${mod.waived ? '，会在评价里说明' : ''}`,
        )
      } else if (mod && mod.malicious) {
        log(`恶意内容审核：估算 ${mod.malicious} 条，没到 ${mod.threshold} 条扣分线`)
      }
    }

    let summary = ''
    // 模型会先写「这场直播大概发生了什么」，再单独一段「【大肥鱼的评价】」——拆成两块分别排版
    let aiWords = ''
    const enough = rec.size >= cfg.recapMinDanmaku || rec.speechSize > 0
    if (!cfg.recapEnabled || !enough) {
      log(`直播结束（${why}），弹幕 ${rec.size} 条、语音 ${rec.speechSize} 段，不写笔记`)
    } else {
      if (llm.available) {
        const said = cfg.audioInRecap ? rec.speechDigest(40) : ''
        const frames = cfg.visionInRecap ? await shotRefs(shots, cfg.visionShotsInRecap) : []
        // 时段必须显式喂给模型：只写「时长 5 分钟」时，它会拿「肚子饿、点外卖、店12点才开」
        // 这类内容线索自己脑补成「深夜随便开播的杂谈局」——下午 5 点的直播就这么写歪了。
        const hhmm = (ts) => {
          const d = new Date(ts)
          return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
        }
        const startD = new Date(rec.startedAt)
        const startH = startD.getHours()
        const dayPart = startH < 6 ? '凌晨' : startH < 11 ? '上午' : startH < 14 ? '中午' : startH < 18 ? '下午' : startH < 23 ? '晚上' : '深夜'
        const dateStr = `${startD.getMonth() + 1}月${startD.getDate()}日`
        const prompt = [
          `这是一场 B站 直播的现场记录。`,
          `主播：${rec.uname || '未知'}；直播标题：${rec.title || '（没写）'}；`,
          `时间：${dateStr} ${hhmm(rec.startedAt)} ~ ${hhmm(rec.endedAt)}（${dayPart}）；时长：${Math.max(1, Math.round((rec.endedAt - rec.startedAt) / 60000))} 分钟；弹幕共 ${rec.size} 条，${rec.speakers()} 人发言${rec.speechSize ? `；本机还转写出主播说的 ${rec.speechSize} 段话` : ''}。`,
          rating ? `机器给这场直播打的分是 ${rating.score}/10（同接 ${rating.sample.online}、月投稿 ${rating.sample.posts30d}、大航海 ${rating.sample.guardCount}）。` : '',
          '',
          frames.length ? `下面附了 ${frames.length} 张这场直播的画面截图（按时间先后），可以结合画面说画面上在做什么。` : '',
          said ? '主播说的话（本机语音转写，可能有错字，只当语境参考）：' : '',
          said,
          '',
          '弹幕采样（时间 观众：内容）：',
          rec.digest(80),
          '',
          '请用 100~180 个中文字，简单介绍一下这场直播大概发生了什么：聊了什么话题、气氛怎么样、有没有反复出现的事（比如抽奖、连麦、打游戏、唱歌）。',
          '然后另起一行写「【大肥鱼的评价】」，再用 60~120 字写你自己的看法：这场值不值得看、主播是什么路数、你看着是什么感觉。可以主观、可以说人话，像跟朋友聊，但必须贴着上面的记录，别编。',
          mod?.waived
            ? `【这场有个特殊情况，必须写进评价】这场有 ${mod.blocks} 次封禁，同时弹幕里能看到大约 ${mod.malicious} 条明显带节奏、骂人或引战的内容。但 B站 的封禁记录只说封了谁，不说为什么封——所以没法确认房管封的是不是这些恶意弹幕，也可能只是封了刷广告刷屏的。请在【大肥鱼的评价】里用一两句自然的话把这事说清楚：这场确实看到了一些不干净的弹幕，不过现场已经有人封禁处理，自己分不清封的是不是这些，所以这次先不扣分——这是能力所限，不是没问题。不要写成免责声明，也不要提「权重」「审核」「模型」这些内部词。`
            : '',
          '要求：平实具体，不要分点、不要别的小标题、不要客套话、不要编造这儿没出现的内容。',
          `这场直播实际发生在${dateStr}${dayPart}（${hhmm(rec.startedAt)} 开始）。主播提到吃饭、点外卖、下班、上班这类内容时，按这个真实时段去理解，别自行推断成深夜或凌晨。`,
        ].filter(Boolean).join('\n')
        summary = await llm.generate({
          prompt,
          images: frames,
          // 用户要求给足余量：主播聊得多、又要带画面描述，400/1200 都容易写到一半断
          maxTokens: 10000,
          timeoutMs: 90000,
          onError: (e) => log(`直播助手没接上模型：${e?.message ?? e}`),
        })
        // 把「【大肥鱼的评价】」从正文里拆出来，笔记里单独成一小节
        const parts = String(summary || '').split(/【\s*大肥鱼的评价\s*】/)
        if (parts.length > 1) {
          summary = parts[0].trim()
          aiWords = parts.slice(1).join('').trim()
        } else {
          summary = String(summary || '').trim()
        }
      }
      try {
        const { path, name } = writeRecap(home, rec, summary, { rating, online: sample?.online || 0, aiWords })
        rt.lastRecap = { name, path, at: Date.now(), danmaku: rec.size, ai: Boolean(summary), score: rating?.score ?? null }
        log(`直播笔记已写：${name}（${rec.size} 条弹幕${summary ? '，模型总结' : '，本地统计'}）`)
      } catch (e) {
        log(`直播笔记写失败：${e?.message ?? e}`)
      }
    }

    // ② 分数过线就推送。只有随机巡场进来的才推；关注名单里的主播哪怕 10 分，也只在笔记里留个分
    if (rating && rec.random && rating.score > cfg.ratingPushScore) {
      await pushHighlight(rec, rating, summary).catch((e) => log(`高分推送出错：${e?.message ?? e}`))
    }

    // ③ 这一场的切片和截图用完了，删掉（用户要求：别一直占空间）
    try {
      const { files, bytes } = clearRoomTmp(home, rec.roomId)
      if (files) log(`清掉这一场的临时文件 ${files} 个（${mb(bytes)}）`)
    } catch { /* 清不掉不影响别的 */ }
  }

  /** 离开当前直播间；顺手把这场直播的笔记结了 */
  const stopWatching = (why, opts) => {
    clearTimeout(rt.rotateTimer)
    rt.rotateTimer = null
    if (rt.current?.client) {
      try { rt.current.client.stop() } catch { /* 收摊 */ }
      log(`离开直播间 ${rt.current.realRoomId}（${why}）`)
    }
    stopAudio(why)
    // 画面要在 stopVision 之前快照 —— 清空后总结就拿不到这一场的截图了
    const shots = rt.vision?.shots ? rt.vision.shots.slice() : []
    stopVision(why)
    const sample = stopRating()
    rt.current = null
    const rec = rt.recorder
    rt.recorder = null
    // 插件卸载/重启时别写半截笔记
    if (rec && !opts?.silent) finishRecap(rec, why, shots, sample).catch(() => {})
  }

  /* ────────────────────────── 听直播里的声音 ──────────────────────────
   * 链路：flv 直链 → AudioTap 按 tag 切音频片 → 常驻 faster-whisper 转写
   *      → 记进笔记（供总结用）+ 命中 audioKeywords 就接一句。
   * 转写进程是懒创建的，且全局只有一个（多开只会排队，不会互相踩）。
   */
  const audioDir = join(home, 'tmp', 'live')
  const audioLog = (m) => log(m)

  const ensureAsr = () => {
    if (rt.asr) return rt.asr
    rt.asr = new AsrWorker({
      python: findPython(cfg.asrPython),
      model: cfg.asrModel,
      log: audioLog,
    })
    return rt.asr
  }

  const stopAudio = (why) => {
    const a = rt.audio
    rt.audio = null
    if (!a) return
    try { a.tap.stop() } catch { /* 收摊 */ }
    // 旧房间还在排队的转写全部作废，别让 worker 继续嚼已经删掉的切片
    try { rt.asr?.cancelPending(why) } catch { /* 收摊 */ }
    log(`停止听声音（${why}）`)
  }

  /** 开始听当前直播间（已在听同一个房间就不动） */
  const startAudio = (realRoomId, cred) => {
    if (!cfg.listenAudio) return
    // 同一个房间也未必能不重建：分片长度变了就必须换一个新 tap，否则还按旧长度切
    if (rt.audio?.roomId === realRoomId && rt.audio.tap?.sliceMs === cfg.audioSliceMs) return
    // 重建（只是改了分片长度）时接着用已经转写的计数，别让改设置看起来像重来一场
    const keptAudio = rt.audio?.roomId === realRoomId ? rt.audio : null
    stopAudio('换房间')
    const asr = ensureAsr()
    if (!asr.available) {
      rt.lastError = '听声音需要本机装好 faster-whisper（没找到可用的 python）'
      log(rt.lastError)
      return
    }
    try { mkdirSync(audioDir, { recursive: true }) } catch { /* 建不出来就等它报错 */ }
    const tap = new AudioTap({
      getUrl: () => getPlayUrl(realRoomId, cred, { qn: cfg.audioQn }),
      roomId: realRoomId,
      dir: audioDir,
      sliceMs: cfg.audioSliceMs,
      onLog: audioLog,
      onSegment: (seg) => { void handleSegment(seg, realRoomId) },
    })
    rt.audio = {
      tap,
      roomId: realRoomId,
      transcribed: keptAudio?.transcribed || 0,
      chars: keptAudio?.chars || 0,
      dropped: keptAudio?.dropped || 0,
      lastText: keptAudio?.lastText || '',
      startedAt: keptAudio?.startedAt || Date.now(),
    }
    tap.start()
    log(`开始听直播间 ${realRoomId} 的声音（每片 ${(cfg.audioSliceMs / 1000).toFixed(0)} 秒，qn=${cfg.audioQn}）`)
  }

  /* ────────────────────────── 看直播里的画面 ──────────────────────────
   * 链路：再拉一路 flv（只要视频）→ 每 intervalMs 把最近一个 GOP 落成 flv
   *      → python(PyAV) 抽 1 帧存 JPEG（等宽时不重新编码）→ 记进本场画面采样。
   * 采样图不当场描述，攒着等总结时一起给模型，一帧只花一次钱。
   */
  const shotDir = join(home, 'tmp', 'shots')

  const stopVision = (why) => {
    const v = rt.vision
    rt.vision = null
    if (!v) return
    try { v.tap.stop() } catch { /* 收摊 */ }
    log(`停止看画面（${why}）`)
  }

  /** 抽帧：调 python 把 flv 解成一张 jpg（PyAV + Pillow，本机已装）
   *  两处实测坑：① 路径走 stdin 的 JSON —— 中文用户名经 argv 传给 python 会编码走样；
   *  ② python 子进程在沙箱里写不了 ~/.dsh，所以 jpg 由 python 吐到 stdout、这里落盘。 */
  const grabFrame = (flv, jpg) => new Promise((resolve) => {
    const py = findPython(cfg.asrPython)
    if (!py) return resolve({ ok: false, error: '没找到可用的 python' })
    const script = join(pluginDir, 'tools', 'grab_frame.py')
    if (!existsSync(script)) return resolve({ ok: false, error: `缺脚本 ${script}` })
    const p = spawn(py, [script], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    })
    const chunks = []
    let err = ''
    const done = (r) => { try { unlinkSync(flv) } catch { /* 忽略 */ } ; resolve(r) }
    p.stdout.on('data', (d) => { chunks.push(d) })
    p.stderr.on('data', (d) => { err += d })
    p.on('error', (e) => done({ ok: false, error: String(e?.message || e) }))
    p.on('exit', (code) => {
      const buf = Buffer.concat(chunks)
      const lines = err.split('\n').map((x) => x.trim()).filter(Boolean)
      if (code !== 0 || !buf.length) {
        return done({ ok: false, error: (lines.slice(-2).join(' ') || `exit ${code}`).slice(0, 200) })
      }
      try {
        writeFileSync(jpg, buf)
        let meta = {}
        try { meta = JSON.parse(lines[lines.length - 1]) } catch { /* 元信息坏了不影响出图 */ }
        done({ ...meta, ok: true, bytes: buf.length })
      } catch (e) {
        done({ ok: false, error: `截图落盘失败：${String(e?.message || e)}` })
      }
    })
    try {
      p.stdin.write(JSON.stringify({ path: flv, maxWidth: 960 }) + '\n')
      p.stdin.end()
    } catch (e) {
      done({ ok: false, error: `喂参数失败：${String(e?.message || e)}` })
    }
  })

  const startVision = (realRoomId, cred) => {
    if (!cfg.visionEnabled) return
    // 同房间也未必不重建：改了截图间隔就得换个新 tap，否则还按旧间隔走
    if (rt.vision?.roomId === realRoomId && rt.vision.tap?.intervalMs === cfg.visionIntervalMs) return
    // 重建（只是改了间隔）时把这一场已经截到的图接着带上，别让改设置把采样清空
    const keptShots = rt.vision?.roomId === realRoomId ? rt.vision.shots.slice() : []
    stopVision('换房间')
    try { mkdirSync(shotDir, { recursive: true }) } catch { /* 建不出来就等它报错 */ }
    const tap = new VisionTap({
      getUrl: (qn) => getPlayUrl(realRoomId, cred, { qn }),
      roomId: realRoomId,
      dir: shotDir,
      intervalMs: cfg.visionIntervalMs,
      onLog: log,
      onSlice: (s) => { void handleShot(s, realRoomId) },
    })
    rt.vision = { tap, roomId: realRoomId, shots: keptShots, dropped: 0, startedAt: Date.now() }
    tap.start()
    log(`开始看直播间 ${realRoomId} 的画面（每 ${Math.round(cfg.visionIntervalMs / 1000)} 秒 1 帧，上限 ${cfg.visionMaxShots} 帧）`)
  }

  const handleShot = async (s, roomId) => {
    const v = rt.vision
    if (!v || v.roomId !== roomId) { try { unlinkSync(s.file) } catch { /* 忽略 */ } ; return }
    if (v.shots.length >= cfg.visionMaxShots) {
      try { unlinkSync(s.file) } catch { /* 忽略 */ }
      v.dropped += 1
      return
    }
    const jpg = s.file.replace(/\.flv$/, '.jpg')
    const r = await grabFrame(s.file, jpg)
    if (!r.ok) { v.dropped += 1; log(`抽帧失败：${r.error}`); return }
    v.shots.push({ at: Date.now(), file: jpg, w: r.w, h: r.h, bytes: r.bytes })
    log(`画面采样 ${v.shots.length}/${cfg.visionMaxShots}：${r.w}x${r.h} ${Math.round(r.bytes / 1024)}KB`)
  }

  /** 一片声音：转写 → 记下来 → 看关键词 */
  const handleSegment = async (seg, roomId) => {
    const a = rt.audio
    if (!a || a.roomId !== roomId) {
      try { unlinkSync(seg.file) } catch { /* 忽略 */ }
      return
    }
    try {
      const r = await ensureAsr().transcribe(seg.file, {
        lang: cfg.asrLang || 'auto',
        // 给这一片 3 倍切片时长的预算：15 秒的片最多等 45 秒。超了就丢，别拖垮后面的
        timeoutMs: Math.max(45_000, Math.round(Number(cfg.audioSliceMs || 15_000) * 3)),
      })
      if (rt.audio === a) {
        a.transcribed += 1
        a.chars += r.text.length
        if (r.text) a.lastText = r.text
      }
      // 转写恢复正常后清掉陈旧的报错，别让面板一直挂着历史错误
      if (rt.lastError && String(rt.lastError).startsWith('转写失败')) rt.lastError = ''
      if (r.text) {
        const rec = rt.recorder
        if (rec) rec.addSpeech(r.text)
        await handleSpeech(r.text, roomId)
      }
    } catch (e) {
      if (rt.audio === a) a.dropped += 1
      const why = e?.message || String(e)
      // 切台时旧切片已被清掉、或队列主动丢弃：这是正常现象，不算故障
      if (/找不到音频文件|积压过多|取消这段转写/.test(why)) { log(`跳过一段转写：${why}`); return }
      rt.lastError = `转写失败：${why}`
      log(rt.lastError)
      // 连续超时 = 这台机器带不动当前模型：自动退回 small，别一直雪崩
      if (/超时/.test(why)) {
        rt.asrTimeouts = (Number(rt.asrTimeouts) || 0) + 1
        const curModel = String(cfg.asrModel || 'small')
        if (rt.asrTimeouts >= 3 && curModel !== 'small') {
          rt.asrTimeouts = 0
          cfg.asrModel = 'small'
          saveCfg()
          try { rt.asr?.stop() } catch { /* 收摊 */ }
          rt.asr = null
          log(`连续 3 次转写超时：${curModel} 在这台机器上跑不动，已自动降为 small（设置页可以改回来）`)
        }
      } else {
        rt.asrTimeouts = 0
      }
    } finally {
      if (!cfg.audioKeepFiles) { try { unlinkSync(seg.file) } catch { /* 忽略 */ } }
    }
  }

  /** 语音里有没有要说的话题词 */
  const hitKeyword = (text) => {
    const kws = cfg.audioKeywords.map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
    if (!kws.length) return ''
    const lower = String(text || '').toLowerCase()
    for (const k of kws) if (lower.includes(k.toLowerCase())) return k
    return ''
  }

  /** 听到关键词 → 接一句（有自己的冷却，和弹幕回复共用每日额度） */
  const handleSpeech = async (text, roomId) => {
    const hit = hitKeyword(text)
    if (!hit) return
    log(`听到关键词「${hit}」：${text.slice(0, 40)}`)
    if (!cfg.audioReply || !cfg.autoReply || !cfg.username) return
    rollDay()
    if (state.replyCount >= cfg.dailyLimit) return
    const now = Date.now()
    if (now - rt.audioLastReplyAt < cfg.audioReplyCooldownMs) return
    const cred = loadCred()
    if (!cred) return

    let sayWhat = ''
    if (llm.available) {
      const rec = rt.recorder
      const recent = rec ? rec.sample(12).map((x) => `${x.name}：${x.text}`).join('\n') : ''
      const said = rec ? rec.speechDigest(10) : ''
      sayWhat = await llm.generate({
        prompt: [
          `你在 B站 直播间「${rt.current?.uname || ''}」里当观众，账号昵称「${cfg.username}」。`,
          `主播刚才说了：「${String(text).slice(0, 200)}」`,
          said ? `\n前几句主播说的话：\n${said}` : '',
          recent ? `\n最近的弹幕：\n${recent}` : '',
          '',
          `请用 8~${cfg.maxLen} 个中文字接一句自然的话，像观众随口搭腔。不要喊主播名字、不要说自己是机器人或 AI、不要写括号里的动作、不要加引号。只输出这句话本身。`,
        ].filter(Boolean).join('\n'),
        maxTokens: 80,
        timeoutMs: 15000,
        onError: (e) => log(`听声回复没接上模型：${e?.message ?? e}`),
      })
    }
    if (!sayWhat && cfg.fixedReply) sayWhat = cfg.replyTemplate
    const out = clipText(sayWhat, cfg.maxLen)
    if (!out) return

    const r = await sendDanmaku(cred, roomId, out)
    if (r.ok) {
      rt.audioLastReplyAt = Date.now()
      state.lastReplyAt[roomId] = Date.now()
      state.replyCount += 1
      saveState()
      log(`听声回复（命中「${hit}」）：「${out}」`)
    } else {
      rt.lastError = r.message
      log(`听声回复失败：${r.message}`)
    }
  }

  /** 名字命中判定：@我 / 文本里出现昵称或别名 */
  const isCallingMe = (text) => {
    const names = [cfg.username, ...cfg.aliases].map((s) => String(s || '').trim()).filter((s) => s.length >= 2)
    if (!names.length) return false
    const lower = text.toLowerCase()
    for (const n of names) {
      if (lower.includes(n.toLowerCase())) return true
      if (text.includes('@' + n)) return true
    }
    return false
  }

  /**
   * 自由回复：除了第一次的自我介绍，其余被叫到时让模型自己接一句。
   * 模型不可用就返回空，调用方退回固定的 replyTemplate。
   */
  const freeReply = async (d, info) => {
    if (!llm.available) return ''
    const rec = rt.recorder
    const recent = rec
      ? rec.sample(24).map((x) => `${x.name}：${x.text}`).join('\n')
      : ''
    const lines = [
      `你在 B站 直播间「${info?.uname || ''}」的观众席里，账号昵称是「${cfg.username}」。`,
      info?.title ? `直播标题：${info.title}` : '',
      `刚才有人在弹幕里对你说话 —— ${d.uname}：「${d.text}」`,
      recent ? `\n最近这一会儿的弹幕：\n${recent}` : '',
      '',
      `请用 8~${cfg.maxLen} 个中文字回一句自然的话，像直播间的真人观众随口搭腔。`,
      '不要客套、不要说自己是机器人或 AI、不要写括号里的动作、不要加引号、不要解释。只输出这句话本身。',
    ]
    return llm.generate({
      prompt: lines.filter(Boolean).join('\n'),
      maxTokens: 80,
      timeoutMs: 15000,
      onError: (e) => log(`自由回复没接上模型：${e?.message ?? e}`),
    })
  }

  /** 处理一条弹幕：叫到我才回，第一次先自我介绍 */
  const handleDanmaku = async (d, roomId, info) => {
    if (!cfg.autoReply || !cfg.username) return
    if (rt.myUid && d.uid === rt.myUid) return // 自己发的，别自问自答
    if (!isCallingMe(d.text)) return

    rollDay()
    const now = Date.now()
    if (state.replyCount >= cfg.dailyLimit) return
    const last = Number(state.lastReplyAt[roomId]) || 0
    if (now - last < cfg.cooldownMs) return

    const intro = cfg.introTemplate.replace(/\{name\}/g, cfg.username).trim()
    const first = !state.introDone[roomId]
    let sayWhat = ''
    if (first) {
      // 第一次见面：只自报家门 —— 弹幕就 20 个字，硬要再搭一句会把介绍截断
      sayWhat = intro
    } else {
      // 之后一律让模型自己接；失败才退回固定回复（固定回复关掉就宁可不发）
      const gen = await freeReply(d, info)
      if (gen) sayWhat = gen
      else if (cfg.fixedReply) sayWhat = cfg.replyTemplate
    }
    const text = clipText(sayWhat, cfg.maxLen)
    if (!text) return

    const cred = loadCred()
    if (!cred) { rt.lastError = '没有登录凭证'; return }
    const r = await sendDanmaku(cred, roomId, text)
    if (r.ok) {
      state.introDone[roomId] = state.introDone[roomId] || now
      state.lastReplyAt[roomId] = now
      state.replyCount += 1
      saveState()
      log(`回复 ${d.uname}：「${text}」${first ? '（含自我介绍）' : ''}`)
    } else {
      rt.lastError = r.message
      log(`回复失败：${r.message}`)
    }
    void info
  }

  /** 巡场看够了：收摊、写笔记打分，再让 tick 挑下一个 */
  const rotateNow = () => {
    const mins = Math.round(Math.max(60_000, Number(cfg.randomWatchMs) || 1_800_000) / 60_000)
    log(`在「${rt.current?.uname || '这个直播间'}」巡场看够 ${mins} 分钟，换下一个直播间`)
    stopWatching(`巡场看满 ${mins} 分钟`)
    tick().catch(() => {})
  }

  /**
   * 按「当前设定」重设换台倒计时，起点是本场进房时刻。
   * 关键：改设置也算数 —— 把时长调小，这一场会立刻按新值判断（已超就当场换）；
   * 调大则重新等够新时长。只在随机巡场且正在看时才有效。
   */
  const armRotateTimer = () => {
    clearTimeout(rt.rotateTimer)
    rt.rotateTimer = null
    if (!rt.current?.random) return
    const wantMs = Math.max(60_000, Number(cfg.randomWatchMs) || 1_800_000)
    const watchedMs = Date.now() - (Number(rt.current.since) || Date.now())
    const leftMs = wantMs - watchedMs
    if (leftMs <= 0) { rotateNow(); return }
    rt.rotateTimer = setTimeout(rotateNow, leftMs)
    if (rt.rotateTimer.unref) rt.rotateTimer.unref()
  }

  /** 开始看某个直播间。opts.random = 随机巡场进来的（会评分、到点换台） */
  const watch = async (stream, info, opts) => {
    const realRoomId = info.realRoomId || info.roomId || Number(stream.roomId) || 0
    if (!realRoomId) return
    const cred = loadCred()
    if (!cred) { rt.lastError = '没有登录凭证，请在插件设置页扫码登录'; log(rt.lastError); return }

    const recorder = new LiveRecorder({
      roomId: realRoomId,
      uid: info.uid || stream.mid || '',
      uname: info.uname || stream.name,
      title: info.title || '',
      startedAt: Date.now(),
    })
    // 自家粉计数：弹幕和进房事件里都带粉丝牌，谁先看到就先记，最后去重
    const upUidNow = String(info.uid || stream.mid || '')
    const noteMedal = (medal, uid) => {
      if (!uid) return
      // 出现即记一笔：粉丝浓度的分母要用「本场出现过的总人数」，和挂牌人数同量纲
      recorder.noteSeenUid(uid)
      if (isOwnMedal(medal, realRoomId, upUidNow)) recorder.noteMedalUid(uid)
    }
    let client
    client = new DanmakuClient({
      roomId: realRoomId,
      cred,
      onDanmaku: (d) => {
        rt.danmakuCount += 1
        noteMedal(d.medal, d.uid)
        if (rt.recorder === recorder) recorder.push(d)
        handleDanmaku(d, realRoomId, info).catch(() => {})
      },
      // 进房/关注事件：只关心「这个人挂的谁家牌子」，用来算粉丝浓度
      onEvent: (msg) => {
        const ev = parseInteractWord(msg)
        if (ev) { noteMedal(ev.medal, ev.uid); return }
        // 封禁/禁言：只当「有没有人管」的佐证，给恶意内容审核用
        const blk = parseBlockEvent(msg)
        if (blk) recorder.noteBlock(blk)
      },
      // 只更新「属于这个连接」的房间状态：旧连接晚到的回调不能改新房间的显示
      onStatus: (s) => { if (rt.current && rt.current.client === client) rt.current.status = s },
      onLog: (m) => log(m),
    })
    rt.recorder = recorder
    // 记下这场是「随机巡场」还是「守关注名单」——推送只对随机巡场开
    recorder.random = Boolean(opts?.random)
    rt.current = {
      realRoomId,
      uname: info.uname || stream.name,
      title: info.title || '',
      status: 'connecting',
      since: Date.now(),
      client,
      random: Boolean(opts?.random),
    }
    log(
      `进入直播间 ${realRoomId}（${info.uname || stream.name}）${info.title ? '：' + info.title : ''}${opts?.random ? '（随机巡场）' : ''}`,
    )
    await client.start()
    startAudio(realRoomId, cred)
    startVision(realRoomId, cred)
    // 评分：随机巡场和关注名单里的主播都打分（关注的主播只是不推送，见 finishRecap ②）
    startRating(realRoomId, info.uid || stream.mid || '', cred)
    if (opts?.random) {
      // 看够 randomWatchMs 就收摊换人：先结这场（写笔记+评分），再让 tick 挑下一个
      armRotateTimer()
    }
  }

  /**
   * 随机巡场：按喜好关键词挑一个「此刻正在播」的房间进去。
   * 已经随机在看时直接返回（不每轮换台）；在优先级房间里则先收摊（照常写笔记）。
   * reason 只用于日志/收摊原因。返回 true 表示现在确实在一个随机房间里。
   */
  const randomTour = async (cred, reason, opts) => {
    if (rt.current?.random && !opts?.force) return false // 已经在随机看的房间里，别每轮换台
    if (rt.current) stopWatching(reason)
    const rooms = await getRandomLiveRooms(cred, { want: 60, keywords: cfg.randomKeywords })
    if (!rooms.length) { stopWatching('没找到正在播的直播间'); return false }
    // 命中喜好关键词的优先；一个都没命中就退回纯随机（不干待着）
    const matched = rooms.filter((r) => r.matched)
    const others = rooms.filter((r) => !r.matched)
    const recent = rt.recentRooms || []
    const notSeen = (list) => list.filter((r) => !recent.includes(String(r.roomId)))
    // 三层兜底：没看过的命中房 → 没看过的其他房 → 实在没得挑才回到看过的
    let pool = notSeen(matched)
    if (!pool.length) pool = notSeen(others)
    if (!pool.length) pool = matched.length ? matched : rooms
    const pick = pool[Math.floor(Math.random() * pool.length)]
    rt.recentRooms = [String(pick.roomId), ...recent.filter((x) => x !== String(pick.roomId))].slice(0, 12)
    const info2 = await getRoomInfo(pick.roomId, cred)
    if (Number(info2.liveStatus) !== 1) { stopWatching('随机到的房间刚好没在播'); return false }
    log(`${reason}，随机逛进「${pick.uname}」（${pick.roomId}，人气 ${pick.online}${pick.matched ? '，命中喜好' : ''}）`)
    await watch({ name: pick.uname, mid: pick.mid, roomId: pick.roomId }, info2, { random: true })
    return true
  }

  /** 一次检查：按优先级找第一个开播的 */
  const tick = async () => {
    if (rt.busy) return
    rt.busy = true
    rt.lastCheckAt = Date.now()
    try {
      // 顺手扫一遍超龄残留：崩溃/断电留下的孤儿切片不会有人来收
      try {
        const swept = sweepTmp(home)
        if (swept.files) log(`清掉 ${swept.files} 个超龄临时文件（${mb(swept.bytes)}）`)
      } catch { /* 扫不动不影响检查 */ }
      if (!cfg.enabled) { stopWatching('总开关关着'); return }

      const cred = loadCred()
      if (!cred) {
        rt.lastError = '没有登录凭证（请在插件设置页扫码登录）'
        stopWatching('没登录')
        return
      }
      rt.myUid = String(cred.dedeuserid || '')

      // 兜底换台：定时器可能被系统睡眠/异常打断，每轮按「进房时刻 + 当前设定」再核一次
      if (rt.current?.random) {
        const wantMs = Math.max(60_000, Number(cfg.randomWatchMs) || 1_800_000)
        const watchedMs = Date.now() - (Number(rt.current.since) || Date.now())
        if (watchedMs >= wantMs) {
          const mins = Math.round(wantMs / 60_000)
          log(`在「${rt.current.uname}」已看 ${Math.round(watchedMs / 60_000)} 分钟（设定 ${mins} 分钟），换下一个直播间`)
          stopWatching(`巡场看满 ${mins} 分钟`)
        }
      }

      // 优先级关掉时不看名单（名单内容原样保留），直接走随机巡场
      const usePriority = cfg.priorityEnabled !== false
      const targets = usePriority ? cfg.streams.filter((s) => s.enabled !== false) : []
      if (!targets.length) {
        // 随机巡场：常开。没启用优先级、或名单是空的，都会走到这里
        await randomTour(cred, usePriority ? '没填关注' : '优先级关着')
        return
      }

      let picked = null
      for (const s of targets) {
        try {
          const info = s.mid ? await getRoomByUid(s.mid, cred) : await getRoomInfo(s.roomId, cred)
          if (Number(info.liveStatus) === 1) { picked = { stream: s, info }; break }
        } catch (e) {
          rt.lastError = `查主播 ${s.name} 失败：${e?.message || e}`
        }
      }

      if (!picked) {
        rt.lastError = ''
        // 关注的主播一个都没在播：按配置转随机巡场（不干等着）
        if (cfg.randomWhenNoneLive !== false) {
          await randomTour(cred, '关注的主播都没开播')
          return
        }
        stopWatching(rt.recorder ? '主播下播了' : '关注的主播现在都没开播')
        return
      }

      const realRoomId = picked.info.realRoomId || picked.info.roomId
      if (rt.current && rt.current.realRoomId === realRoomId) return // 已经在看，不动
      stopWatching('切到优先级更高的直播间')
      await watch(picked.stream, picked.info)
    } catch (e) {
      rt.lastError = e?.message || String(e)
      log(`检查出错：${rt.lastError}`)
    } finally {
      rt.busy = false
    }
  }

  const schedule = () => {
    if (rt.timer) clearInterval(rt.timer)
    rt.timer = setInterval(() => { tick().catch(() => {}) }, cfg.pollMs)
    if (rt.timer.unref) rt.timer.unref()
  }

  /* ── HTTP 路由（设置页用） ── */
  /* 凭证活性：每 10 分钟问一次「我是谁」。失效（被踢/过期）就不再显示已登录。 */
  const credAlive = { at: 0, alive: null, name: '' }
  const checkCredAlive = (cred) => {
    if (!cred) return
    if (credAlive.alive !== true) credAlive.name = String(cred.uname || '')
    if (Date.now() - credAlive.at < 10 * 60 * 1000) return
    credAlive.at = Date.now()
    whoAmI(cred).then((me) => {
      credAlive.alive = Boolean(me)
      if (me?.uname) {
        credAlive.name = me.uname
        if (cred.uname !== me.uname) {
          try { saveOwnCred({ ...cred, uname: me.uname }) } catch { /* 存不进就只用内存里这份 */ }
        }
      }
    }).catch(() => { credAlive.alive = null })
  }
  const handle = async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname.replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && path.endsWith('/status')) {
      rollDay()
      const cred = loadCred()
      checkCredAlive(cred)
      return sendJson(res, 200, {
        ok: true,
        version,
        home,
        loggedIn: Boolean(cred) && credAlive.alive !== false,
        login: {
          own: !isLoggedOut() && Boolean(readJson(ownCredFile, null)?.sessdata),
          source: credSourceOf(),
          uid: String(cred?.dedeuserid || ''),
          uname: String(cred?.uname || credAlive.name || ''),
        },
        config: cfg,
        defaults: DEFAULTS,
        llm: { available: llm.available, ...llm.route() },
        current: statusOfCurrent(),
        recording: rt.recorder ? { danmaku: rt.recorder.size, speech: rt.recorder.speechSize, since: rt.recorder.startedAt } : null,
        audio: {
          listening: Boolean(rt.audio),
          roomId: rt.audio?.roomId || 0,
          transcribed: rt.audio?.transcribed || 0,
          chars: rt.audio?.chars || 0,
          dropped: rt.audio?.dropped || 0,
          lastText: rt.audio?.lastText || '',
          tap: rt.audio ? rt.audio.tap.status() : null,
          asr: rt.asr
            ? rt.asr.status()
            : { available: Boolean(findPython(cfg.asrPython)), ready: false, python: findPython(cfg.asrPython), model: cfg.asrModel },
        },
        vision: {
          watching: Boolean(rt.vision),
          roomId: rt.vision?.roomId || 0,
          shots: rt.vision?.shots?.length || 0,
          dropped: rt.vision?.dropped || 0,
          lastShot: rt.vision?.shots?.length ? rt.vision.shots[rt.vision.shots.length - 1].file : '',
          tap: rt.vision ? rt.vision.tap.status() : null,
        },
        lastRecap: rt.lastRecap,
        // best 可能还没采到（刚进房间），但 sampling 必须是 true —— 否则设置页显示成「没有评分」
        rating: rt.rating ? { sampling: true, best: rt.rating.best || null } : null,
        // 权重表直接给设置页渲染（已按用户设置的百分数归一，加起来=1）
        weights: buildWeights(cfg.ratingWeights),
        ratingWeights: cfg.ratingWeights,
        lastPush: rt.lastPush || null,
        pushed: (() => {
          const m = loadPushed()
          const monthMs = 30 * 24 * 3600 * 1000
          const now = Date.now()
          // 只把「一个月内还新鲜」的算进来：过期的记录留着不影响重推，但面板上不该继续显示
          const list = Object.entries(m)
            .map(([uid, v]) => ({ uid, uname: v.uname || '', score: v.score || 0, at: v.at || 0 }))
            .filter((x) => x.at && now - x.at < monthMs)
            .sort((a, b) => b.at - a.at)
          return { count: list.length, list: list.slice(0, 12) }
        })(),
        recaps: listRecaps(home, 8),
        recapDir: recapDir(home),
        received: rt.danmakuCount,
        lastCheckAt: rt.lastCheckAt,
        lastError: rt.lastError,
        state: { today: state.today, replyCount: state.replyCount, introDone: Object.keys(state.introDone).length },
        logs: logs.slice(-30),
      })
    }

    if (req.method === 'POST' && path.endsWith('/config')) {
      const patch = await readBody(req)
      const next = mergeConfig(cfg, patch)
      Object.assign(cfg, next)
      saveCfg()
      schedule()
      log('配置已更新')
      // 巡场途中改了「看多久」：按新时长重设倒计时（调小到已超时 = 当场换台）
      armRotateTimer()
      if (!cfg.enabled) stopWatching('总开关被关掉')
      else tick().catch(() => {})
      // 听声音 / 看画面的开关变了，要当场跟着启停（不必等下一轮 tick）
      // 换模型 / 换解释器：常驻转写进程得重建，否则还抱着旧模型不放
      if (rt.asr) {
        const want = String(cfg.asrModel || 'small')
        const got = String(rt.asr.model || 'small')
        const wantPy = findPython(cfg.asrPython)
        const gotPy = String(rt.asr.python || '')
        if (want !== got || (wantPy && gotPy && wantPy !== gotPy)) {
          try { rt.asr.stop() } catch { /* 收摊 */ }
          rt.asr = null
          log(`转写模型要换成 ${want}，下次转写时重新加载`)
        }
      }
      if (!cfg.listenAudio) stopAudio('听声音被关掉')
      else if (rt.current) {
        const c2 = loadCred()
        if (c2) startAudio(rt.current.realRoomId, c2)
      }
      if (!cfg.visionEnabled) stopVision('看画面被关掉')
      else if (rt.current) {
        const c3 = loadCred()
        if (c3) startVision(rt.current.realRoomId, c3)
      }
      return sendJson(res, 200, { ok: true, config: cfg })
    }

    if (req.method === 'POST' && path.endsWith('/pushed/clear')) {
      const before = Object.keys(loadPushed()).length
      savePushed({})
      log(`已清空「推送过的主播」记录（${before} 位），他们下次再拿高分还会推`)
      return sendJson(res, 200, { ok: true, cleared: before, pushed: { count: 0, list: [] } })
    }

    if (req.method === 'POST' && path.endsWith('/resolve')) {
      const body = await readBody(req)
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证（请在插件设置页扫码登录）' })
      const mid = String(body.mid || '').replace(/\D/g, '')
      const roomId = String(body.roomId || '').replace(/\D/g, '')
      try {
        const info = mid ? await getRoomByUid(mid, cred) : await getRoomInfo(roomId, cred)
        return sendJson(res, 200, {
          ok: true,
          stream: normalizeStream({ mid: mid || String(info.uid || ''), roomId: String(info.realRoomId || info.roomId || roomId), name: info.uname }),
          info: { uname: info.uname, title: info.title, liveStatus: info.liveStatus, realRoomId: info.realRoomId },
        })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }

    if (req.method === 'POST' && path.endsWith('/tick')) {
      await tick()
      return sendJson(res, 200, { ok: true, current: statusOfCurrent(), lastError: rt.lastError })
    }

    if (req.method === 'POST' && path.endsWith('/stop')) {
      // 只是「离开这一场」，不是把总开关关掉 —— 关掉的话下一轮 tick 会直接 return
      stopWatching('手动停止')
      return sendJson(res, 200, { ok: true })
    }

    if (req.method === 'POST' && path.endsWith('/switch')) {
      // 手动切台：mode=random 随机换一个；key=房间号或主播 UID 直接进指定直播间
      const body = await readBody(req)
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '没有登录凭证（先在下面扫码登录）' })
      if (rt.busy) return sendJson(res, 200, { ok: false, error: '正在检查直播间，等一秒再试' })
      rt.busy = true
      try {
        const mode = String(body.mode || '')
        if (mode === 'random') {
          await randomTour(cred, '手动换成随机直播间', { force: true })
          return sendJson(res, 200, { ok: true, current: statusOfCurrent(), lastError: rt.lastError })
        }
        const digits = String(body.key || '').replace(/\D/g, '')
        if (!digits) return sendJson(res, 200, { ok: false, error: '填一个房间号或主播 UID' })
        // 先当房间号查，查不到再当主播 UID 查（用户通常只记得其中一个）
        let info = null
        try { info = await getRoomInfo(digits, cred) } catch { info = null }
        if (!info || !(info.realRoomId || info.roomId)) {
          try { info = await getRoomByUid(digits, cred) } catch (e) {
            return sendJson(res, 200, { ok: false, error: '没找到这个直播间：' + (e?.message || e) })
          }
        }
        const realRoomId = Number(info?.realRoomId || info?.roomId || 0)
        if (!realRoomId) return sendJson(res, 200, { ok: false, error: '没找到这个直播间' })
        if (Number(info.liveStatus) !== 1) {
          return sendJson(res, 200, { ok: false, error: `「${info.uname || digits}」现在没在播` })
        }
        stopWatching('手动切到指定直播间')
        await watch(
          { name: info.uname, mid: String(info.uid || ''), roomId: String(realRoomId) },
          info,
          { random: true }, // 算随机巡场：照样打分，看满设定时长也照样换台
        )
        return sendJson(res, 200, { ok: true, current: statusOfCurrent(), lastError: rt.lastError })
      } finally {
        rt.busy = false
      }
    }

    /* ── 扫码登录 ── */

    if (req.method === 'POST' && path.endsWith('/login/qr')) {
      try {
        const { key, url } = await generateQr()
        rt.qr = { key, at: Date.now() }
        const svg = qrSvg(qrLibFile, url)
        log('出了一张登录二维码，等扫码')
        return sendJson(res, 200, { ok: true, key, svg })
      } catch (e) {
        return sendJson(res, 200, { ok: false, error: e?.message || String(e) })
      }
    }

    if (req.method === 'POST' && path.endsWith('/login/poll')) {
      const body = await readBody(req)
      const key = String(body.key || rt.qr?.key || '')
      if (!key) return sendJson(res, 200, { ok: false, error: '还没有二维码，先生成一张' })
      try {
        const r = await pollQr(key)
        if (r.status !== 'ok') {
          return sendJson(res, 200, { ok: true, status: r.status, message: r.message || '' })
        }
        const me = await whoAmI(r.cred)
        saveOwnCred({ ...r.cred, uname: me?.uname || '' })
        credAlive.at = 0
        credAlive.alive = true
        credAlive.name = me?.uname || ''
        rt.qr = null
        rt.myUid = String(r.cred.dedeuserid || '')
        if (me?.uname && !cfg.username) {
          cfg.username = me.uname.slice(0, 20)
          saveCfg()
        }
        log(`扫码登录成功：${me?.uname || r.cred.dedeuserid || '?'}`)
        tick().catch(() => {})
        return sendJson(res, 200, { ok: true, status: 'ok', uname: me?.uname || '', mid: me?.mid || '' })
      } catch (e) {
        return sendJson(res, 200, { ok: false, status: 'error', error: e?.message || String(e) })
      }
    }

    if (req.method === 'POST' && path.endsWith('/logout')) {
      try { if (existsSync(ownCredFile)) unlinkSync(ownCredFile) } catch { /* 删不掉也当退出了 */ }
      try { writeFileSync(loggedOutFile, JSON.stringify({ at: new Date().toISOString() })) } catch { /* 写不进就只删自己的那份 */ }
      rt.qr = null
      credAlive.at = 0
      credAlive.alive = null
      log('已退出登录（插件自己的凭证已删；重新扫码可再登）')
      return sendJson(res, 200, { ok: true })
    }

    /* ── 直播笔记 ── */

    if (req.method === 'POST' && path.endsWith('/llm-test')) {
      if (!llm.available) return sendJson(res, 200, { ok: false, error: '宿主没有提供 llm 服务' })
      let why = ''
      const t0 = Date.now()
      const text = await llm.generate({
        prompt: '只回复两个字：收到',
        // 给足预算：20 这种小额度会被思考过程吃掉，模型其实正常却回空串（假失败）
        maxTokens: 600,
        timeoutMs: 30000,
        onError: (e) => { why = e?.message ?? String(e) },
      })
      log(`模型自测：${text ? '通过（' + text + '）' : '失败（' + (why || '空回复') + '）'}`)
      return sendJson(res, 200, {
        ok: Boolean(text), text, error: why, ms: Date.now() - t0,
        ...llm.route(),
      })
    }

    /* 手动试发一条：只在设置页点了按钮时才走，不参与任何自动流程 */
    if (req.method === 'POST' && path.endsWith('/send-test')) {
      const cur = rt.current
      if (!cur) return sendJson(res, 200, { ok: false, error: '现在没在看直播，先进一个直播间再试' })
      const cred = loadCred()
      if (!cred) return sendJson(res, 200, { ok: false, error: '还没登录' })
      const body = await readBody(req)
      const text = clipText(body?.text || '测试一下，打扰了', cfg.maxLen)
      const r = await sendDanmaku(cred, cur.realRoomId, text)
      log(`试发弹幕「${text}」：${r.ok ? '成功' : '失败（' + r.message + '）'}`)
      return sendJson(res, 200, { ok: Boolean(r.ok), text, room: cur.realRoomId, uname: cur.uname, error: r.ok ? '' : r.message, code: r.code })
    }

    if (req.method === 'GET' && path.endsWith('/records')) {
      return sendJson(res, 200, { ok: true, dir: recapDir(home), files: listRecaps(home, 40) })
    }

    if (req.method === 'POST' && path.endsWith('/open-folder')) {
      const dir = recapDir(home)
      try {
        const isWin = process.platform === 'win32'
        const bin = isWin ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open'
        const p = spawn(bin, [dir], { detached: true, stdio: 'ignore' })
        p.on('error', () => { /* 打不开就算了，前端会把路径显示出来 */ })
        p.unref()
        log(`打开笔记文件夹：${dir}`)
        return sendJson(res, 200, { ok: true, dir })
      } catch (e) {
        return sendJson(res, 200, { ok: false, dir, error: e?.message || String(e) })
      }
    }

    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${path}` })
  }

  try {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: '/api/bili-live',
      handler: async (req, res) => {
        try { await handle(req, res) } catch (e) {
          sendJson(res, 500, { ok: false, error: e?.message ?? String(e) })
        }
      },
    }), 'bili-live: /api/bili-live 路由')
  } catch (e) {
    log(`HTTP 路由没挂上：${e?.message ?? e}`)
  }

  schedule()
  log(`已挂载（家=${home}，版本=${version || '?'}，关注=${cfg.streams.length}，轮询=${cfg.pollMs}ms）`)
  // 启动后给宿主 3 秒，别和别的插件抢启动
  const boot = setTimeout(() => { tick().catch(() => {}) }, 3000)
  if (boot.unref) boot.unref()

  ctx.effect(() => () => {
    if (rt.timer) clearInterval(rt.timer)
    stopWatching('插件卸载', { silent: true })
    stopAudio('插件卸载')
    stopVision('插件卸载')
    try { rt.asr?.stop() } catch { /* 收摊 */ }
  }, 'bili-live: 收摊')
}
