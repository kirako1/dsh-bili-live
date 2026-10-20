/**
 * 主播评分。
 *
 * 用户的原话：「参考弹幕活跃度，同接数，主播粉丝数，付费数等资料给主播打分，
 * 满分10分，高于8分就私信推送」。
 *
 * 做法：这四项各自做对数归一（否则一个百万粉主播会把所有其他维度压成 0），
 * 再加权求和。对数意味着「从 100 人到 10000 人」和「从 10000 到 100 万」是
 * 同一档跨度 —— 我们关心的是量级，不是绝对人数。
 */

import crypto from 'node:crypto'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const headers = (cred) => ({
  'User-Agent': UA,
  Referer: 'https://live.bilibili.com/',
  ...(cred ? { Cookie: cookieOf(cred) } : {}),
})

/** 和 live.mjs 里同款的 cookie 拼装（这里单独放一份，免得循环依赖） */
function cookieOf(cred) {
  if (!cred) return ''
  const parts = []
  if (cred.sessdata) parts.push(`SESSDATA=${cred.sessdata}`)
  if (cred.bili_jct) parts.push(`bili_jct=${cred.bili_jct}`)
  if (cred.buvid3) parts.push(`buvid3=${cred.buvid3}`)
  if (cred.dedeuserid) parts.push(`DedeUserID=${cred.dedeuserid}`)
  return parts.join('; ')
}

const api = async (url, cred, ms = 12000) => {
  const r = await fetch(url, { headers: headers(cred), signal: AbortSignal.timeout(ms) })
  if (!r.ok) throw new Error(`${r.status} ${url}`)
  const b = await r.json()
  if (b.code !== 0) throw new Error(`code=${b.code} ${b.message || ''} ${url}`)
  return b.data
}

// ---- wbi 签名 ----
// B站 的空间接口（x/space/wbi/*）必须带 wts + w_rid，否则一律 -403「访问权限不足」。
// 为什么突然要这个：老的 newlist 接口在 2026-10 已经彻底废了——拿果宝的 mid 去查，
// 返回的是「巅峰赛雷音高额伤害」「必胜客真不赖呀」这种全站推荐流，跟主播毫无关系；
// 而且那批视频全是当天发布的，于是「近 30 天投稿数」永远等于 ps 上限 50。
// 六场实测全部是 50，就是这么来的（用户 2026-10-19 一眼看出不合理）。
const WBI_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38,
  41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]
let wbiMixinCache = { mixin: '', at: 0 }

async function wbiMixin(cred) {
  const now = Date.now()
  if (wbiMixinCache.mixin && now - wbiMixinCache.at < 2 * 3600 * 1000) return wbiMixinCache.mixin
  const r = await fetch('https://api.bilibili.com/x/web-interface/nav', {
    headers: headers(cred),
    signal: AbortSignal.timeout(12000),
  })
  const b = await r.json().catch(() => null)
  const img = b?.data?.wbi_img
  if (!img?.img_url || !img?.sub_url) throw new Error('nav 没有 wbi_img')
  const base = (u) => String(u).slice(String(u).lastIndexOf('/') + 1).split('.')[0]
  const raw = base(img.img_url) + base(img.sub_url)
  const mixin = WBI_TAB.map((i) => raw[i]).join('').slice(0, 32)
  wbiMixinCache = { mixin, at: now }
  return mixin
}

