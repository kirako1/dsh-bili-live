/**
 * dsh-bili-live —— 浏览器半端（「设置」里的一页）
 * ============================================================================
 * 自注册脚本（约定同其它第三方插件）：
 *   window.__ModuleLoader__.load({ id:'dsh-bili-live', factory:(require)=>({inject,apply}) })
 * 进「设置」的方式：slots.inject('settings.section', ...)，label 就是左侧导航那一项。
 *
 * 这一页要满足的需求（用户 2026-10-17 提的）：
 *   · 改「用户名字」——自我介绍里用的那个，单独一块，最好能看见预览
 *   · 关注主播 + **优先级**（数组顺序 = 优先级，提供 ↑↓）
 *   · 看得到现在到底在哪个直播间、连没连上、回过几条
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-live',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/bili-live'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    const CSS = `
[data-bl-page]{display:flex;flex-direction:column;gap:20px;padding:2px 2px 10px;max-width:660px;}
[data-bl-hero]{position:relative;border-radius:14px;padding:16px 18px;overflow:hidden;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));}
[data-bl-hero]::before{content:'';position:absolute;inset:0 0 auto 0;height:3px;
  background:linear-gradient(90deg,#fb7299,#00aeec);}
[data-bl-hero-top]{display:flex;align-items:center;gap:10px;margin-bottom:12px;}
[data-bl-title]{font-size:15px;font-weight:700;letter-spacing:.01em;}
[data-bl-pill]{font-size:11px;padding:2px 9px;border-radius:999px;font-weight:600;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.3));}
[data-bl-pill][data-tone="live"]{color:#fb7299;border-color:rgba(251,114,153,.5);background:rgba(251,114,153,.1);}
[data-bl-pill][data-tone="idle"]{color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-pill][data-tone="bad"]{color:#f59e0b;border-color:rgba(245,158,11,.5);background:rgba(245,158,11,.1);}
[data-bl-dot]{width:7px;height:7px;border-radius:50%;background:#fb7299;display:inline-block;margin-right:5px;
  animation:bl-breathe 2.4s ease-in-out infinite;}
@keyframes bl-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(.8)}}
[data-bl-grid]{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;}
[data-bl-stat]{padding:9px 10px;border-radius:9px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.09));}
[data-bl-stat] b{display:block;font-size:15px;font-weight:650;margin-bottom:1px;}
[data-bl-stat] span{font-size:11px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-sec]{display:flex;flex-direction:column;gap:9px;}
[data-bl-h]{display:flex;align-items:center;gap:8px;font-size:11px;font-weight:700;letter-spacing:.06em;
  color:var(--dsw-alias-label-tertiary,#9aa0a6);text-transform:uppercase;}
[data-bl-h]::after{content:'';flex:1;height:1px;background:var(--dsw-alias-border-l2,rgba(128,128,128,.18));}
[data-bl-row]{display:flex;align-items:center;gap:10px;}
[data-bl-grow]{flex:1;min-width:0;}
[data-bl-label]{font-size:13px;}
[data-bl-note]{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-input]{width:100%;box-sizing:border-box;padding:8px 10px;border-radius:9px;font-size:12.5px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.2));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:inherit;font-family:inherit;transition:border-color .15s;}
[data-bl-input]:focus{outline:none;border-color:#00aeec;}
[data-bl-num]{width:92px;text-align:center;}
[data-bl-btn]{padding:7px 12px;border-radius:9px;font-size:12px;cursor:pointer;font-family:inherit;white-space:nowrap;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.24));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.12));color:inherit;transition:background .15s;}
[data-bl-btn]:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.22));}
[data-bl-btn][data-primary]{background:#00aeec;border-color:#00aeec;color:#fff;}
[data-bl-btn][data-primary]:hover{background:#0aa0d8;}
[data-bl-btn][data-danger]{color:#fb7299;border-color:rgba(251,114,153,.4);}
[data-bl-btn][disabled]{opacity:.45;cursor:default;}
[data-bl-btn][data-mini]{padding:4px 8px;font-size:11px;border-radius:7px;}
[data-bl-savebar]{margin-top:8px;padding-top:14px;border-top:2px solid var(--dsw-alias-border-default,rgba(128,128,128,.3));}
[data-bl-btn][data-bl-big]{padding:10px 22px;font-size:13.5px;font-weight:700;border-radius:11px;}
[data-bl-sw]{flex:none;width:38px;height:22px;border-radius:11px;border:0;cursor:pointer;position:relative;padding:0;
  background:var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.35));transition:background .15s;}
[data-bl-sw][data-on]{background:#00aeec;}
[data-bl-sw] i{position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;
  transition:left .15s;display:block;}
[data-bl-sw][data-on] i{left:19px;}
[data-bl-sw][disabled]{opacity:.45;cursor:default;}
[data-bl-preview]{font-size:12px;line-height:17px;padding:9px 11px;border-radius:9px;word-break:break-all;
  background:rgba(251,114,153,.08);border:1px dashed rgba(251,114,153,.35);color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bl-preview] b{color:#fb7299;}
[data-bl-list]{display:flex;flex-direction:column;gap:7px;}
[data-bl-item]{display:flex;align-items:center;gap:9px;padding:8px 10px;border-radius:10px;
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.16));
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.06));}
[data-bl-rank]{flex:none;width:22px;height:22px;border-radius:7px;font-size:11px;font-weight:700;
  display:flex;align-items:center;justify-content:center;
  background:linear-gradient(135deg,#fb7299,#00aeec);color:#fff;}
[data-bl-item][data-off]{opacity:.45;}
[data-bl-name]{font-size:12.5px;font-weight:600;}
[data-bl-sub]{font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-sub][data-err]{color:#fb7299;}
[data-bl-live]{font-size:10px;padding:1px 7px;border-radius:6px;background:rgba(251,114,153,.14);color:#fb7299;font-weight:600;}
[data-bl-off]{font-size:10px;padding:1px 7px;border-radius:6px;background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.14));
  color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-msg]{font-size:11px;line-height:16px;padding:8px 10px;border-radius:9px;word-break:break-all;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.1));color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-msg][data-good]{color:#22c55e;background:rgba(34,197,94,.09);}
[data-bl-msg][data-warn]{color:#f59e0b;background:rgba(245,158,11,.09);}
[data-bl-log]{margin:0;padding:10px 11px;border-radius:9px;max-height:180px;overflow:auto;font-size:11px;line-height:17px;
  white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,Consolas,monospace;
  background:var(--dsw-alias-bg-overlay,rgba(0,0,0,.2));color:var(--dsw-alias-label-secondary,#c9ccd1);}
[data-bl-actions]{display:flex;gap:8px;flex-wrap:nowrap;}
[data-bl-qr]{flex:none;width:160px;height:160px;padding:8px;border-radius:12px;background:#fff;
  display:flex;align-items:center;justify-content:center;box-shadow:0 2px 12px rgba(0,0,0,.14);}
[data-bl-qr] svg{display:block;width:100%;height:100%;}
[data-bl-files]{display:flex;flex-direction:column;gap:5px;max-height:196px;overflow:auto;}
[data-bl-file]{display:flex;align-items:center;gap:8px;padding:6px 9px;border-radius:8px;font-size:11.5px;
  background:var(--dsw-alias-bg-overlay,rgba(128,128,128,.07));
  border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.14));}
[data-bl-file] b{flex:1;min-width:0;font-weight:550;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
[data-bl-file] span{flex:none;font-size:10.5px;color:var(--dsw-alias-label-tertiary,#9aa0a6);}
[data-bl-who]{font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;}
[data-bl-who] em{font-style:normal;font-size:10px;font-weight:600;padding:1px 6px;border-radius:5px;
  background:rgba(0,174,236,.14);color:#00aeec;}
`

    function Switch({ on, onChange, disabled }) {
      return h('button', {
        'data-bl-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
        title: on ? '已开' : '已关',
        onClick: () => { if (!disabled) onChange(!on) },
      }, h('i'))
    }

    function ToggleRow({ label, note, on, onChange }) {
      return h('div', { 'data-bl-row': '' },
        h('div', { 'data-bl-grow': '' },
          h('div', { 'data-bl-label': '' }, label),
          note ? h('div', { 'data-bl-note': '' }, note) : null),
        h(Switch, { on, onChange }))
    }

    /** 八维权重的默认值与中文名（与 lib/rating.mjs 的 DEFAULT_WEIGHTS 保持一致） */
    const WEIGHT_DEFAULTS = {
      online: 15, speakers: 10, danmaku: 20, posts: 20,
      payer: 10, guard: 15, likeRate: 5, interaction: 5,
    }
    const WEIGHT_LABELS = {
      online: '同接', speakers: '发言人数', danmaku: '弹幕密度', posts: '月投稿',
      payer: '付费人数', guard: '大航海', likeRate: '获赞率', interaction: '互动率',
    }

    /** 权重表：直接读后端 status.weights（已按用户设置归一），改权重只需要动这一处 */
    function weightTable(st) {
      const w = st?.weights
      if (!w || typeof w !== 'object') return null
      const rows = Object.values(w).filter((x) => x && x.label)
      if (!rows.length) return null
      const maxW = Math.max(...rows.map((x) => Number(x.weight) || 0), 0.01)
      return h('div', { style: { marginTop: '10px' } },
        h('div', { 'data-bl-note': '', style: { marginBottom: '5px' } },
          '当前实际生效的权重（每项先按满分线做对数归一，再按上面的比例加权，八项合计 100%）'),
        ...rows.map((x) => h('div', {
          style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' },
        },
        h('span', { style: { width: '66px', flex: '0 0 66px', fontSize: '12px', opacity: 0.85 } }, x.label),
        h('span', { style: { flex: '1', height: '6px', background: 'rgba(255,255,255,0.08)', borderRadius: '3px', overflow: 'hidden' } },
          h('i', {
            style: {
              display: 'block', height: '6px', borderRadius: '3px',
              width: `${Math.round(((Number(x.weight) || 0) / maxW) * 100)}%`,
              background: 'linear-gradient(90deg,#ffd479,#f0a24a)',
            },
          })),
        h('span', { style: { width: '36px', flex: '0 0 36px', textAlign: 'right', fontSize: '12px', fontWeight: 'bold' } },
          `${Math.round((Number(x.weight) || 0) * 100)}%`),
        h('span', { style: { width: '78px', flex: '0 0 78px', textAlign: 'right', fontSize: '11px', opacity: 0.6 } },
          `满分 ${x.cap}${x.unit || ''}`)))
      )
    }

    function Field({ label, note, value, onChange, placeholder, numeric }) {
      return h('div', { 'data-bl-sec': '' },
        h('div', { 'data-bl-note': '' }, label),
        h('input', {
          'data-bl-input': '', 'data-bl-num': numeric ? '' : undefined,
          value: value ?? '', placeholder: placeholder || '',
          inputMode: numeric ? 'numeric' : undefined,
          onChange: (e) => onChange(e.target.value),
        }),
        note ? h('div', { 'data-bl-note': '' }, note) : null)
    }

    function Panel() {
      const [st, setSt] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [msg, setMsg] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [rows, setRows] = React.useState([''])
      const [rowInfo, setRowInfo] = React.useState([null])
      const [logOpen, setLogOpen] = React.useState(false)
      const [qr, setQr] = React.useState(null)        // { key, svg }
      const [qrMsg, setQrMsg] = React.useState('')
      const [qrBusy, setQrBusy] = React.useState(false)
      const [files, setFiles] = React.useState([])
      const [testText, setTestText] = React.useState(() => {
        // 试发框的内容存在浏览器本地：关掉设置页再进来，上次写的那句还在
        try { return localStorage.getItem('bl-test-text') || '测试一下，打扰了' } catch { return '测试一下，打扰了' }
      })
      // 非受控输入：中文输入法不会在拼音上屏时被 React 回写打断；值单独用 ref 追
      const testRef = React.useRef(testText)

      const refresh = React.useCallback(async () => {
        try {
          const d = await jget('/status')
          setSt(d)
          setFiles(d.recaps || [])
          setForm((old) => old ?? d.config)
        } catch (e) { setMsg({ tone: 'warn', text: '读不到状态：' + (e?.message || e) }) }
      }, [])

      React.useEffect(() => {
        refresh()
        const t = setInterval(refresh, 5000)
        return () => clearInterval(t)
      }, [refresh])

      /* 动态行 ↔ config.streams 的映射：行数和顺序都跟名单一致，几行就是几个人 */
      const applyRows = React.useCallback((cfg) => {
        const list = cfg?.streams || []
        if (!list.length) {
          setRows([''])
          setRowInfo([null])
          return
        }
        setRows(list.map((s) => String(s.mid || s.roomId || '')))
        setRowInfo(list.map((s) => ({ stream: s, info: null })))
      }, [])
      const initedRef = React.useRef(false)
      React.useEffect(() => {
        if (!form || initedRef.current) return
        initedRef.current = true
        applyRows(form)
      }, [form, applyRows])

      /* 关注列表的「正在直播 / 未开播」得自己会变：
         以前只在输入框里查过一次，主播开播了行上还写着「未开播」。
         这里每 30 秒按 roomId 重查一遍，只更新查得到的行，别动用户正在编辑的行。 */
      const liveRef = React.useRef({ rowInfo })
      React.useEffect(() => { liveRef.current = { rowInfo } }, [rowInfo])
      React.useEffect(() => {
        let alive = true
        const syncLive = async () => {
          const infos = liveRef.current.rowInfo || []
          if (!alive || !infos.length) return
          const next = infos.slice()
          let touched = false
          for (let i = 0; i < next.length; i++) {
            const s = next[i]?.stream
            if (!s || !s.roomId) continue
            try {
              const r = await jpost('/resolve', { roomId: s.roomId })
              if (r?.ok && r.info) { next[i] = { stream: { ...s, ...(r.stream || {}) }, info: r.info }; touched = true }
            } catch { /* 单行查不到就保留原状态 */ }
            if (!alive) return
          }
          if (alive && touched) setRowInfo(next)
        }
        const first = setTimeout(syncLive, 3_000)
        const t = setInterval(syncLive, 30_000)
        return () => { alive = false; clearTimeout(first); clearInterval(t) }
      }, [])

      /* 扫码轮询 —— 必须放在下面任何 early return 之前：
         hook 数量在两次渲染间必须一致，放到 return 后面就会触发 React #310 */
      React.useEffect(() => {
        if (!qr?.key) return
        let alive = true
        const ask = async () => {
          try {
            const r = await jpost('/login/poll', { key: qr.key })
            if (!alive) return
            if (r.ok && r.status === 'ok') {
              setQr(null)
              setQrMsg('登录成功' + (r.uname ? '：' + r.uname : ''))
              setMsg({ tone: 'good', text: '登录成功' + (r.uname ? '：' + r.uname : '') })
              refresh()
              return
            }
            if (r.status === 'expired') {
              setQr(null)
              setQrMsg('二维码过期了 —— 点「扫码登录」重新生成一张')
              return
            }
            if (r.status === 'scanned') setQrMsg('扫到了，请在手机上点确认')
            else if (r.status === 'waiting') setQrMsg('用手机 B站 → 「扫一扫」扫这张码')
            else if (!r.ok) setQrMsg(r.error || '查询失败')
          } catch { /* 下一轮再问 */ }
        }
        ask()
        const t = setInterval(ask, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [qr?.key, refresh])

      if (!st || !form) return h('div', { 'data-bl-msg': '' }, '正在读取插件状态…')

      const save = async (patch, okText) => {
        setBusy('save')
        try {
          const r = await jpost('/config', patch)
          setForm(r.config)
          setSt((s) => ({ ...s, config: r.config }))
          setMsg({ tone: 'good', text: okText || '已保存' })
          refresh()
        } catch (e) {
          setMsg({ tone: 'warn', text: '保存失败：' + (e?.message || e) })
        } finally { setBusy('') }
      }

      /* 界面上所有输入框的值 → 一次提交的 patch（不含主播名单） */
      const formPatch = () => ({
        username: form.username,
        aliases: form.aliases,
        replyTemplate: form.replyTemplate,
        introTemplate: form.introTemplate,
        cooldownMs: Number(form.cooldownMs) || 20000,
        dailyLimit: Number(form.dailyLimit) || 0,
        pollMs: Number(form.pollMs) || 60000,
        priorityEnabled: form.priorityEnabled !== false,
        randomWatchMs: Number(form.randomWatchMs) || 1_800_000,
        /* 随机逛的喜好关键词 + 评分推送：也都只在本地 form 里改，必须一起提交 */
        randomKeywords: Array.isArray(form.randomKeywords) ? form.randomKeywords : [],
        ratingEnabled: form.ratingEnabled !== false,
        ratingPushScore: Number(form.ratingPushScore) || 8,
        ratingPushUid: String(form.ratingPushUid || ''),
        /* 八维评分权重：用户在上面自己填的百分数，必须一起提交 */
        ratingWeights: (() => {
          const src = form.ratingWeights && typeof form.ratingWeights === 'object' ? form.ratingWeights : {}
          const out = {}
          for (const k of Object.keys(WEIGHT_LABELS)) {
            const n = Number(src[k] === undefined ? WEIGHT_DEFAULTS[k] : src[k])
            out[k] = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : WEIGHT_DEFAULTS[k]
          }
          return out
        })(),
        /* 声音区：这些输入框只改本地 form，必须一起提交，否则点保存等于没改 */
        listenAudio: form.listenAudio === true,
        asrModel: String(form.asrModel || 'medium'),
        asrLang: String(form.asrLang || 'auto'),
        audioKeywords: Array.isArray(form.audioKeywords) ? form.audioKeywords : [],
        audioReply: form.audioReply !== false,
        audioReplyCooldownMs: Number(form.audioReplyCooldownMs) || 60000,
        audioInRecap: form.audioInRecap !== false,
        /* 画面区：同上 */
        visionEnabled: form.visionEnabled === true,
        visionIntervalMs: Number(form.visionIntervalMs) || 300000,
        visionMaxShots: Number(form.visionMaxShots) || 24,
        visionInRecap: form.visionInRecap !== false,
      })

      const saveForm = () => save(formPatch(), '设置已保存')

      /* 底部的统一保存：主播名单要先逐行解析成真实房间，再和全部设置一起提交 */
      const saveAll = async () => {
        setBusy('save')
        try {
          const next = []
          for (let i = 0; i < rows.length; i++) {
            const k = (rows[i] || '').trim()
            if (!k) continue
            let hit = rowInfo[i]?.stream ? rowInfo[i] : null
            if (!hit) {
              hit = await lookup(k)
              if (!hit) { setMsg({ tone: 'warn', text: `第 ${i + 1} 位主播没查到：${k}` }); return }
              patchRow(i, hit)
            }
            if (next.some((s) => String(s.roomId) === String(hit.stream.roomId))) continue
            next.push({ ...hit.stream, enabled: true })
          }
          const r = await jpost('/config', { ...formPatch(), streams: next })
          setForm(r.config)
          setSt((s) => ({ ...s, config: r.config }))
          applyRows(r.config)
          setMsg({
            tone: 'good',
            text: next.length
              ? `已保存：${next.length} 位主播（第 1 行最优先）+ 全部设置`
              : '已保存：名单空着，按下面的开关随机巡场或待命',
          })
          refresh()
        } catch (e) {
          setMsg({ tone: 'warn', text: '保存失败：' + (e?.message || e) })
        } finally { setBusy('') }
      }

      const patchRow = (i, patch) => setRowInfo((arr) => arr.map((v, j) => (j === i ? patch : v)))

      const lookup = async (key) => {
        const k = String(key || '').trim()
        if (!k) return null
        let r = null
        try { r = await jpost('/resolve', { mid: k }) } catch {}
        if (!r?.ok || !r.stream) { try { r = await jpost('/resolve', { roomId: k }) } catch {} }
        if (!r?.ok || !r.stream) return null
        return { stream: r.stream, info: r.info }
      }

      const resolveRow = async (i) => {
        const k = (rows[i] || '').trim()
        if (!k) { patchRow(i, null); return }
        try {
          const hit = await lookup(k)
          patchRow(i, hit || { error: '没查到这个主播' })
        } catch (e) {
          patchRow(i, { error: '查询失败' })
        }
      }

      /* 按需增删/排序：行 i 就是优先级 i */
      const addRow = () => {
        if (rows.length >= 30) { setMsg({ tone: 'warn', text: '最多 30 位，够用了吧' }); return }
        setRows((a) => [...a, ''])
        setRowInfo((a) => [...a, null])
      }

      const removeRow = (i) => {
        setRows((a) => (a.length <= 1 ? [''] : a.filter((_, j) => j !== i)))
        setRowInfo((a) => (a.length <= 1 ? [null] : a.filter((_, j) => j !== i)))
      }

      const moveRow = (i, dir) => {
        const j = i + dir
        if (j < 0 || j >= rows.length) return
        const swap = (a) => {
          const n = [...a]
          const t = n[i]
          n[i] = n[j]
          n[j] = t
          return n
        }
        setRows(swap)
        setRowInfo(swap)
      }

      /* ── 扫码登录 ── */
      const startLogin = async () => {
        setQrBusy(true)
        setQrMsg('正在向 B站 要二维码…')
        try {
          const r = await jpost('/login/qr')
          if (!r.ok) { setQrMsg(r.error || '要不到二维码'); return }
          setQr({ key: r.key, svg: r.svg })
          setQrMsg('用手机 B站 → 「扫一扫」扫这张码')
        } catch (e) {
          setQrMsg('要不到二维码：' + (e?.message || e))
        } finally { setQrBusy(false) }
      }

      const logout = async () => {
        try {
          await jpost('/logout')
          setQr(null)
          setQrMsg('')
          setMsg({ tone: 'good', text: '已退出登录，想换号再扫一次码就行' })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '退出失败：' + (e?.message || e) }) }
      }

      const openFolder = async () => {
        try {
          const r = await jpost('/open-folder')
          setMsg({ tone: r.ok ? 'good' : 'warn', text: r.ok ? '已打开笔记文件夹' : '打不开，路径：' + r.dir })
        } catch (e) { setMsg({ tone: 'warn', text: '打不开文件夹：' + (e?.message || e) }) }
      }

      const clearPushed = async () => {
        try {
          const r = await jpost('/pushed/clear')
          setMsg({
            tone: r.ok ? 'good' : 'warn',
            text: r.ok ? `已清空 ${r.cleared || 0} 位主播的推送记录，他们下次再拿高分还会推` : '清空失败',
          })
          refresh()
        } catch (e) { setMsg({ tone: 'warn', text: '清空失败：' + (e?.message || e) }) }
      }

      const testLlm = async () => {
        setBusy('llm')
        try {
          const r = await jpost('/llm-test')
          setMsg(r.ok
            ? { tone: 'good', text: `模型接上了（${r.provider || '?'} / ${r.model || '?'}，${r.ms}ms）：${r.text}` }
            : { tone: 'warn', text: '模型没接上：' + (r.error || '空回复') })
        } catch (e) {
          setMsg({ tone: 'warn', text: '测试失败：' + (e?.message || e) })
        } finally { setBusy('') }
      }

      /* 只在用户自己点按钮时发一条 —— 你的账号、你的直播间，打扰与否由你决定 */
      const sendTest = async () => {
        const text = String(testRef.current || '').trim()
        if (!text) return setMsg({ tone: 'warn', text: '先写一句要发的话' })
        setBusy('send')
        try {
          const r = await jpost('/send-test', { text })
          setMsg(r.ok
            ? { tone: 'good', text: `发出去了（${r.uname || r.room}）：「${r.text}」` }
            : { tone: 'warn', text: '没发出去：' + (r.error || '未知原因') })
        } catch (e) {
          setMsg({ tone: 'warn', text: '发送失败：' + (e?.message || e) })
        } finally { setBusy('') }
      }

      const cur = st.current
      const tone = !st.config.enabled ? 'idle' : cur ? 'live' : 'idle'
      const pillText = !st.config.enabled ? '已关闭' : !st.loggedIn ? '未登录' : cur ? '在看直播' : '守候中'

      return h('div', { 'data-bl-page': '' },
        /* ── 状态 ── */
        h('div', { 'data-bl-hero': '' },
          h('div', { 'data-bl-hero-top': '' },
            h('span', { 'data-bl-title': '' }, '直播总结'),
            h('span', { 'data-bl-pill': '', 'data-tone': tone },
              tone === 'live' ? h('span', { 'data-bl-dot': '' }) : null, pillText),
            h('span', { 'data-bl-note': '', style: { marginLeft: 'auto' } }, 'v' + (st.version || '?'))),
          h('div', { 'data-bl-grid': '' },
            h('div', { 'data-bl-stat': '' },
              h('b', {}, cur ? cur.uname : '—'),
              h('span', {}, cur ? `房间 ${cur.realRoomId}` : '当前没有在看的直播间')),
            h('div', { 'data-bl-stat': '' }, h('b', {}, String(st.state?.replyCount ?? 0)), h('span', {}, '今天已回复')),
            h('div', { 'data-bl-stat': '' }, h('b', {}, String(st.received ?? 0)), h('span', {}, '已收到的弹幕')),
            h('div', { 'data-bl-stat': '' }, h('b', {}, String((st.config.streams || []).length)), h('span', {}, '关注的主播'))),
          cur ? h('div', { 'data-bl-note': '', style: { marginTop: '10px' } },
            `《${cur.title || '未命名直播间'}》 · ${cur.status === 'connected' ? '弹幕已连上' : cur.status === 'connecting' ? '正在连弹幕…' : '连接中断，会自动重试'}`) : null,
          st.lastError ? h('div', { 'data-bl-msg': '', 'data-warn': '' }, '⚠ ' + st.lastError) : null,
          h('div', { 'data-bl-row': '', style: { marginTop: '12px' } },
            h('button', { 'data-bl-btn': '', disabled: busy === 'tick', onClick: async () => {
              setBusy('tick')
              try { const r = await jpost('/tick'); setSt((s) => ({ ...s, current: r.current })); setMsg({ tone: 'good', text: r.current ? '已进入直播间' : '现在没有主播在播' }); refresh() } catch (e) { setMsg({ tone: 'warn', text: '检查失败：' + (e?.message || e) }) } finally { setBusy('') }
            } }, busy === 'tick' ? '检查中…' : '立即检查一次'),
            h('button', { 'data-bl-btn': '', onClick: () => setLogOpen((v) => !v) }, logOpen ? '收起日志' : '看运行日志'),
            cur ? h('a', { 'data-bl-btn': '', href: cur.url, target: '_blank', rel: 'noreferrer', style: { textDecoration: 'none' } }, '去直播间') : null)),
        msg ? h('div', { 'data-bl-msg': '', 'data-good': msg.tone === 'good' ? '' : undefined, 'data-warn': msg.tone === 'warn' ? '' : undefined }, msg.text) : null,
        h('div', { 'data-bl-note': '', style: { marginTop: '8px' } },
          '下面的设置改完不会立刻生效，要滚到页面最底部点一次「保存全部设置」（只有开关类会即时生效）。'),
        logOpen ? h('pre', { 'data-bl-log': '' }, (st.logs || []).join('\n') || '（还没有日志）') : null,

        /* ── 账号 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, 'B站账号'),
          h('div', { 'data-bl-who': '' },
            h('span', {}, st.loggedIn
              ? (st.login?.uname ? `已登录 · ${st.login.uname}` : '已登录')
              : '还没有登录'),
            st.loggedIn && st.login?.own ? h('em', {}, '插件自己的登录') : null),
          st.loggedIn && st.login?.uid
            ? h('div', { 'data-bl-note': '' }, 'UID ' + st.login.uid)
            : null,
          st.loggedIn
            ? h('div', { 'data-bl-row': '' },
              h('div', { 'data-bl-grow': '' },
                h('div', { 'data-bl-note': '' }, '发弹幕用的就是这个账号。想换号，先退出再重新扫码。')),
              h('button', { 'data-bl-btn': '', 'data-danger': '', onClick: logout }, '退出登录'))
            : h('div', { 'data-bl-row': '' },
              h('div', { 'data-bl-grow': '' },
                h('div', { 'data-bl-note': '' }, '扫一次码，插件自己存一份凭证，以后不用再登。')),
              h('button', {
                'data-bl-btn': '', 'data-primary': '', disabled: qrBusy,
                onClick: startLogin,
              }, qrBusy ? '正在要码…' : qr ? '重新生成' : '扫码登录')),
          (qr || qrMsg)
            ? h('div', { 'data-bl-row': '', style: { alignItems: 'flex-start', marginTop: '4px' } },
              qr ? h('div', { 'data-bl-qr': '', dangerouslySetInnerHTML: { __html: qr.svg } }) : null,
              h('div', { 'data-bl-grow': '' },
                h('div', { 'data-bl-note': '' }, qrMsg || ''),
                qr ? h('div', { 'data-bl-note': '', style: { marginTop: '6px', opacity: 0.8 } },
                  '手机：B站 → 我的 → 扫一扫 → 确认登录') : null))
            : null),

        /* ── 身份：自我介绍 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '自我介绍'),
          h('div', { 'data-bl-note': '' }, '第一次进入某个直播间、第一次开口时，会先自报家门。名字填你 B站 的昵称。'),
          h('input', {
            'data-bl-input': '', value: form.username || '', placeholder: '填你自己的 B站昵称',
            onChange: (e) => setForm((f) => ({ ...f, username: e.target.value })),
          }),
          h('div', { 'data-bl-preview': '' },
            '每个新直播间说的第一句：',
            h('br'),
            h('b', {}, (form.introTemplate || '我是bilibili用户{name}的ai小助手').replace(/\{name\}/g, form.username || '（还没填名字）')),
            ' ',
            h('span', { style: { opacity: 0.75 } }, form.replyTemplate || '')),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '别名（别人可能用别的叫法叫你，逗号分隔）'),
              h('input', {
                // 非受控：受控时 onChange 会把数组 join 回去覆盖输入框，逗号打不进去
                'data-bl-input': '', defaultValue: (form.aliases || []).join('，'), placeholder: '小助手，助手，某某',
                onChange: (e) => setForm((f) => ({ ...f, aliases: e.target.value.split(/[,，、\s]+/).filter(Boolean) })),
              }))),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '自我介绍模板（{name} 会被替换成上面的昵称）'),
              h('input', {
                'data-bl-input': '', value: form.introTemplate || '',
                onChange: (e) => setForm((f) => ({ ...f, introTemplate: e.target.value })),
              })))),

        /* ── 回复行为 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '什么时候开口'),
          h(ToggleRow, {
            label: '被叫到就回复',
            note: '只在弹幕里出现你的名字 / @你 / 别名时才发一句话；其余时间一声不吭',
            on: form.autoReply !== false,
            onChange: (v) => save({ autoReply: v }, v ? '已开启自动回复' : '已关闭自动回复'),
          }),
          h('div', { 'data-bl-note': '', style: { margin: '2px 0 12px' } }, '自由回复 · 固定开启：第一次开口先自我介绍，之后被叫到都由模型看着当前弹幕临场回一句，关不掉。'),
          h(ToggleRow, {
            label: '固定回复（兜底）',
            note: '模型没接上或生成失败时，退回到下面这句；关掉就宁可不发。',
            on: form.fixedReply !== false,
            onChange: (v) => save({ fixedReply: v }, v ? '已开启固定回复兜底' : '已关闭固定回复，模型失败就不吱声'),
          }),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '兜底用的那句话'),
              h('input', {
                'data-bl-input': '', value: form.replyTemplate || '',
                onChange: (e) => setForm((f) => ({ ...f, replyTemplate: e.target.value })),
              }))),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '同一房间最短间隔（秒）'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: Math.round((Number(form.cooldownMs) || 20000) / 1000),
                onChange: (e) => setForm((f) => ({ ...f, cooldownMs: Math.max(5, Number(e.target.value) || 5) * 1000 })),
              })),
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '每天最多回几条'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: form.dailyLimit ?? 30,
                onChange: (e) => setForm((f) => ({ ...f, dailyLimit: Number(e.target.value) || 0 })),
              }))),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '检查开播的间隔（秒）'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: Math.round((Number(form.pollMs) || 60000) / 1000),
                onChange: (e) => setForm((f) => ({ ...f, pollMs: Math.max(20, Number(e.target.value) || 60) * 1000 })),
              }))),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '试发一条弹幕（只在你看直播时可用，点了才发）'),
              h('input', {
                // 非受控：受控时中文输入法的拼音上屏会被回写打断，看起来像「打了字没进去」
                'data-bl-input': '', defaultValue: testText, placeholder: '测试一下，打扰了',
                onChange: (e) => {
                  const v = e.target.value
                  testRef.current = v
                  try { localStorage.setItem('bl-test-text', v) } catch { /* 无痕模式写不了就算了 */ }
                },
              }))),
          h('div', { 'data-bl-row': '' },
            h('button', { 'data-bl-btn': '', disabled: busy === 'llm', onClick: testLlm }, busy === 'llm' ? '测试中…' : '测一下模型'),
            h('button', { 'data-bl-btn': '', disabled: busy === 'send' || !st.current, onClick: sendTest }, busy === 'send' ? '发送中…' : '试发一条'),
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '', style: { textAlign: 'right' } },
                st.llm?.available ? '自由回复和直播总结都靠它' : '宿主没提供 llm，会退化成固定话术'))),

        /* ── 听声音 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '听直播的声音'),
          h('div', { 'data-bl-note': '', style: { margin: '2px 0 12px' } }, '一边看一边把主播说的话转成文字，全程在本机跑、不联网。直播总结会带上它；命中你设的关键词时，还可以像观众那样接一句。改完下面的数字，滚到最底部点「保存全部设置」。'),
          h(ToggleRow, {
            label: '听直播里的声音',
            note: st.audio?.listening
              ? `正在听：已转写 ${st.audio.transcribed} 段 / ${st.audio.chars} 字${st.audio.dropped ? `（失败 ${st.audio.dropped} 段）` : ''}`
              : (st.audio?.asr?.available ? '进直播间后开始听，每十几秒切一片转写' : '本机没有可用的 python + faster-whisper，这个开关现在打不开'),
            on: form.listenAudio === true,
            onChange: (v) => save({ listenAudio: v }, v ? '已开启听声音' : '已停止听声音'),
          }),
          st.audio?.listening && st.audio?.lastText
            ? h('div', { 'data-bl-note': '', style: { marginBottom: '10px' } }, `刚刚听到：「${String(st.audio.lastText).slice(0, 40)}」`)
            : null,
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '主播说什么语言'),
              h('select', {
                'data-bl-input': '',
                value: form.asrLang || 'auto',
                onChange: (e) => save({ asrLang: e.target.value }, '已切换语音语言'),
              },
                h('option', { value: 'auto' }, '自动识别（中日英混着说也行）'),
                h('option', { value: 'zh' }, '中文'),
                h('option', { value: 'ja' }, '日语'),
                h('option', { value: 'en' }, '英语'),
              ))),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '要留意的词（逗号分隔，听到就接一句）'),
              /* 故意用非受控：受控时每敲一个逗号就被 split 回去重写，光标会跳 */
              h('input', {
                'data-bl-input': '', defaultValue: (form.audioKeywords || []).join('，'), placeholder: '例如：点歌， 抽奖， 下播',
                onChange: (e) => {
                  const text = String(e.target.value || '')
                  setForm((f) => ({ ...f, audioKeywords: text.split(/[,，、\s]+/).map((x) => x.trim()).filter(Boolean) }))
                },
              }))),
          h(ToggleRow, {
            label: '听到关键词就接一句',
            note: '和弹幕回复共用每天的额度；没命中词就只是默默把话记下来',
            on: form.audioReply === true,
            onChange: (v) => save({ audioReply: v }, v ? '已开启听声回复' : '已关闭听声回复'),
          }),
          h(ToggleRow, {
            label: '把主播说的话写进直播总结',
            note: '总结会参考语音转写的内容（转写可能有错字，只当语境）；关掉就只用弹幕',
            on: form.audioInRecap !== false,
            onChange: (v) => save({ audioInRecap: v }, v ? '总结会参考主播说的话' : '总结只看弹幕'),
          }),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '听声回复的最短间隔（秒）'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: Math.round((Number(form.audioReplyCooldownMs) || 60000) / 1000),
                onChange: (e) => setForm((f) => ({ ...f, audioReplyCooldownMs: Math.max(15, Number(e.target.value) || 15) * 1000 })),
              }))),
        ),

        /* ── 看画面 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '看直播的画面'),
          h('div', { 'data-bl-note': '', style: { margin: '2px 0 12px' } }, '另外拉一路视频流，隔一阵截一张图存下来；这场直播结束时把几张图一起交给模型，让它说说画面上在干什么。截图只存在本机，只有进总结的那几张会随请求发给模型。改完下面的数字，滚到最底部点「保存全部设置」。'),
          h(ToggleRow, {
            label: '截取直播画面',
            note: st.vision?.watching
              ? `正在看：已截 ${st.vision.shots} 张${st.vision.dropped ? `（失败 ${st.vision.dropped} 次）` : ''}`
              : `进直播间后每 ${Math.round((Number(form.visionIntervalMs) || 300000) / 60000)} 分钟截一张`,
            on: form.visionEnabled === true,
            onChange: (v) => save({ visionEnabled: v }, v ? '已开始截画面' : '已停止截画面'),
          }),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '隔多久截一张（分钟）'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: Math.round((Number(form.visionIntervalMs) || 300000) / 60000),
                onChange: (e) => setForm((f) => ({ ...f, visionIntervalMs: Math.max(1, Number(e.target.value) || 5) * 60000 })),
              })),
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '一场最多截几张'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: Number(form.visionMaxShots) || 24,
                onChange: (e) => setForm((f) => ({ ...f, visionMaxShots: Math.max(1, Number(e.target.value) || 24) })),
              }))),
          h(ToggleRow, {
            label: '总结时把画面给模型看',
            note: '一张图大约一两千 token；关掉就只存图、不进总结',
            on: form.visionInRecap !== false,
            onChange: (v) => save({ visionInRecap: v }, v ? '总结会参考画面' : '总结只看文字'),
          }),
        ),

        /* ── 守谁：按需添加，行序即优先级 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '守谁 · 按需添加'),
          h('div', { 'data-bl-note': '' }, '想守谁就加一行。从上往下就是优先级：几个主播同时在播时只进最上面那个，它下播了才轮到下一个。留空的行走人。'),
          h('div', { 'data-bl-list': '' },
            rows.map((v, i) => h('div', { key: i, 'data-bl-item': '' },
              h('div', { 'data-bl-rank': '' }, String(i + 1)),
              h('div', { 'data-bl-grow': '' },
                h('input', {
                  'data-bl-input': '', value: v,
                  placeholder: i === 0 ? '最优先的那个：主播 UID' : '主播 UID（可以留空）',
                  onChange: (e) => {
                    const nv = e.target.value
                    setRows((a) => a.map((x, j) => (j === i ? nv : x)))
                    patchRow(i, null)
                  },
                  onBlur: () => resolveRow(i),
                  onKeyDown: (e) => { if (e.key === 'Enter') e.target.blur() },
                }),
                rowInfo[i]?.stream
                  ? h('div', { 'data-bl-sub': '' },
                    '✓ ' + (rowInfo[i].stream.name || '这位主播') + (
                      rowInfo[i].info
                        ? (Number(rowInfo[i].info.liveStatus) === 1 ? ' · 正在直播' : ' · 未开播')
                        : ' · 状态未知（每 30 秒自动重查）'))
                  : rowInfo[i]?.error
                    ? h('div', { 'data-bl-sub': '', 'data-err': '' }, rowInfo[i].error)
                    : null),
              h('button', {
                'data-bl-btn': '', 'data-mini': '', title: '上移一位',
                disabled: i === 0, style: { opacity: i === 0 ? 0.35 : 1 },
                onClick: () => moveRow(i, -1),
              }, '↑'),
              h('button', {
                'data-bl-btn': '', 'data-mini': '', title: '下移一位',
                disabled: i === rows.length - 1, style: { opacity: i === rows.length - 1 ? 0.35 : 1 },
                onClick: () => moveRow(i, 1),
              }, '↓'),
              h('button', {
                'data-bl-btn': '', 'data-mini': '', title: '不守这个人了',
                onClick: () => removeRow(i),
              }, '✕'))),
          ),
          h('div', { 'data-bl-row': '', style: { marginTop: '4px' } },
            h('button', { 'data-bl-btn': '', disabled: rows.length >= 30, onClick: addRow }, '+ 添加一位主播')),
          h('div', { style: { marginTop: '10px' } },
            h(ToggleRow, {
              label: '启用关注名单（优先级）',
              note: form.priorityEnabled === false
                ? '已关闭：不看上面的名单，改成随机巡场；名单内容原样留着，随时打开就能接着用'
                : '打开时只守上面这些主播（行序即优先级）；关掉后随机巡场，名单不会被清空',
              on: form.priorityEnabled !== false,
              onChange: (v) => save({ priorityEnabled: v }, v ? '已启用关注名单' : '已暂停名单，改随机巡场'),
            }),
            h('div', { 'data-bl-note': '', style: { margin: '6px 0 4px' } }, '喜好关键词（逗号分隔，随机巡场时优先挑标题/主播名命中的）'),
            h('input', {
              // 非受控：受控时每次 onChange 都会把数组 join 回去覆盖输入框，
              // 用户刚敲的逗号被改写成全角、光标还跳到末尾 —— 看起来就是「逗号打不进去」
              'data-bl-input': '', defaultValue: (form.randomKeywords || []).join('，'),
              placeholder: '例如：虚拟主播，唱歌，三角洲',
              onChange: (e) => setForm((f) => ({
                ...f,
                randomKeywords: e.target.value.split(/[,，、\s]+/).filter(Boolean).slice(0, 12),
              })),
            }),
            h('div', { 'data-bl-note': '', style: { opacity: 0.75 } }, '命中就优先进去；一个都没命中时退回纯随机，不会干等着。'),
            h('div', { 'data-bl-row': '', style: { marginTop: '8px' } },
              h('div', { 'data-bl-grow': '' },
                h('div', { 'data-bl-note': '' }, '每个随机直播间看多久换下一个（分钟）'),
                h('input', {
                  'data-bl-input': '', 'data-bl-num': '',
                  value: Math.round((form.randomWatchMs ?? 1_800_000) / 60_000),
                  onChange: (e) => setForm((f) => ({ ...f, randomWatchMs: Math.min(240, Math.max(1, Number(e.target.value) || 30)) * 60_000 })),
                }))),
            h('div', { 'data-bl-note': '', style: { opacity: 0.75 } }, '看满就走：先给这位打分、写笔记，再随机挑下一个。关注名单里的主播不受影响。'))),

        /* ── 主播评分 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '主播评分'),
          h('div', { 'data-bl-note': '' }, '看满时长后给主播打分（满分 10）：同接、发言人数、弹幕密度、月投稿数、付费、获赞率、大航海、互动率八项，各自按量级归一后加权。分数会写进直播笔记。随机巡场和关注名单里的主播都会打分，区别在推送——只有随机巡场进来的、分数超过下面那条线的才发私信；关注的主播是特意守的，分数只留在笔记里。'),
          h(ToggleRow, {
            label: '下播后给主播打分',
            note: '关掉就不算分，也不会有高分推送',
            on: form.ratingEnabled !== false,
            onChange: (v) => save({ ratingEnabled: v }, v ? '已开启打分' : '已关闭打分'),
          }),
          h('div', { 'data-bl-row': '' },
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '多少分以上私信推送'),
              h('input', {
                'data-bl-input': '', 'data-bl-num': '', value: form.ratingPushScore ?? 8,
                onChange: (e) => setForm((f) => ({ ...f, ratingPushScore: Math.min(10, Math.max(1, Number(e.target.value) || 8)) })),
              })),
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '' }, '推送给哪个 UID（不能是本账号）'),
              h('input', {
                'data-bl-input': '', value: form.ratingPushUid || '', placeholder: '留空 = 只记分不推送',
                onChange: (e) => setForm((f) => ({ ...f, ratingPushUid: e.target.value })),
              }))),
          h('div', { 'data-bl-note': '', style: { opacity: 0.78, marginTop: '2px' } },
            'B站 不允许自己给自己发私信（code 21026）：登录的是你的号，推送就要填另一个收件 UID；留空则分数只留在笔记里，不会打扰你。'),
          st.rating?.best
            ? h('div', { 'data-bl-msg': '', 'data-good': '' },
              `正在采样：同接 ${st.rating.best.online} · 月投稿 ${st.rating.best.posts30d} 条 · 获赞率 ${st.rating.best.likesPerVideo || 0}/稿 · 付费 ${st.rating.best.payerCount} · 大航海 ${st.rating.best.guardCount}`)
            : null,
          h('div', { style: { marginTop: '12px' } },
            h('div', { 'data-bl-note': '', style: { marginBottom: '6px' } },
              '各维权重（百分数，随便填；算分时按合计归一，不用凑满 100。填 0 = 完全不看这一项）'),
            ...Object.keys(WEIGHT_LABELS).map((k) => h('div', {
              style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '2px 0' },
            },
            h('span', { style: { width: '66px', flex: '0 0 66px', fontSize: '12px', opacity: 0.85 } }, WEIGHT_LABELS[k]),
            h('input', {
              'data-bl-input': '', 'data-bl-num': '',
              value: (form.ratingWeights || {})[k] ?? WEIGHT_DEFAULTS[k],
              onChange: (e) => {
                const n = Math.max(0, Math.min(100, Number(e.target.value) || 0))
                setForm((f) => ({ ...f, ratingWeights: { ...(f.ratingWeights || WEIGHT_DEFAULTS), [k]: n } }))
              },
            }),
            h('span', { style: { fontSize: '11px', opacity: 0.5 } }, '%'))),
            h('div', { 'data-bl-note': '', style: { opacity: 0.65, marginTop: '2px' } },
              `合计 ${Object.keys(WEIGHT_LABELS).reduce((a, k) => a + Number(((form.ratingWeights || {})[k] ?? WEIGHT_DEFAULTS[k]) || 0), 0)}%（滚到最底部点「保存全部设置」）`)),
          weightTable(st),
          st.lastPush
            ? h('div', { 'data-bl-msg': '', 'data-good': st.lastPush.ok },
              `上次推送：${st.lastPush.uname} ${st.lastPush.score} 分 → ${st.lastPush.uid}${st.lastPush.ok ? ' ✓' : ` ✗ ${st.lastPush.error || ''}`}`)
            : null,
          st.pushed?.count
            ? h('div', { 'data-bl-note': '', style: { marginTop: '4px' } },
              `近一个月推过 ${st.pushed.count} 位主播，同一位一个月内不重复推：${st.pushed.list.slice(0, 5).map((x) => x.uname || x.uid).join('、')}${st.pushed.count > 5 ? ' 等' : ''}`)
            : null,
          st.pushed?.count
            ? h('button', { 'data-bl-btn': '', 'data-mini': '', onClick: clearPushed }, '清空推送记录')
            : null),

        /* ── 直播笔记 ── */
        h('div', { 'data-bl-sec': '' },
          h('div', { 'data-bl-h': '' }, '直播笔记'),
          h('div', { 'data-bl-note': '' }, '一场直播结束，自动写一张 txt：这场大概播了什么、弹幕都聊些啥。文件名是「年-月-日 主播名字.txt」。'),
          st.recording
            ? h('div', { 'data-bl-msg': '', 'data-good': '' },
              `正在记录「${cur?.uname || '当前直播间'}」：已收 ${st.recording.danmaku} 条弹幕，下播就落盘`)
            : null,
          files.length
            ? h('div', { 'data-bl-files': '' }, files.map((f, i) => h('div', { key: i, 'data-bl-file': '', title: f.path },
              h('b', {}, f.name.replace(/\.txt$/, '')),
              h('span', {}, (Math.max(0.1, f.size / 1024)).toFixed(1) + ' KB'))))
            : h('div', { 'data-bl-note': '', style: { opacity: 0.8 } }, '还没有笔记 —— 等第一场直播结束'),
          h('div', { 'data-bl-row': '', style: { marginTop: '2px' } },
            h('button', { 'data-bl-btn': '', 'data-primary': '', onClick: openFolder }, '打开笔记文件夹'),
            h('button', { 'data-bl-btn': '', 'data-mini': '', onClick: refresh }, '刷新列表'),
            h('div', { 'data-bl-grow': '' },
              h('div', { 'data-bl-note': '', style: { textAlign: 'right', wordBreak: 'break-all', fontSize: '10px' } }, st.recapDir || '')))),

        h('div', { 'data-bl-note': '' },
          '它的家：' + st.home,
          h('br'),
          st.login?.own ? '凭证：插件自己扫码登录的账号'
            : '凭证：还没有登录 —— 在上面点「扫码登录」',
          h('br'),
          '模型：' + (st.llm?.available ? `${st.llm.provider} / ${st.llm.model}` : '宿主没提供 llm 服务，自由回复和总结会退化成固定话术'))),

        /* ── 统一保存：整页改完点这一个按钮 ── */
        h('div', { 'data-bl-sec': '', 'data-bl-savebar': '' },
          h('div', { 'data-bl-h': '' }, '保存'),
          h('div', { 'data-bl-note': '' },
            '上面每一处改动都先留在本地（主播名单、回复话术、冷却与上限、声音、画面、评分），',
            '只有点下面这个按钮才真正生效。开关类会即时生效，输入框不会。'),
          h('div', { 'data-bl-row': '' },
            h('button', {
              'data-bl-btn': '', 'data-primary': '', 'data-bl-big': '',
              disabled: busy === 'save',
              onClick: saveAll,
            }, busy === 'save' ? '保存中…' : '保存全部设置'),
            h('div', { 'data-bl-grow': '' },
              h('div', {
                'data-bl-note': '',
                style: { textAlign: 'right', color: msg?.tone === 'warn' ? '#ff9a9a' : undefined },
              }, msg ? msg.text : (rows.length ? `当前名单 ${rows.filter((x) => String(x).trim()).length} 位` : '当前名单为空（随机巡场/待命）')))),
          h('div', { 'data-bl-note': '', style: { opacity: 0.75 } },
            '名单会被重新核对一遍主播身份（查不到的那一行会报出是第几位），其余设置原样提交；同一个直播间不会重复加进去。'))
      )
    }

    /* 面板万一渲染崩了，别整节白屏 —— 把错误摆出来当成线索 */
    class Boundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { err: null }
      }
      static getDerivedStateFromError(err) {
        return { err }
      }
      componentDidCatch(err) {
        try { console.error('[dsh-bili-live] 面板渲染出错', err) } catch { /* 忽略 */ }
      }
      render() {
        const e = this.state.err
        if (!e) return this.props.children
        const text = String((e && (e.stack || e.message)) || e)
        return h('div', { 'data-bl-page': '' },
          h('div', { 'data-bl-msg': '' }, '「直播总结」面板渲染时出错了 —— 把下面这段发给我就能定位：'),
          h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: '11px', lineHeight: 1.5, opacity: 0.85 } }, text))
      }
    }

    return {
      // 必须声明 slots 依赖：前端 boot 时若 inject 为空数组，fiber 虽能进
      // active，但服务不会注入到本 fiber；且往 settings.section 里注入 UI 的
      // 时机必须排在声明该槽位的插件之后。旧的空数组写法会让注册静默失效。
      inject: ['slots'],
      apply(ctx) {
        try {
          if (!document.querySelector('style[data-plugin-css="dsh-bili-live"]')) {
            const style = document.createElement('style')
            style.setAttribute('data-plugin-css', 'dsh-bili-live')
            style.textContent = CSS
            document.head.appendChild(style)
          }
        } catch (e) {
          try { console.warn('[dsh-bili-live] 样式注入失败', (e && e.message) || e) } catch { /* 忽略 */ }
        }

        // 不用 ctx.effect（第三方 ctx 上不一定有，抛错会中断整个 apply）
        let slots = null
        try {
          slots = (ctx && typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || (ctx && ctx.slots)
        } catch { /* 拿不到就按不可用处理 */ }
        if (!slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return
        try {
          slots.inject('settings.section', () => slots.register(
            { name: 'settings.section', id: 'bili-live', order: 31, label: '直播总结' },
            () => h(Boundary, null, h(Panel)),
          ))
        } catch (e) {
          try { console.warn('[dsh-bili-live] 设置页注册失败', (e && e.message) || e) } catch { /* 忽略 */ }
        }
      },
    }
  },
})
