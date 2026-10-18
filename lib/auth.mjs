/**
 * lib/auth.mjs —— 插件自己的 B站扫码登录
 * ============================================================================
 * 一次扫码，插件自己存一份凭证（`<家>/credential.json`），不再依赖「刷B站」。
 *
 * 流程（B站网页扫码登录的三步）：
 *   ① GET  /x/passport-login/web/qrcode/generate?source=main-fe-site-header
 *          → { qrcode_key, url }，把 url 画成二维码给用户扫
 *   ② 用户手机扫 + 确认
 *   ③ GET  /x/passport-login/web/qrcode/poll?...&qrcode_key=xxx
 *          → data.code：86101 未扫码 / 86090 已扫待确认 / 86038 已过期 / 0 成功
 *          成功时 data.url 上挂着 SESSDATA / bili_jct / DedeUserID，抠出来就是凭证。
 *
 * buvid3 不在登录响应里，单独问 `/x/frontend/finger/spi` 拿一个（发弹幕要它）。
 * ============================================================================
 */
import { readFileSync } from 'node:fs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36'
const REF = 'https://www.bilibili.com/'
const HDRS = { 'User-Agent': UA, Referer: REF, Origin: REF }

const GEN = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-site-header'
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?source=main-fe-site-header&qrcode_key='

/* ────────────────────────── 二维码图片 ────────────────────────── */

let qrLib = null

/**
 * 把 vendor/qrcode.js 当普通脚本执行（它是 UMD，直接 import 会拿不到函数）。
 * @param {string} file vendor 里的二维码库路径
 */
export function loadQrLib(file) {
  if (qrLib) return qrLib
  const src = readFileSync(file, 'utf8')
  const mod = { exports: {} }
  // eslint-disable-next-line no-new-func
  new Function('module', 'exports', 'define', src)(mod, mod.exports, undefined)
  const fn = typeof mod.exports === 'function' ? mod.exports : mod.exports?.qrcode
  if (typeof fn !== 'function') throw new Error('二维码库没加载出来')
  qrLib = fn
  return fn
}

/** 把一段文本画成 SVG 字符串（前端直接塞进 <img>） */
export function qrSvg(qrFile, text, cellSize = 4) {
  const make = loadQrLib(qrFile)
  const qr = make(0, 'M')
  qr.addData(String(text))
  qr.make()
  return qr.createSvgTag({ cellSize, margin: 2 })
}

/* ────────────────────────── 扫码三步 ────────────────────────── */

async function getJson(url, init) {
  const r = await fetch(url, { ...init, headers: { ...HDRS, ...(init?.headers || {}) } })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch { /* 下面统一报 */ }
  return { r, json, text }
}

/** ① 要一张新二维码 */
export async function generateQr() {
  const { json } = await getJson(GEN)
  if (!json || json.code !== 0 || !json.data?.qrcode_key) {
    throw new Error(json?.message || 'B站没给二维码')
  }
  return { key: String(json.data.qrcode_key), url: String(json.data.url || '') }
}

/** 拿一个 buvid3（发弹幕要）。拿不到不致命，只是可能被风控。 */
export async function fetchBuvid3() {
  try {
    const { json } = await getJson('https://api.bilibili.com/x/frontend/finger/spi')
    return String(json?.data?.b_3 || '')
  } catch {
    return ''
  }
}

/** 从跳转 URL 或 set-cookie 里抠凭证 */
function credFromUrl(url) {
  try {
    const u = new URL(url)
    const g = (k) => u.searchParams.get(k) || ''
    const sessdata = decodeURIComponent(g('SESSDATA'))
    if (!sessdata) return null
    return {
      sessdata,
      bili_jct: g('bili_jct'),
      dedeuserid: g('DedeUserID'),
      expires: g('Expires'),
    }
  } catch {
    return null
  }
}

function credFromCookies(list) {
  const bag = {}
  for (const line of list || []) {
    const [pair] = String(line).split(';')
    const i = pair.indexOf('=')
    if (i > 0) bag[pair.slice(0, i).trim()] = pair.slice(i + 1).trim()
  }
  if (!bag.SESSDATA) return null
  return {
    sessdata: bag.SESSDATA,
    bili_jct: bag.bili_jct || '',
    dedeuserid: bag.DedeUserID || '',
    buvid3: bag.buvid3 || '',
  }
}

/**
 * ③ 问一次「扫得怎么样了」
 * @returns {{status:'waiting'|'scanned'|'expired'|'ok'|'error', cred?:object, message?:string}}
 */
export async function pollQr(key) {
  const { r, json } = await getJson(POLL + encodeURIComponent(key))
  if (!json || json.code !== 0) return { status: 'error', message: json?.message || '查询失败' }
  const c = Number(json.data?.code)
  if (c === 86101) return { status: 'waiting' }
  if (c === 86090) return { status: 'scanned' }
  if (c === 86038) return { status: 'expired', message: '二维码过期了，重新生成一张' }
  if (c !== 0) return { status: 'error', message: json.data?.message || `未知状态 ${c}` }

  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []
  const cred = credFromUrl(json.data?.url) || credFromCookies(setCookies)
  if (!cred) return { status: 'error', message: '登录成功但没拿到 SESSDATA' }
  if (!cred.buvid3) cred.buvid3 = await fetchBuvid3()
  return { status: 'ok', cred }
}

/** 用刚拿到的凭证问一下「我是谁」，顺便当登录成功的验证 */
export async function whoAmI(cred) {
  const cookie = [`SESSDATA=${cred.sessdata}`, cred.bili_jct ? `bili_jct=${cred.bili_jct}` : '', cred.dedeuserid ? `DedeUserID=${cred.dedeuserid}` : '']
    .filter(Boolean)
    .join('; ')
  const { json } = await getJson('https://api.bilibili.com/x/web-interface/nav', { headers: { Cookie: cookie } })
  if (!json || json.code !== 0) return null
  return { uname: String(json.data?.uname || ''), mid: String(json.data?.mid || '') }
}