/** 带 wbi 签名的 GET，返回值同 api()（已经剥到 data） */
async function wbiApi(url, params, cred, ms = 12000) {
  const mixin = await wbiMixin(cred)
  const p = { ...params, wts: Math.round(Date.now() / 1000) }
  const q = Object.keys(p)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`)
    .join('&')
  const w_rid = crypto.createHash('md5').update(q + mixin).digest('hex')
  return api(`${url}?${q}&w_rid=${w_rid}`, cred, ms)
}

/**
 * 拉一个房间的公开数据。三个接口互相独立，任何一个挂了都不该拖垮整次评分。
 * @returns {{online:number, attention:number, follower:number, payerCount:number, guardCount:number, area:string, title:string, upUid:string}}
 */
export async function collectStats(cred, realRoomId, uid) {
  const out = {
    online: 0,
    // 同接人数到底采到了没有。rank 接口失败时 online 会留在 0，而 computeScore 里
    // crowd/heads 会退到 30/5 的保底值 —— 20 个人发言就能算出 400% 直接封顶。
    // 这种「因为没数据反而满分」的场次必须整场不打分，所以单独记一个标记。
    onlineKnown: false,
    popularity: 0,
    attention: 0,
    follower: 0,
    likes: 0,
    posts30d: 0,
    videoCount: 0,
    likesPerVideo: 0,
    payerCount: 0,
    guardCount: 0,
    fansClub: 0,
    area: '',
    title: '',
    upUid: String(uid || ''),
  }

  const room = await api(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realRoomId}`, cred).catch(
    () => null,
  )
  if (room) {
    // room.online 是「人气值」不是人数（实测同一房间：人气 212410、真实在线 73，
    // 被人气算法放大了约 2900 倍），只当参考存着，绝不当同接用。
    out.popularity = Number(room.online) || 0
    out.attention = Number(room.attention) || 0
    out.area = room.area_name || room.parent_area_name || ''
    out.title = room.title || ''
    out.upUid = String(room.uid || out.upUid || '')
  }

  // 粉丝团人数：room/get_info 里没有这个字段，只有 getInfoByRoom 的 anchor_info.medal_info.fansclub
  // （实测 20 个房间都有，值合理：陆鳐 441、弦音 90、米米 20）。开播记一次、下播记一次，
  // 相减就是「本场新增粉丝团成员」——「路人转化率」的数据源，比关注增量更贴近「愿意留下」。
  const info = await api(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getInfoByRoom?room_id=${realRoomId}`,
    cred,
  ).catch(() => null)
  if (info) {
    out.fansClub = Number(info.anchor_info?.medal_info?.fansclub) || 0
    if (!out.attention) out.attention = Number(info.anchor_info?.relation_info?.attention) || 0
  }

  if (out.upUid) {
    const master = await api(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${out.upUid}`, cred).catch(
      () => null,
    )
    if (master) {
      out.follower = Number(master.follower_num) || 0
      if (!out.attention) out.attention = Number(master.attention) || 0
    }
    // 获赞数是另一个口径的认可（看过且喜欢过），和「关注」不是同一个数 —— 实测
    // 8 个直播间 attention 与 follower_num 完全相同，重复计权没有意义。
    const card = await api(`https://api.bilibili.com/x/web-interface/card?mid=${out.upUid}`, cred).catch(() => null)
    if (card) {
      out.likes = Number(card.like_num) || 0
      out.videoCount = Number(card.archive_count) || 0
      // 获赞率：平均每条投稿被赞了多少次（总获赞 ÷ 投稿数）。比绝对获赞更公平 ——
      // 一个发了 3000 稿的老号和一个发了 30 稿的新号，绝对数没法比。
      out.likesPerVideo = out.videoCount > 0 ? Math.round(out.likes / out.videoCount) : 0
    }
    // 投稿频率：近 30 天发了几稿。走 wbi 签名的 arc/search（返回的是这个 UP 真正的投稿，
    // 按 created 倒序）。ps 给 50：日更两更也只有 60 条，50 条足够覆盖绝大多数主播，
    // 真发满 50 条也早就超过 cap（5 稿）了，不影响打分。
    // 拿不到时填 5（正好是 cap），即「未知就当正常」——接口挂了不该由主播背分。
    const nowSec = Date.now() / 1000
    const arcs = await wbiApi(
      'https://api.bilibili.com/x/space/wbi/arc/search',
      { mid: out.upUid, ps: 50, pn: 1, order: 'pubdate', platform: 'web', web_location: 1550101, index: 0 },
      cred,
    ).catch(() => null)
    out.posts30d = 5
    if (arcs) {
      const vlist = Array.isArray(arcs.list?.vlist) ? arcs.list.vlist : []
      const hit = vlist.filter((x) => {
        const t = Number(x.created) || 0
        return t > 0 && nowSec - t < 30 * 86400
      }).length
      out.posts30d = hit
      out.postsKnown = true
    }
  }

  // ruid 必须传「主播自己的 uid」才返回真实在线人数（onlineNum）；传自己的 uid 会得到 0。
  const rankUrlOf = (p) =>
    `https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank?roomId=${realRoomId}&ruid=${out.upUid || 0}&page=${p}&pageSize=50`
  const rank = await api(rankUrlOf(1), cred).catch(() => null)
  if (rank) {
    // 付费榜一页最多 50 人。实测同接 5000 的大房间真实付费者 535 人，
    // 光取第一页会让 payerCount 恒等于 50、付费率被低估一个数量级。翻到不满 50 为止。
    let list = Array.isArray(rank.OnlineRankItem) ? rank.OnlineRankItem.slice() : []
    const MAX_PAGES = 30 // 1500 人封顶，防接口异常时无限翻
    let page = 1
    while (list.length >= page * 50 && page < MAX_PAGES) {
      page++
      const more = await api(rankUrlOf(page), cred).catch(() => null)
      const items = Array.isArray(more?.OnlineRankItem) ? more.OnlineRankItem : []
      if (!items.length) break
      list = list.concat(items)
      if (items.length < 50) break
    }
    out.payerTruncated = list.length >= MAX_PAGES * 50
    // 换页时榜单在动，实测偶有 1 个重复项，按 uid 去重
    const seenUid = new Set()
    list = list.filter((x) => {
      const k = String(x.uid ?? '')
      if (!k) return true
      if (seenUid.has(k)) return false
      seenUid.add(k)
      return true
    })
    out.payerCount = list.length
    // 每项都带 medalInfo.targetId —— 这个人挂着哪个直播间的粉丝牌。
    // 等于本主播 uid = 自己人充值；不等于 = 别家粉丝或纯路人，也就是「被内容拉进来的新钱」。
    const owner = String(out.upUid || '')
    // 18 位 uid 经 JSON.parse 会丢精度，一旦发生，medalInfo.targetId 和 owner 可能
    // 「同时丢成同一个错数」而掩盖问题，也可能只丢一边导致粉丝全被判成路人。这里兜一层。
    if (owner && !Number.isSafeInteger(Number(owner)) && Number(owner) > 0) {
      out.uidPrecisionRisk = true
    }
    const fans = list.filter((x) => String(x.medalInfo?.targetId || '') === owner).length
    out.payerFans = fans
    out.payerStrangers = out.payerCount - fans
    // onlineNum 才是真实在看的活人（实测同一房间 73 人）
    out.online = Number(rank.onlineNum) || 0
    out.onlineKnown = out.online > 0
  }

  // 和 rank 一样，ruid 要传主播自己的 uid —— 传自己的 uid 查到的是「我在这个房间的舰队」，不是主播的
  const guard = await api(
    `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=${realRoomId}&ruid=${out.upUid || cred?.dedeuserid || 0}&page=1&page_size=10`,
    cred,
  ).catch(() => null)
  if (guard) out.guardCount = Number(guard.info?.num) || 0

  return out
}

