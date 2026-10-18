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

/**
 * 拉一个房间的公开数据。三个接口互相独立，任何一个挂了都不该拖垮整次评分。
 * @returns {{online:number, attention:number, follower:number, payerCount:number, guardCount:number, area:string, title:string, upUid:string}}
 */
export async function collectStats(cred, realRoomId, uid) {
  const out = {
    online: 0,
    popularity: 0,
    attention: 0,
    follower: 0,
    likes: 0,
    posts30d: 0,
    videoCount: 0,
    likesPerVideo: 0,
    payerCount: 0,
    guardCount: 0,
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
    // 投稿频率：近 30 天发了几稿。newlist 按发布时间倒序返回，ps 上限 50 条，
    // 一个月发满 50 稿的主播已经是日更两更，再多也只是「满分」而已。
    // （arc/search 与 wbi/arc/search 都会被 403/412 拦，只有这个老接口还能用。）
    const arcs = await api(`https://api.bilibili.com/x/web-interface/newlist?mid=${out.upUid}&pn=1&ps=50`, cred).catch(
      () => null,
    )
    if (arcs) {
      const nowSec = Date.now() / 1000
      const list = Array.isArray(arcs.archives) ? arcs.archives : []
      out.posts30d = list.filter((x) => {
        const t = Number(x.pubdate || x.created) || 0
        return t > 0 && nowSec - t < 30 * 86400
      }).length
    }
  }

  // ruid 必须传「主播自己的 uid」才返回真实在线人数（onlineNum）；传自己的 uid 会得到 0。
  const rank = await api(
    `https://api.live.bilibili.com/xlive/general-interface/v1/rank/getOnlineGoldRank?roomId=${realRoomId}&ruid=${out.upUid || 0}&page=1&pageSize=10`,
    cred,
  ).catch(() => null)
  if (rank) {
    const list = Array.isArray(rank.OnlineRankItem) ? rank.OnlineRankItem : []
    out.payerCount = list.length
    // onlineNum 才是真实在看的活人（实测同一房间 73 人）
    out.online = Number(rank.onlineNum) || 0
  }

  // 和 rank 一样，ruid 要传主播自己的 uid —— 传自己的 uid 查到的是「我在这个房间的舰队」，不是主播的
  const guard = await api(
    `https://api.live.bilibili.com/xlive/app-room/v2/guardTab/topList?roomid=${realRoomId}&ruid=${out.upUid || cred?.dedeuserid || 0}&page=1&page_size=10`,
    cred,
  ).catch(() => null)
  if (guard) out.guardCount = Number(guard.info?.num) || 0

  return out
}

/** 对数归一：cap 是这个维度上「满分」的大致量级 */
const norm = (value, cap) => {
  const v = Number(value) || 0
  if (v <= 0) return 0
  return Math.min(1, Math.log10(1 + v) / Math.log10(1 + cap))
}

/**
 * 各维度的满分量级与权重，改这里就等于调评分口味。
 *
 * 量级按用户实际看的房间定（同接 70、月投稿 5 条、弹幕 20 条每分），
 * 不是按平台大盘定 —— 评的是「在他会去的房间里，这场算不算热闹」。
 *
 * 注意：B站 的「直播间关注数 attention」和「账号粉丝数 follower_num」实测是同一个数
 * （8 个房间逐一对比完全相同），所以「关注」这一维曾经是白占权重，已删除。现在用
 * 「月投稿数」（近 30 天发了几稿）与「获赞率」（总获赞 ÷ 投稿数）代替——两者都和粉丝
 * 体量无关，才是独立信号。
 */
export const WEIGHTS = {
  online: { cap: 70, weight: 0.15, label: '同接' },
  speakers: { cap: 20, weight: 0.1, label: '发言人数' },
  danmaku: { cap: 20, weight: 0.2, label: '弹幕' },
  posts: { cap: 5, weight: 0.2, label: '投稿/月' },
  payer: { cap: 30, weight: 0.1, label: '付费' },
  guard: { cap: 50, weight: 0.15, label: '大航海' },
  likeRate: { cap: 2_000, weight: 0.05, label: '获赞率' },
  interaction: { cap: 30, weight: 0.05, label: '互动率' },
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
 * @param {{online:number,attention:number,follower:number,payerCount:number,guardCount:number,
 *          dpm:number,speakers:number}} input
 *        dpm = 每分钟弹幕条数（本场实录自算，不看平台给的假数据）
 *        speakers = 本场发过言的独立观众数
 *        interaction 不是入参，由 dpm 与 online 推算：每分钟每百个观众发多少条
 * @returns {{score:number, parts:object, weights:object}}
 */
export function computeScore(input, weights = WEIGHTS) {
  const online = Number(input.online) || 0
  const dpm = Number(input.dpm) || 0
  const raw = {
    online,
    speakers: Number(input.speakers) || 0,
    danmaku: dpm,
    posts: Number(input.posts30d) || 0,
    payer: Number(input.payerCount) || 0,
    follower: Number(input.follower) || 0,
    likeRate: Number(input.likesPerVideo) || 0,
    guard: Number(input.guardCount) || 0,
    // 互动率：70 人的房里每分钟 21 条弹幕 = 每百人 30 条，正好满分
    interaction: online > 0 ? Math.round((dpm / (online / 100)) * 10) / 10 : 0,
  }
  let score = 0
  const parts = {}
  for (const [key, cfg] of Object.entries(weights)) {
    const n = norm(raw[key], cfg.cap)
    parts[key] = {
      label: cfg.label,
      value: raw[key],
      normalized: Math.round(n * 1000) / 1000,
      points: Math.round(n * cfg.weight * 100) / 10,
    }
    score += n * cfg.weight
  }
  return { score: Math.round(score * 100) / 10, parts, weights }
}

/** 分数落在哪个档，给私信和面板用 */
export function scoreTier(score) {
  const s = Number(score) || 0
  if (s >= 9) return { tier: 'S', text: '很值得看' }
  if (s >= 8) return { tier: 'A', text: '值得一看' }
  if (s >= 6) return { tier: 'B', text: '还行' }
  if (s >= 4) return { tier: 'C', text: '一般' }
  return { tier: 'D', text: '冷清' }
}
