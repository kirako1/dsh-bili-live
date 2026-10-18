/**
 * lib/llm.mjs —— 借 DSH 宿主的大模型说人话
 * ============================================================================
 * 插件没有自己的模型，也不该有：DSH 进程里跑着 llm 服务，`ctx.get('llm')` 就能
 * 借到。这里只做两件事：把它包成「给一段提示，回来一段话」，以及**任何失败都
 * 吞掉返回空**——直播间的回复少一句无所谓，卡住主流程才是事故。
 *
 * 路由（provider/model）默认跟随 DSH 当前的默认模型：
 *   agentDefaultModel.currentSelection() → llm.listProviders()[0] → 配置里写死的
 * 这样用户换了默认模型，插件自动跟着换，不用回来改设置。
 * ============================================================================
 */

/**
 * @param {object} ctx 插件上下文
 * @param {object} cfg 插件配置（读 llmEnabled / llmProvider / llmModel）
 */
export function makeLlm(ctx, cfg) {
  // 惰性取：插件 apply 的时候 llm 服务可能还没挂上，等真要用时再问
  const getSvc = () => {
    try {
      return ctx?.get?.('llm') || null
    } catch {
      return null
    }
  }

  const getDefaultModel = () => {
    try {
      const sel = ctx?.get?.('agentDefaultModel')?.currentSelection?.()
      if (sel?.provider && sel?.model) return { provider: String(sel.provider), model: String(sel.model) }
    } catch {
      /* 没有这个服务就算了 */
    }
    return null
  }

  /** 当前该走哪条路由；一条都没有就返回 null */
  const resolveRoute = () => {
    const svc = getSvc()
    let provider = String(cfg.llmProvider || '').trim()
    let model = String(cfg.llmModel || '').trim()

    if (!provider || !model) {
      const dflt = getDefaultModel()
      if (dflt) {
        provider = provider || dflt.provider
        model = model || dflt.model
      }
    }
    if (!provider) {
      try {
        const first = svc?.listProviders?.()?.[0]
        if (first?.id) provider = String(first.id)
      } catch {
        /* 保底失败就认命 */
      }
    }
    if (!provider) return null
    return { provider, model: model || 'deepseek-flash' }
  }

  return {
    get available() {
      return !!getSvc()
    },

    /** 给设置页/状态接口看：现在准备用哪条路由 */
    route() {
      const r = resolveRoute()
      const providers = (() => {
        try {
          return (getSvc()?.listProviders?.() || []).map((p) => ({ id: String(p.id), name: String(p.name || p.id) }))
        } catch {
          return []
        }
      })()
      return { provider: r?.provider || '', model: r?.model || '', providers }
    },

    /**
     * @param {{system?:string, prompt:string, images?:readonly any[], maxTokens?:number, timeoutMs?:number, onError?:(e:Error)=>void}} o
     * @returns {Promise<string>} 拿到的话；拿不到返回 ''
     */
    async generate(o) {
      const svc = getSvc()
      if (!svc || cfg.llmEnabled === false) return ''
      const route = resolveRoute()
      if (!route) return ''
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), Math.max(3000, o.timeoutMs || 20000))
      try {
        // 只带 maxTokens：temperature 之类有的模型不认，少一个旋钮少一次失败
        const call = await svc.prepareCall(
          { provider: route.provider, model: route.model, maxTokens: Math.max(16, o.maxTokens || 120) },
          ctl.signal,
        )
        const images = Array.isArray(o.images) ? o.images.filter(Boolean) : []
        const messages = [
          {
            role: 'user',
            id: `bili-live-${Date.now()}`,
            source: { kind: 'bili-live' },
            content: [
              ...images.map((attachment) => ({ type: 'image', attachment })),
              { type: 'text', text: String(o.prompt || '') },
            ],
          },
        ]
        let out = ''
        for await (const chunk of call.stream({
          ...(call.config || {}),
          messages,
          ...(o.system ? { system: o.system } : {}),
          signal: ctl.signal,
        })) {
          out += textOf(chunk)
        }
        return out.replace(/^["“”\s]+|["“”\s]+$/g, '').trim()
      } catch (e) {
        // 静默降级，但把原因交出去 —— 设置页 / 日志要看得到为什么没接上
        try { o.onError?.(e) } catch { /* 连报错都别炸 */ }
        return ''
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** 流式 chunk 的形状在不同版本里不太一样，这里能认的都认 */
function textOf(chunk) {
  if (!chunk) return ''
  if (typeof chunk === 'string') return chunk
  if (typeof chunk.text === 'string' && (chunk.type === 'text-delta' || chunk.type === undefined)) return chunk.text
  if (chunk.type === 'text-delta' && chunk.delta?.text) return chunk.delta.text
  if (typeof chunk.delta === 'string') return chunk.delta
  if (chunk.content?.type === 'text' && typeof chunk.content.text === 'string') return chunk.content.text
  return ''
}