/**
 * 归一：默认对数（cap = 这一项拿满分的大致量级）；linear=true 时改成线性（v ÷ cap，封顶 1）。
 *
 * 为什么分两种：规模类指标（人气、弹幕条数、获赞数）跨好几个数量级，只有对数能把
 * 中小房间摊开；比率类指标（浓度、参与率、稿数）本身就在 0~1 或个位数里，线性才不扭曲。
 */
const norm = (value, cap, linear) => {
  const v = Number(value) || 0
  const c = Number(cap) || 0
  if (v <= 0 || !(c > 0)) return 0
  if (linear) return Math.min(1, v / c)
  return Math.min(1, Math.log10(1 + v) / Math.log10(1 + c))
}

/**
 * 十维权重 —— 0.9.0 起配合「期望值归一」重排（用户 m06340 四条裁定）：
 * 粉丝付费率 20 › 直播互动 17 › 观众参与 12 › 粉丝浓度 12 › 作品获赞 10 ›
 * 更新频率 8 › 路人付费率 8 › 弹幕热度 7 › 人气规模 5 › 路人转化率 1。
 * 用户原话：「作品获赞占 10%、更新频率占 8% 我认为是对主播长期能力的评价，而且占比并不高」
 * 「路人转化率可以削到 1% 权重，但一定要有」——转化率从 3% 降到 1%，省下的 2 点
 * 给粉丝付费率 +1、直播互动 +1。
 *
 * 重心在「转化」：十个来人里愿意开口、愿意留下的，比一万个挂机的更能说明水平。
 * ① 作品获赞（总获赞 ÷ 投稿数）：内容硬实力，最不受体量污染，给最高权重。
 * ② 直播互动（每百人每分钟弹幕）：会不会聊天。分母用 max(同接, 30)，否则 8 人房间虚高。
 * ③ 观众参与（发言人数 ÷ 同接）：多少人愿意开口——「条数」看热闹，「人头」看参与。
 * ④ 弹幕热度（条/分）：场子热不热，规模与能力的混合品。
 * ⑤ 人气规模（同接）：知名度是结果不是水平，权重压低。
 * ⑥ 粉丝浓度（在场挂本房牌的观众 ÷ 同接）：核心粉厚度。牌子数据从弹幕与进房事件里取，
 *    比舰长 ÷ 同接更贴近「观众」，也不吃冲舰活动和舰长运营的假象。
 * ⑦ 更新频率（月投稿）：只区分「停更 / 在更」，几乎区分不了水平，权重低。
 * ⑧ 粉丝付费率（挂本房牌的付费者 ÷ 同接）：老粉还愿不愿意掏钱，属于能力本体。
 * ⑨ 路人付费率（没挂牌的付费者 ÷ 同接）：衡量「对圈外人的吸引力」，只是小分支；
 *    样本极稀，给高了就等于「几个人房间里来一个路人」直接把分拉满。
 * ⑩ 路人转化率（本场新增关注 ÷ 同接）：路人愿不愿意留下。放最后，单纯因为它是这一批里
 *    信号最薄的一项——一场涨三五个关注，噪声比信号大。
 *
 * 已废弃：大航海总数（存量、受冲舰影响）、直播间关注数 attention（与粉丝数是同一个数）、
 * 付费人数绝对值（改用付费率——人数吃体量，比率才可比）。
 */
