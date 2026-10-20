/**
 * asr.mjs —— 常驻转写进程的 Node 侧封装。
 *
 * 复用的是 bili-duty 已经装好的那套环境（venv-asr + faster-whisper + 本地 small 模型），
 * 不额外下载任何东西：模型缓存指向 ~/.dsh/bili-duty/.hf-cache。
 *
 * 没有可用的 Python 环境时，available 为 false，上层应当降级（只做弹幕总结）。
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import os from 'node:os'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', 'tools', 'asr_worker.py')

/** 找一个能跑 faster-whisper 的 python：配置优先，其次插件自带的 venv，再退到 bili-duty 那套 */
export function findPython(configured) {
  const home = os.homedir()
  const cands = [
    String(configured || '').trim(),
    process.env.BILI_LIVE_ASR_PYTHON || '',
    path.join(home, '.dsh', 'bili-live', '.venv-asr', 'Scripts', 'python.exe'),
    path.join(home, '.dsh', 'bili-live', '.venv-asr', 'bin', 'python'),
    path.join(home, '.dsh', 'bili-duty', '.venv-asr', 'Scripts', 'python.exe'),
    path.join(home, '.dsh', 'bili-duty', '.venv-asr', 'bin', 'python'),
    path.join(home, '.dsh', 'bili-duty', '.venv', 'Scripts', 'python.exe'),
  ]
  for (const c of cands) {
    if (c && existsSync(c)) return c
  }
  return ''
}

/** faster-whisper 的模型缓存目录：优先插件自己家，没有再用 bili-duty 那份 */
export function defaultHfHome() {
  const own = path.join(os.homedir(), '.dsh', 'bili-live', '.hf-cache')
  const shared = path.join(os.homedir(), '.dsh', 'bili-duty', '.hf-cache')
  return existsSync(shared) ? shared : own
}

export class AsrWorker {
  constructor({ python = '', model = 'small', hfHome = '', log = () => {}, maxQueue = 2 } = {}) {
    this.python = python
    this.model = model || 'small'
    this.hfHome = hfHome || defaultHfHome()
    this.log = log
    this.proc = null
    this.rl = null
    this.ready = false
    this.starting = null
    this.pending = new Map()
    this.seq = 0
    this.stderrTail = []
    this.lastError = ''
    this.stats = { count: 0, totalMs: 0, audioSec: 0, dropped: 0 }
    /** 最多允许几段同时在途（1 段正在转 + 其余排队）。直播是实时的，积压没有意义 */
    this.maxQueue = Math.max(1, Number(maxQueue) || 2)
    /** 连续超时次数：用来判断「是不是这台机器根本带不动这个模型」 */
    this.consecutiveTimeouts = 0
  }

  get available() {
    return !!this.python && existsSync(WORKER)
  }

  /** 启动（幂等）：等 worker 吐出 {"ready":true} */
  start() {
    if (this.ready) return Promise.resolve(true)
    if (this.starting) return this.starting
    // 上一轮留下的进程（没等到 ready 就被丢下的那种）先杀掉：它会一直占着 1GB 内存当幽灵
    if (this.proc) {
      try { this.proc.kill() } catch { /* 忽略 */ }
      this.proc = null
    }
    if (!this.available) {
      this.lastError = this.python ? '找不到 tools/asr_worker.py' : '找不到可用的 Python 环境（需要 faster-whisper）'
      return Promise.resolve(false)
    }
    this.starting = new Promise((resolve) => {
      const t0 = Date.now()
      let settled = false
      const done = (ok) => {
        if (settled) return
        settled = true
        this.starting = null
        resolve(ok)
      }
      let proc
      try {
        proc = spawn(this.python, [WORKER, this.model], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, BILI_LIVE_HF_HOME: this.hfHome, PYTHONIOENCODING: 'utf-8' },
        })
      } catch (e) {
        this.lastError = `启动 Python 失败：${e?.message || e}`
        done(false)
        return
      }
      this.proc = proc
      this.stderrTail = []

      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (s) => {
        for (const line of String(s).split('\n')) {
          if (!line.trim()) continue
          this.stderrTail.push(line.trim())
          if (this.stderrTail.length > 12) this.stderrTail.shift()
        }
      })

      proc.on('error', (e) => {
        this.lastError = `Python 进程错误：${e?.message || e}`
        done(false)
      })

      proc.on('exit', (code, sig) => {
        this.ready = false
        this.proc = null
        this.rl?.close?.()
        this.rl = null
        const tail = this.stderrTail.slice(-3).join(' / ')
        const why = tail || String(this.lastError || '')
        for (const [, p] of this.pending) p.reject(new Error(`转写进程退出（code=${code}${sig ? ' sig=' + sig : ''}）${why ? '：' + why : ''}`))
        this.pending.clear()
        if (!settled) {
          this.lastError = why || `转写进程启动即退出（code=${code}）`
          done(false)
          return
        }
        if (this.log) this.log(`转写进程退出 code=${code} ${why}`)
      })

