/**
 * lib/moderation.mjs —— 直播间的恶意内容审核（隐藏扣分项）
 * ============================================================================
 * 弹幕里带节奏、网暴、粗鄙语言，就该让这场分难看。
 * 规则表追不上中文骂人的变体（谐音、拆字、拼音首字母），所以整块交给大模型判，
 * 这里只做三件事：
 *   1. 把弹幕和封禁事件打包成一次提问；
 *   2. 把模型给的扣分夹到用户定的范围（扣 0~5，最终 0~10）；
 *      本场只要有封禁（房管或主播封过人），就一律不扣——现场已经制止过了。
 *   3. 任何失败都返回 null —— 审核挂了也不能耽误结算。
 *
 * 这一项**不进直播总结**：模型写正文时不知道它的存在，只有评分日志和笔记里的
 * 那行算式会露出来。
 * ============================================================================
 */
import { clockStamp } from './recap.mjs'

const MAX_DANMAKU = 400 // 短场（5 分钟几百条）直接全给，长场才采样
const MAX_PENALTY = 5
const round1 = (x) => Math.round(x * 10) / 10

/**
 * @param {{available:boolean, generate:Function}} llm makeLlm 的产物
 * @param {object} cfg 插件配置（读 moderationEnabled / moderationThreshold）
 * @param {(m:string)=>void} log
 */