/**
 * 作品获赞的满分线随「粉丝体量」浮动（用户 m05907「改，按粉丝数来衡量」）。
 *
 * 获赞是作品数据，跟今晚直播间来了多少人不相干——实测 237 人房的果宝 33882 赞/稿，
 * 10097 人房的大东彦只有 5279，同接差 42 倍获赞反而倒过来差 6 倍。
 * 但粉丝数跟作品曝光直接相关，拿它当尺子才有意义：69 万粉的主播 2196 赞算好，
 * 287 万粉的主播只有 990 赞就偏低。
 *
 * 1 万粉以下统一 300，1~5 万之间从 300 线性爬到 600（用户 m06198「1 万粉以下 300」）。
 * 低区间给宽松线：小主播的作品曝光盘子本来就小，不该被粉丝数惩罚。
 * 锚点之间线性插值，超过 1000 万粉停在 60000。实测九个主播粉丝 69.7 万~287.3 万，
 * 获赞 990~33882，跨度 34 倍——固定 cap 600 时九场里九场全封顶，改成浮动后降到四场。
 */
const LIKE_POINTS = [
  // [粉丝数, 满分线（赞/稿）]
  // 2026-10-20 用户 m06340「可以把获赞的满分拉高，达到爆款才能满分的程度」→ 全线 ×3。
  // 原来 100 万粉 6000 赞就封顶，实测九个主播里六个封顶，这一项等于白送；
  // 现在的线要「出过一个爆款」才够得着：100 万粉 18000 赞、500 万粉 90000 赞。
  [10000, 900],
  [50000, 1800],
  [200000, 4500],
  [500000, 9000],
  [1000000, 18000],
  [2000000, 36000],
  [5000000, 90000],
  [10000000, 180000],
]