      this.rl = createInterface({ input: proc.stdout })
      this.rl.on('line', (line) => {
        let msg
        try { msg = JSON.parse(line) } catch { return }
        if (msg.ready !== undefined) {
          if (msg.ready) {
            this.ready = true
            this.log?.(`转写就绪 model=${msg.model || this.model}（${Date.now() - t0}ms）`)
            done(true)
          } else {
            this.lastError = String(msg.error || '转写进程未能就绪')
            done(false)
          }
          return
        }
        const id = Number(msg.id)
        const p = this.pending.get(id)
        if (!p) return
        this.pending.delete(id)
        if (msg.ok) p.resolve({ text: String(msg.text || ''), lang: msg.lang || '', sec: Number(msg.sec) || 0, ms: Number(msg.ms) || 0 })
        else p.reject(new Error(String(msg.error || '转写失败')))
      })

      // 模型加载上限 90 秒
      setTimeout(() => {
        if (!settled) {
          this.lastError = this.lastError || '转写进程 90 秒内未就绪'
          // 超时也要杀：否则这个半死不活的进程会一直挂在那儿
          try { proc?.kill() } catch { /* 忽略 */ }
          done(false)
        }
      }, 90000)
    })
    return this.starting
  }

  /** 转写一个音频文件（flv/wav/m4a 都行，faster-whisper 内部用 PyAV 解码） */
  async transcribe(file, { lang = 'auto', timeoutMs = 90000, retried = false } = {}) {
    const ok = await this.start()
    if (!ok) throw new Error(this.lastError || '转写环境不可用')
    // 进程可能刚好退出（空闲被杀 / 崩溃）：stdin 已不可写，重启了再来一次
    if (!this.proc || !this.proc.stdin || this.proc.stdin.destroyed || !this.proc.stdin.writable) {
      if (retried) throw new Error(this.lastError || '转写进程已退出')
      this.ready = false
      return this.transcribe(file, { lang, timeoutMs, retried: true })
    }
    const id = ++this.seq
    // 队列保护：worker 串行处理，积压只会让所有段一起超时。
    // 留「正在处理的 + 最新的一片」就够，中间排队的先丢（直播要的是实时，不是完整回放）。
    if (this.pending.size >= this.maxQueue) {
      const ids = [...this.pending.keys()].sort((a, b) => a - b)
      const victimId = ids.length > 1 ? ids[1] : ids[0]
      const victim = this.pending.get(victimId)
      if (victim) {
        this.pending.delete(victimId)
        this.stats.dropped += 1
        try { victim.reject(new Error('积压过多，丢弃这一片（转写跟不上切片）')) } catch { /* 忽略 */ }
      }
    }
    const payload = JSON.stringify({ id, path: file, lang: lang || '' }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        const stuck = this.pending.size
        this.consecutiveTimeouts += 1
        // 只有「只剩它自己卡住」或「连续两次超时」才值得杀进程：
        // 杀进程会把排队的段一起 SIGTERM，反而制造雪崩
        if (stuck === 0 || this.consecutiveTimeouts >= 2) {
          this.stop()
          reject(new Error(`转写超时（${timeoutMs}ms），已重启转写进程${stuck ? `，连带 ${stuck} 段排队` : ''}`))
        } else {
          reject(new Error(`转写超时（${timeoutMs}ms），丢弃这一片（还有 ${stuck} 段在排队）`))
        }
      }, timeoutMs)
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          this.consecutiveTimeouts = 0
          this.stats.count++
          this.stats.totalMs += v.ms
          this.stats.audioSec += v.sec
          resolve(v)
        },
        reject: (e) => { clearTimeout(timer); reject(e) },
      })
      try {
        this.proc.stdin.write(payload)
      } catch (e) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`写入转写进程失败：${e?.message || e}`))
      }
    })
  }

  /** 切台时丢掉还在排队的转写：它们的结果已经没人要了，留着只会让 worker 白干 */
  cancelPending(reason = '换房间') {
    for (const [, p] of this.pending) {
      try { p.reject(new Error(`${reason}，取消这段转写`)) } catch { /* 忽略 */ }
    }
    this.pending.clear()
  }

  status() {
    return {
      available: this.available,
      ready: this.ready,
      python: this.python,
      model: this.model,
      lastError: this.lastError,
      ...this.stats,
    }
  }

  stop() {
    const proc = this.proc
    this.ready = false
    this.proc = null
    try { proc?.stdin?.end('{"cmd":"quit"}\n') } catch { /* 忽略 */ }
    const kill = () => { try { proc?.kill() } catch { /* 忽略 */ } }
    setTimeout(kill, 1500)
  }
}
