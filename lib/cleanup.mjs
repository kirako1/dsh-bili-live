/**
 * 清理插件自己攒下的临时文件。
 *
 * 一场直播的中间产物（切片 flv、画面截图）只服务于「这一场的总结」，
 * 总结写完、私信发完，它们就没有再留的价值了 —— 用户的原话是
 * 「总结写完后参考资料要删掉，要不然太占空间」。
 *
 * 两道清理：
 *   1. clearRoomTmp —— 某场直播收尾时，删掉这个房间的全部切片与截图；
 *   2. sweepTmp     —— 兜底扫一遍，删掉超龄的残留（崩溃/断电留下的孤儿文件）。
 */
import { readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** tmp 下按房间存的两类目录 */
const SUBS = ['live', 'shots']

/** 兜底扫除的默认年龄：6 小时 */
const DEFAULT_MAX_AGE = 6 * 3600_000

const eachFile = (dir, fn) => {
  let names = []
  try {
    names = readdirSync(dir)
  } catch {
    return // 目录还不存在，正常
  }
  for (const name of names) {
    const p = join(dir, name)
    try {
      const st = statSync(p)
      if (st.isFile()) fn(p, st)
    } catch {
      /* 被别处删了或没权限，跳过 */
    }
  }
}

/** 删掉某个房间留下的全部中间文件（seg-<room>-…、shot-<room>-…） */
export function clearRoomTmp(home, roomId) {
  const tag = `-${roomId}-`
  let files = 0
  let bytes = 0
  for (const sub of SUBS) {
    eachFile(join(home, 'tmp', sub), (p, st) => {
      const name = p.slice(p.lastIndexOf('\\') + 1)
      if (!name.includes(tag)) return
      try {
        rmSync(p, { force: true })
        files += 1
        bytes += st.size
      } catch {
        /* 删不掉就算了，交给兜底扫描 */
      }
    })
  }
  return { files, bytes }
}

/** 删掉超过 maxAgeMs 没动过的中间文件，防止崩溃留下的孤儿文件越积越多 */
export function sweepTmp(home, { maxAgeMs = DEFAULT_MAX_AGE, now = Date.now() } = {}) {
  let files = 0
  let bytes = 0
  for (const sub of SUBS) {
    eachFile(join(home, 'tmp', sub), (p, st) => {
      if (now - st.mtimeMs < maxAgeMs) return
      try {
        rmSync(p, { force: true })
        files += 1
        bytes += st.size
      } catch {
        /* 跳过 */
      }
    })
  }
  return { files, bytes }
}

/** 给日志用的体积写法 */
export const mb = (bytes) => `${Math.max(0, Math.round((bytes / 1048576) * 10) / 10)} MB`