/** 按粉丝数取作品获赞的满分线；粉丝数拿不到（0）时退回 1800，不连累主播 */
export function likeCapOf(followers) {
  const f = Number(followers) || 0
  // 拿不到粉丝数 ≠ 小主播。退回中性线 1800（而不是最低档 900），
  // 否则一次接口失败就白送 0.1 分，等于奖励数据缺失。
  if (!(f > 0)) return 1800
  if (f <= LIKE_POINTS[0][0]) return LIKE_POINTS[0][1]
  for (let i = 1; i < LIKE_POINTS.length; i++) {
    const [x1, y1] = LIKE_POINTS[i]
    if (f <= x1) {
      const [x0, y0] = LIKE_POINTS[i - 1]
      return Math.round(y0 + ((f - x0) / (x1 - x0)) * (y1 - y0))
    }
  }
  return LIKE_POINTS[LIKE_POINTS.length - 1][1]
}

export const WEIGHTS = {
  // 满分线一律按「同接 3~50 人」的真实巡场分布取 P75~P90，而不是按大主播拍脑袋。
  // 依据：2026-10-20 随机巡场 25 分钟五场，同接 3/10/26/15/15，没有一场过 50。
  // 这里的 cap 只是兜底值，实际满分线由 likeCapOf(粉丝数) 现算（1 万粉以下 300、5 万粉 600）
  likeRate: { cap: 600, weight: 0.10, label: '作品获赞', unit: '/稿' },
  interaction: { cap: 12, weight: 0.17, label: '直播互动', unit: '条' },
  speakerRate: { cap: 0.25, weight: 0.12, label: '观众参与', linear: true, ratio: true },
  danmaku: { cap: 6, weight: 0.07, label: '弹幕热度', unit: '条/分' },
  online: { cap: 30, weight: 0.05, label: '人气规模', unit: '人' },
  fansDensity: { cap: 0.15, weight: 0.12, label: '粉丝浓度', linear: true, ratio: true },
  posts: { cap: 5, weight: 0.08, label: '更新频率', linear: true, unit: '稿/月' },
  fansPayRate: { cap: 0.10, weight: 0.20, label: '粉丝付费率', linear: true, ratio: true },
  strangerPayRate: { cap: 0.25, weight: 0.08, label: '路人付费率', linear: true, ratio: true },
  fanGainRate: { cap: 0.10, weight: 0.01, label: '路人转化率', linear: true, ratio: true },
}

/** 上面那份权重换算成百分数，就是设置页里的默认值（用户可自己调） */
export const DEFAULT_WEIGHTS = Object.fromEntries(
  Object.entries(WEIGHTS).map(([k, v]) => [k, Math.round(v.weight * 100)]),
)

/**
 * 把用户填的百分数合并进来并归一化。
 *
 * 用户不需要凑满 100 —— 填多少都行，这里按总和归一。这样「把弹幕调到 50、
 * 其他全调成 1」这种极端口味也能算，不会算出超过 10 分的怪结果。
 * 某一项填 0 = 这场完全不看这个维度。
 */
export function buildWeights(overrides) {
  const merged = {}
  let total = 0
  for (const [key, cfg] of Object.entries(WEIGHTS)) {
    const raw = overrides && overrides[key] !== undefined ? overrides[key] : DEFAULT_WEIGHTS[key]
    const num = Number(raw)
    const w = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : DEFAULT_WEIGHTS[key]
    merged[key] = { ...cfg, weight: w }
    total += w
  }
  if (total > 0) for (const key of Object.keys(merged)) merged[key].weight = merged[key].weight / total
  return merged
}

/**
 * 算分。
 * @param {{online?:number,payerFans?:number,payerStrangers?:number,posts30d?:number,
 *          likesPerVideo?:number,dpm?:number,speakers?:number,fansPresent?:number,
 *          attentionGain?:number}} input
 *        dpm = 每分钟弹幕条数（本场实录自算，不看平台给的假数据）
 *        speakers = 本场发过言的独立观众数
 *        fansPresent = 本场挂本房粉丝牌的人数（发言 + 进房事件去重）
 *        fanGain = 本场新增粉丝团成员数（结束时 fansclub − 开播时 fansclub）
 *        比率型维度都是现算的派生量，不用单独入参。
 * @returns {{score:number, parts:object, weights:object}}
 */