export function makeModerator(llm, cfg, log) {
  const on = () => cfg.moderationEnabled !== false && cfg.ratingEnabled !== false

  return {
    get enabled() {
      return on()
    },

    /**
     * 判这一场有没有恶意内容、该扣多少。
     * @param {import('./recap.mjs').LiveRecorder} rec
     * @returns {Promise<null|{threshold:number, malicious:number, penalty:number, bonus:number, blocked:boolean, waived:boolean, samples:string[], note:string, blocks:number}>}
     */
    async judge(rec) {
      if (!on() || !llm.available) return null
      const threshold = Math.max(1, Math.round(Number(cfg.moderationThreshold) || 10))
      // 几乎没有内容的场次没什么可审的，省一次模型调用
      if (rec.size < 8 && !rec.blockCount) return null

      const dmAll = rec.items.length <= MAX_DANMAKU
      const dm = dmAll ? rec.items : rec.sample(MAX_DANMAKU)

      const flat = (s) => String(s || '').replace(/\s+/g, ' ').trim()
      const dmText = dm.map((it) => `${clockStamp(it.t)} ${flat(it.name) || '匿名'}：${flat(it.text)}`).join('\n')
      const blkText = (rec.blocks || [])
        .map((b) => `${clockStamp(b.at)} 封禁 ${flat(b.uname) || b.uid || '某人'}${b.operator === 1 ? '（房管/主播操作）' : '（系统自动）'}`)
        .join('\n')

      const prompt = [
        '你在后台审核一场 B站 直播的现场记录，任务是找出恶意内容并给出扣分/加分建议。',
        '',
        '【先判断每一条是开玩笑，还是真恶意——这是最重要的一步】',
        '不要只看有没有脏字。直播间里大量的"骂"其实是关系好的观众在互相损、和主播玩梗、跟风复读同一句话，脏字只是语气词，这类不算。',
        '真正的恶意是冲人去的：要让谁难堪、要挑起两拨人对立、要伤害或威胁某个人、要造谣毁人。',
        '判断方法：问自己这一条是想让直播间更热闹，还是在破坏它；是熟人之间的玩笑，还是陌生人带着情绪的攻击。',
        '拿不准的一律算作「不算」——宁可漏判，不要错杀。',
        '',
        '【算作恶意的】',
        '- 带节奏：挑事、引战、阴阳怪气、刷屏挑衅、造谣传谣',
        '- 网络暴力：辱骂、人身攻击、诅咒、威胁、歧视性言论',
        '- 粗鄙语言：脏话、性暗示、低俗烂梗',
        '',
        '【不算的】',
        '- 影视剧、游戏剧情的台词引用',
        '- 观众之间、观众和主播之间的玩笑互损（"菜狗""你是不是傻"这种熟人语气）',
        '- 跟风复读同一个梗、整个直播间一起刷同一句话',
        '- 正常玩梗、朋友式互怼、单纯的情绪发泄（"好难啊""气死我了"）',
        '- 对主播或内容的正常批评（"这操作确实不行"）',
        '- 自嘲或明显在念稿时冒出来的单个脏字',
        '',
        '【现场数据】',
        `- 弹幕：${dmAll ? `全部 ${rec.size} 条` : `采样 ${dm.length} 条（全场 ${rec.size} 条，按时间均匀抽）`}`,
        `- 封禁事件：${rec.blockCount} 次（有封禁就视为现场已制止，本场不扣分）`,
        '',
        '【弹幕】',
        dmText || '（没有）',
        '',
        blkText ? `【封禁记录】\n${blkText}` : '',
        '',
        '【输出要求】',
        '1. maliciousCount：估算全场的恶意弹幕条数（整数）。只数你确信真恶意的，玩笑、玩梗、互损都不算。',
        `2. score：扣分，0~${MAX_PENALTY} 的小数。恶意不到 ${threshold} 条就给 0；${threshold}~19 条给 0.5~1.5；20~39 条给 1.5~3；40 条以上给 3~5。可以按严重程度酌情调整。`,
        '3. 如果【封禁记录】不为空（房管或主播封过人），说明现场已经制止过，这场不扣分——score 必须给 0。封禁是系统自动的也一样。',
        '4. samples：你判成恶意的原文，逐条照抄（最多 8 条，每条 30 字以内），用来核对是否误判。拿不准的不要放进来。',
        '5. note：15 字以内，说明判定的主要依据。',
        '',
        '只输出一行 JSON，不要解释、不要代码块：',
        '{"maliciousCount":0,"score":0,"samples":[],"note":""}',
      ]
        .filter((x) => x !== '')
        .join('\n')

      const out = await llm.generate({
        prompt,
        maxTokens: 1200,
        timeoutMs: 60000,
        onError: (e) => log(`恶意内容审核没接上模型：${e?.message ?? e}`),
      })
      const obj = parseJsonLoose(out)
      if (!obj) {
        log('恶意内容审核没拿到可用结果，本场不扣分')
        return null
      }

      const malicious = Math.max(0, Math.round(Number(obj.maliciousCount) || 0))
      // 只要有封禁就不扣分（用户 m03609：现场已经制止过，这场就别扣了）。
      // 注意：接口只给「谁被封」，不给封禁原因，所以无法区分「封恶意弹幕」和「封广告刷屏」，
      // 一律按免责处理——宁可少扣，不要冤枉已经管过场的主播。
      const blocked = rec.blockCount > 0
      // 不到阈值一律不扣 —— 用户要的是「10 条以上」才算过多
      const rawPenalty = Number(obj.score) || 0
      const penalty = !blocked && malicious >= threshold ? round1(Math.min(MAX_PENALTY, Math.max(0, rawPenalty))) : 0
      // 加分已废弃（封禁的奖励改成「不扣分」而不是「加 1 分」），字段恒 0 只为兼容旧的笔记渲染
      const bonus = 0
      const samples = Array.isArray(obj.samples)
        ? obj.samples.map((s) => flat(s)).filter(Boolean).slice(0, 8)
        : []
      return {
        threshold,
        malicious,
        penalty,
        bonus,
        blocked,
        // 封禁导致「该扣没扣」：恶意条数够线、但因为有封禁而免责。只有这种情形
        // 才值得在评价里跟观众交代一句，单纯没到阈值不用提。
        waived: blocked && malicious >= threshold,
        samples,
        note: flat(obj.note).slice(0, 60),
        blocks: rec.blockCount,
      }
    },
  }
}

/** 模型爱把 JSON 包在 ```json 里，也可能前后带解释；只抠第一对花括号 */
function parseJsonLoose(s) {
  const t = String(s || '').replace(/```[a-z]*/gi, '').trim()
  const a = t.indexOf('{')
  const b = t.lastIndexOf('}')
  if (a < 0 || b <= a) return null
  try {
    return JSON.parse(t.slice(a, b + 1))
  } catch {
    return null
  }
}