export function computeScore(input, weights = WEIGHTS) {
  const online = Number(input.online) || 0
  const dpm = Number(input.dpm) || 0
  const speakers = Number(input.speakers) || 0
  const fansPresent = Number(input.fansPresent) || 0
  // 本场出现过的总人数：粉丝浓度的分母。不能用同接——挂牌人数是累计值、
  // 同接是瞬时值，拿累计除瞬时会算出 373% 这种数字（2026-10-19 实测踩过）
  const seen = Number(input.seenCount) || 0
  const fanGain = Number(input.fanGain) || 0
  const payerFans = Number(input.payerFans) || 0
  const payerStrangers = Number(input.payerStrangers) || 0
  // 两套分母，别混用：
  // crowd = 30 人下限，给「每人能刷多少」的指标用（一条弹幕 / 一笔钱）。8 人房间有人连刷十句，
  //   不兜底就会算出「每百人 125 条」这种鬼数字。
  // heads = 真实在场人数，给「有多少人做某件事」的指标用。8 个人里 4 个开口就是 50%，
  //   那是事实，再兜底等于说「人少所以参与度不算数」。只防 1~4 人的极端比例（一个人等于全房）。
  const crowd = Math.max(online, 30)
  const heads = Math.max(online, 5)
  // 大房间补正：同接越高，单个观众「开口说话」「挂本房粉丝牌」的比例天然越低——
  // 观众基数一大，白嫖党和潜水党就占满，比率项会被系统性稀释。实测：6822 人的房
  // 161 人发言只有 2.4%、237 人的房 19 人发言就是 8%，可前者显然更强。同理 369/6822
  // 的挂牌率 5.4% 对上 27/237 的 11.4%，也是被体量压下去的。
  //
  // 倍数按同接**分段线性插值**（用户 m05594：「除了 ×1 的档位，把每个档位补正变成线性增长」）。
  // 以前 2000 以上是一个死数、档内完全不变，于是 1999 人和 2001 人只差 2 个观众，
  // 路人付费率的补正却从 ×6 跳到 ×50（8.3 倍），是纯粹的断崖。现在锚点之间线性过渡。
  //
  // 锚点怎么定的：按「补正后落在该维度满分线的 80~90%」拿实测房间反推。
  //   笑笑 5235 人（参与 3.78%、浓度 11.2%、粉丝付费 3.1%、路人付费 2.24%、互动 1.58）
  //   大东彦 11641 人（3.40%、5.46%、1.28%、2.96%、1.08）
  // 旧口径 ×50 让路人付费率在 2000+ 房间超过 0.5% 就封顶（大东彦 2.96%×50 = 148%，
  // 超满分线 25% 六倍），这一项在大房间里退化成「有没有人付费」的开关，现在收到 ×8.5。
  // ── 期望值归一（2026-10-20 大改，用户 m06340）─────────────────────────
  // 上一版的所有「补正倍数」都只按同接乘一个系数，问题有两个：
  //   ① 它把「规模稀释」和「这场发挥」一起乘了，分不清是房间大还是主播努力；
  //   ② 倍数只能靠拍（路人付费率一度 ×50），没有依据，也不可能有依据。
  // 现在改成「这一档规模的房间，通常能做到多少」：用九场实测的三档中位数当期望值，
  // 分母不再是主观定的 cap，而是同行的实际水平。ratio = 实测 ÷ 期望，
  // 1.0 就是「和同规模的平均水平持平」（拿 0.85 分），到 1.35 倍才封顶。
  // 为什么不用回归拟合：9 个样本拟合出的指数在物理上解释不通（237 人的期望弹幕
  // 会变成 2.66 条/百人，而实测就是 5.5），同一规模的主播差异能到 8 倍，拟合不如中位数稳。
  const EXPECT_POINTS = [
    // [同接, 发言率, 每百人弹幕, 粉丝付费率, 路人付费率]
    // 四档全部取自 138 场真实日志的中位数（2026-10-20 统计），不再是「拍三档再插值」。
    // 最关键的是 20~50 这一档：它是「熟人房」，观众全是老粉、几乎人人开口，
    // 发言率 19.68% 是 200~500 档（6.52%）的三倍，路人付费率 20.08% 也是峰值。
    // 之前用 350 档的 6.36% 外推，等于把这档的期望值压到真实值的 1/3，
    // 四项（57% 权重）在这里几乎全部封顶——小房间频繁出 8.4/8.8/9.0 就是这个原因。
    [35, 0.1968, 12.01, 0.0435, 0.2008], // 20~50 人：熟人房
    // 50~200 是「潜水房」：观众开始潜水但还没形成话题，发言率掉到谷底 3.31%，
    // 比 20~50 和 200~500 都低。粉丝付费率中位数是 0.00%——真实值 0 当分母会把
    // 任何一笔付费都算成无穷倍，所以取 0.5%（11 场里有 1 场有人付费）。
    [125, 0.0331, 2.98, 0.005, 0.0234],
    [350, 0.0652, 5.53, 0.0266, 0.0696], // 200~500 人
    [2000, 0.0247, 1.05, 0.0139, 0.0227], // 500 人以上
  ]
  // 在对数刻度上插值：同接翻倍时比率本来就该按对数关系往下走，线性插值会把小档拉得太缓
  const expectOf = (key, n) => {
    const col = { speakerRate: 1, interaction: 2, fansPayRate: 3, strangerPayRate: 4 }[key]
    // 20 是评分门槛（MIN_ONLINE），低于它的场次根本不打分，这里夹一下只是防 0/负数
    const x = Math.max(n, 20)
    if (x <= EXPECT_POINTS[0][0]) return EXPECT_POINTS[0][col]
    for (let i = 1; i < EXPECT_POINTS.length; i++) {
      const p = EXPECT_POINTS[i - 1]
      const q = EXPECT_POINTS[i]
      if (x <= q[0]) {
        const t = (Math.log(x) - Math.log(p[0])) / (Math.log(q[0]) - Math.log(p[0]))
        return p[col] + t * (q[col] - p[col])
      }
    }
    // 2 万人以上没有样本，停在最后一档——不拿外推的数字吓人
    return EXPECT_POINTS[EXPECT_POINTS.length - 1][col]
  }
  // ratio → 得分。三段折线：1 倍期望 = 0.85 分（这场就是同规模的平均水平），
  // 1.35 倍封顶（明确超过同规模的人是少数），往下线性掉，0.3 倍 = 0.25 分。
  // 下面 0.3 倍那条再线性收到 0，是给「一个说话的人都没有」的房间留的。
  const expNorm = (r) => {
    if (!(r > 0)) return 0
    if (r >= 1.35) return 1
    if (r >= 1) return 0.85 + (r - 1) * (0.15 / 0.35)
    if (r >= 0.3) return 0.25 + (r - 0.3) * (0.6 / 0.7)
    return r * 0.833
  }
  // 原始比率，笔记里要显示成「实测（同规模 ×1.6）」两段
  const baseRate = {
    interaction: crowd > 0 ? dpm / (crowd / 100) : 0,
    speakerRate: speakers / heads,
    fansDensity: fansPresent / Math.max(seen, heads),
    // 付费率的分母用 heads 而不是 crowd：crowd 的 30 人下限是给「每百人弹幕」配的，
    // 拿它算付费率会把 30 人以下的小房间全部腰斩——15 人的房 3 个路人付费本来是 20%，
    // 除以 30 只剩 10%。
    fansPayRate: payerFans / heads,
    strangerPayRate: payerStrangers / heads,
  }
  // 四项比率走「实测 ÷ 期望值」，其余项仍用固定 cap 的 norm
  const ratioOf = {
    interaction: baseRate.interaction / (expectOf('interaction', online) || 1),
    speakerRate: baseRate.speakerRate / (expectOf('speakerRate', online) || 1),
    fansPayRate: baseRate.fansPayRate / (expectOf('fansPayRate', online) || 1),
    strangerPayRate: baseRate.strangerPayRate / (expectOf('strangerPayRate', online) || 1),
  }
  const raw = {
    likeRate: Number(input.likesPerVideo) || 0,
    interaction: Math.round(baseRate.interaction * 10) / 10,
    speakerRate: Math.round(baseRate.speakerRate * 1000) / 1000,
    danmaku: dpm,
    online,
    // 粉丝浓度不参与期望值归一：实测挂牌率 5.9%~44% 与同接几乎无关（马里奥 488 人 44%、
    // 大东彦 10097 人 5.9%、果宝 237 人 11.4%），幂律不成立。它衡量的是粉丝盘厚度，
    // 跟房间大小是两件事，所以仍用固定线 15%。
    fansDensity: Math.round(baseRate.fansDensity * 1000) / 1000,
    posts: Number(input.posts30d) || 0,
    // 付费拆两半：挂了本房间粉丝牌的是「自己人」，没挂的是路人/别家粉丝
    fansPayRate: Math.round(baseRate.fansPayRate * 1000) / 1000,
    strangerPayRate: Math.round(baseRate.strangerPayRate * 1000) / 1000,
    fanGainRate: Math.round((fanGain / heads) * 1000) / 1000,
  }
  // 走期望值归一的四项；其余六项仍按固定 cap 归一
  const BY_EXPECT = new Set(['interaction', 'speakerRate', 'fansPayRate', 'strangerPayRate'])
  let score = 0
  const parts = {}
  // 作品获赞的满分线按粉丝体量现算，其余九项仍用固定 cap
  const likeCap = likeCapOf(input.follower)
  for (const [key, cfg] of Object.entries(weights)) {
    const cap = key === 'likeRate' ? likeCap : cfg.cap
    const n = BY_EXPECT.has(key) ? expNorm(ratioOf[key]) : norm(raw[key], cap, cfg.linear)
    const ratio = BY_EXPECT.has(key) ? ratioOf[key] : 0
    parts[key] = {
      label: cfg.label,
      value: raw[key],
      // 期望值项显示成「5.5%（同规模 ×1.26）」，一眼能看出这场相对同行是什么水平；
      // 固定 cap 项还是原始值，获赞额外标出满分线
      show: BY_EXPECT.has(key)
        ? cfg.ratio
          ? `${Math.round(raw[key] * 100)}%（同规模 ×${ratio.toFixed(2)}）`
          : `${Math.round(raw[key] * 10) / 10}（同规模 ×${ratio.toFixed(2)}）`
        : cfg.ratio
          ? `${Math.round(raw[key] * 100)}%`
          : key === 'likeRate'
            ? `${raw[key]}（满 ${Math.round(cap)}）`
            : String(raw[key]),
      ratio,
      normalized: Math.round(n * 1000) / 1000,
      points: Math.round(n * cfg.weight * 100) / 10,
      // 这一项的满分分值（权重 × 10）。笔记里的条形图要拿它当分母画格子
      max: Math.round(cfg.weight * 1000) / 100,
      // 这一项实际用的满分线（作品获赞会随粉丝数变，其余等于 WEIGHTS 里的 cap）
      cap,
    }
    score += n * cfg.weight
  }
  return {
    score: Math.round(score * 100) / 10,
    parts,
    weights,
    likeCap,
    // 这一场算分时用的期望值，日志和笔记里要能对账
    expect: {
      interaction: expectOf('interaction', online),
      speakerRate: expectOf('speakerRate', online),
      fansPayRate: expectOf('fansPayRate', online),
      strangerPayRate: expectOf('strangerPayRate', online),
    },
  }
}

/** 分数落在哪个档，给私信和面板用（评的是主播水平，不是「这场值不值得看」） */
export function scoreTier(score) {
  const s = Number(score) || 0
  if (s >= 9) return { tier: 'S', text: '顶尖' }
  if (s >= 8) return { tier: 'A', text: '很强' }
  if (s >= 6) return { tier: 'B', text: '中上' }
  if (s >= 4) return { tier: 'C', text: '一般' }
  if (s >= 2) return { tier: 'D', text: '偏弱' }
  return { tier: 'E', text: '很弱' }
}
