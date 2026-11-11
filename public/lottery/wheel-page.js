/* The server owns redemption, expiry, probability and the single recorded result. */
;(function () {
  'use strict'

  const tiers = {
    'special-small': '特惠小转盘',
    'special-medium': '特惠中转盘',
    'value-large': '超值大转盘',
    'ultimate-large': '终极大转盘',
  }
  const tier = document.body.dataset.tier
  if (!Object.prototype.hasOwnProperty.call(tiers, tier)) return
  const spinButtons = Array.from(document.querySelectorAll('[data-spin]'))
  const feedback = document.getElementById('draw-feedback')
  const form = document.getElementById('redemption-form')
  const input = document.getElementById('redemption-code')
  const redeemButton = document.getElementById('redeem-button')
  const codeStatus = document.getElementById('code-status')
  const expiryText = document.getElementById('code-expiry')
  const wheelAssembly = document.querySelector('.wheel-assembly')
  const wheelRim = document.querySelector('.wheel-rim')
  const colors = ['#ead1f3', '#fbf8ff', '#e8dbfa', '#f4cce8', '#f2eafa', '#dec7f0']
  let myLucky
  let generation = 0
  let publicGeneration = 0
  let busy = false
  let spinning = false
  let animationTimer
  let animationGeneration = -1
  let revealResult = true
  let configured = false
  let wheelPrizes = []
  let session = null
  let needsRevalidation = false
  let resultDisplayKey = null
  let syncWheelSize = () => {}
  const display = {
    rules: ['兑换码仅限对应转盘使用，每码仅可抽奖一次。', '兑换码自打手接单起 1 小时内有效，取消或退款后作废。', '过期或作废后，无法抽奖及查看中奖结果。', '抽奖结果以服务器记录为准。'],
    recommendations: [],
  }

  function textElement(tag, content, className) {
    const element = document.createElement(tag)
    element.textContent = String(content)
    if (className) element.className = className
    return element
  }

  function safeUrl(value, assetOnly) {
    if (typeof value !== 'string' || !value.trim()) return null
    try {
      const url = new URL(value, location.href)
      if (!['http:', 'https:'].includes(url.protocol) || url.origin !== location.origin || url.username || url.password) return null
      if (assetOnly && !/^\/api\/studio\/lottery\/assets\/[^/]+$/.test(url.pathname)) return null
      return url.href
    } catch (_) { return null }
  }

  function imageUrl(image) {
    return image && typeof image === 'object' ? safeUrl(image.url, true) : null
  }

  function renderRecommendations(items) {
    const cards = []
    for (const item of Array.isArray(items) ? items : []) {
      if (!item || typeof item.title !== 'string' || !item.title.trim()) continue
      const href = safeUrl(item.url, false)
      if (!href) continue
      const card = document.createElement('a')
      card.className = 'recommendation-card'
      card.href = href
      card.appendChild(textElement('h3', item.title))
      if (item.subtitle != null) card.appendChild(textElement('p', item.subtitle))
      if (item.price != null && String(item.price).trim()) card.appendChild(textElement('strong', item.price, 'recommendation-price'))
      cards.push(card)
    }
    document.getElementById('recommendation-grid').replaceChildren(...cards)
    document.getElementById('recommendations').hidden = cards.length === 0
  }

  function millisLeft() {
    return session ? session.deadline - performance.now() : 0
  }

  function activeSession() {
    return Boolean(session && millisLeft() > 0 && !needsRevalidation)
  }

  function updateButtons() {
    spinButtons.forEach(button => {
      button.disabled = busy || spinning || !myLucky || !configured || !activeSession() || session.remaining !== 1
      button.setAttribute('aria-busy', String(busy || spinning))
    })
    redeemButton.disabled = busy || spinning || !input.value.trim()
    input.setAttribute('aria-busy', String(busy))
    document.body.classList.toggle('is-spinning', spinning)
  }

  function renderSession() {
    const active = activeSession()
    document.querySelectorAll('[data-remaining]').forEach(element => {
      element.textContent = active ? String(session.remaining) : '—'
    })
    expiryText.hidden = !active
    if (active) {
      const seconds = Math.max(0, Math.ceil(millisLeft() / 1000))
      expiryText.textContent = '兑换码剩余有效时间 ' + Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
    } else expiryText.textContent = ''
    const list = document.getElementById('my-prizes')
    const result = active && revealResult ? session.result : null
    const resultKey = result ? JSON.stringify([result.prizeId, result.title, imageUrl(result.image)]) : ''
    if (resultDisplayKey === resultKey) { updateButtons(); return }
    resultDisplayKey = resultKey
    if (result) {
      const li = document.createElement('li')
      const src = imageUrl(result.image)
      if (src) {
        const image = document.createElement('img')
        image.src = src
        image.alt = ''
        image.width = image.height = 46
        image.addEventListener('error', () => image.remove(), { once: true })
        li.appendChild(image)
      }
      li.appendChild(textElement('span', result.title))
      list.replaceChildren(li)
    } else {
      const empty = textElement('li', '', 'empty-state')
      empty.append(textElement('span', '♧', 'empty-icon'), textElement('span', '暂无奖品记录'))
      list.replaceChildren(empty)
    }
    updateButtons()
  }

  function stopAnimation() {
    clearTimeout(animationTimer)
    animationGeneration = -1
    if (spinning && myLucky) myLucky.stop(-1)
    spinning = false
    syncWheelSize()
  }

  function clearSession(message, clearInput) {
    generation += 1
    stopAnimation()
    busy = false
    session = null
    // Remove the previous landing position as well as the private result text.
    if (myLucky) void myLucky.init()
    needsRevalidation = false
    revealResult = true
    if (clearInput) input.value = ''
    codeStatus.textContent = message || '请输入客服发送的兑换码'
    feedback.textContent = ''
    renderSession()
  }

  function normalizePrizes(prizes) {
    if (!Array.isArray(prizes) || prizes.length !== 6) throw new Error('奖池配置暂不可用，请稍后重试。')
    const ids = new Set()
    return prizes.map(prize => {
      if (!prize || typeof prize.id !== 'string' || !prize.id || ids.has(prize.id) || typeof prize.title !== 'string') throw new Error('奖池配置暂不可用，请稍后重试。')
      ids.add(prize.id)
      return { id: prize.id, title: prize.title, image: imageUrl(prize.image) ? { url: imageUrl(prize.image) } : null }
    })
  }

  function wheelSize() {
    const style = getComputedStyle(wheelRim)
    return Math.max(160, Math.round(wheelRim.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)))
  }

  function canvasPrizes(prizes) {
    return prizes.map((prize, index) => {
      const src = imageUrl(prize.image)
      return {
        background: colors[index],
        fonts: [{ text: prize.title || '未配置', top: src ? '37%' : '21%', fontSize: Math.round(wheelSize() * 0.034) + 'px', wordWrap: true, lengthLimit: '78%', lineClamp: 3 }],
        imgs: src ? [{ src, width: '18%', height: '18%', top: '10%' }] : [],
      }
    })
  }

  function renderWheel(prizes) {
    const changed = JSON.stringify(prizes) !== JSON.stringify(wheelPrizes)
    wheelPrizes = prizes
    document.getElementById('my-lucky').setAttribute('aria-label', '六格转盘：' + prizes.map(prize => prize.title || '未配置').join('、'))
    if (!window.LuckyCanvas) {
      feedback.textContent = '转盘暂时不可用，请稍后重试。'
      return
    }
    if (myLucky) {
      if (changed) myLucky.prizes = canvasPrizes(prizes)
      return
    }
    const size = wheelSize()
    myLucky = new window.LuckyCanvas.LuckyWheel('#my-lucky', {
      width: size,
      height: size,
      blocks: [{ padding: '10px', background: '#303033' }, { padding: '3px', background: '#b4a6b9' }, { padding: '3px', background: '#242426' }],
      prizes: canvasPrizes(prizes),
      buttons: [{ radius: '23%', background: '#29282d' }],
      defaultStyle: { fontColor: '#17171a', fontWeight: '900', fontStyle: '"Microsoft YaHei", "PingFang SC", sans-serif' },
      defaultConfig: { gutter: 5, offsetDegree: -30, accelerationTime: 350, decelerationTime: 1400 },
      start: startDraw,
      end() {
        if (animationGeneration !== generation) return
        spinning = false
        busy = false
        revealResult = true
        if (millisLeft() <= 0) return expireSession()
        codeStatus.textContent = '此兑换码已使用，无法再次抽奖'
        feedback.textContent = session && session.result ? '本次抽中：' + session.result.title : ''
        syncWheelSize()
        renderSession()
      },
    })
    // Kept for the existing visual adapter and acceptance tooling; it grants no server authority.
    window.myLucky = myLucky
    if ('ResizeObserver' in window) {
      let lastSize = size
      syncWheelSize = () => {
        if (spinning) return
        const nextSize = wheelSize()
        if (nextSize === lastSize) return
        lastSize = nextSize
        myLucky.width = nextSize
        myLucky.height = nextSize
        myLucky.prizes = canvasPrizes(wheelPrizes)
      }
      new ResizeObserver(syncWheelSize).observe(wheelAssembly)
    }
  }

  function acceptView(view, code, requestStarted, animate) {
    if (!view || view.tier !== tier || ![0, 1].includes(view.remaining) || typeof view.configured !== 'boolean') throw new Error('服务器响应异常，请重试验证兑换码。')
    const prizes = normalizePrizes(view.prizes)
    const expiresAt = Date.parse(view.expiresAt)
    const serverTime = Date.parse(view.serverTime)
    if (!Number.isFinite(expiresAt) || !Number.isFinite(serverTime)) throw new Error('服务器响应异常，请重试验证兑换码。')
    const deadline = requestStarted + Math.max(0, expiresAt - serverTime)
    if (deadline <= performance.now()) return expireSession()
    let result = null
    if (view.result != null) {
      if (view.remaining !== 0 || !view.result || typeof view.result.prizeId !== 'string' || typeof view.result.title !== 'string' || !prizes.some(prize => prize.id === view.result.prizeId)) throw new Error('开奖结果暂无法显示，请重新验证兑换码。')
      result = { prizeId: view.result.prizeId, title: view.result.title, image: view.result.image, drawnAt: view.result.drawnAt }
    } else if (view.remaining !== 1) throw new Error('服务器响应异常，请重试验证兑换码。')
    configured = view.configured
    session = { code, remaining: view.remaining, deadline, result }
    needsRevalidation = false
    renderWheel(prizes)
    revealResult = !animate
    codeStatus.textContent = result ? '此兑换码已使用，无法再次抽奖' : (configured ? '验证成功，可以抽奖一次' : '转盘尚未配置，请联系客服')
    renderSession()
    return true
  }

  async function request(path, code) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 15000)
    try {
      const response = await fetch('/api/studio/lottery/' + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store', signal: controller.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tier, code }),
      })
      let data
      try { data = await response.json() } catch (_) { data = null }
      if (!response.ok) {
        const error = new Error(response.status === 429 ? '操作过于频繁，请稍后重试。' : response.status === 409 ? '转盘尚未配置，请联系客服。' : response.status === 400 ? '兑换码无效、已过期、已作废或不属于当前转盘，请联系客服。' : '服务暂不可用，请稍后重试。')
        error.unavailable = response.status === 400
        throw error
      }
      return data
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof TypeError) throw new Error('网络连接失败，结果尚未确认。可用原码重试，或重新验证查看。')
      throw error
    } finally { clearTimeout(timeout) }
  }

  async function redeem(code, revalidation) {
    if (!code || busy || spinning) return
    const ownGeneration = ++generation
    publicGeneration += 1
    busy = true
    feedback.textContent = ''
    codeStatus.textContent = revalidation ? '正在重新验证有效期…' : '正在验证兑换码…'
    updateButtons()
    const started = performance.now()
    try {
      const view = await request('redeem', code)
      if (ownGeneration !== generation) return
      acceptView(view, code, started, false)
    } catch (error) {
      if (ownGeneration !== generation) return
      clearSession(error.message || '网络连接失败，请重试验证兑换码。', Boolean(error.unavailable))
    } finally {
      if (ownGeneration === generation) { busy = false; renderSession() }
    }
  }

  async function startDraw() {
    if (busy || spinning || !configured || !myLucky || !activeSession() || session.remaining !== 1) return
    const ownGeneration = generation
    const code = session.code
    busy = true
    feedback.textContent = '正在确认开奖结果…'
    updateButtons()
    const started = performance.now()
    try {
      const view = await request('draw', code)
      if (ownGeneration !== generation) return
      if (!view || !view.result) throw new Error('开奖结果尚未确认，请重试或重新验证兑换码。')
      if (!acceptView(view, code, started, true)) return
      const index = wheelPrizes.findIndex(prize => prize.id === session.result.prizeId)
      if (index < 0) throw new Error('开奖结果暂无法显示，请重新验证兑换码。')
      spinning = true
      animationGeneration = ownGeneration
      feedback.textContent = '开奖结果已确认，转盘展示中…'
      updateButtons()
      myLucky.play()
      animationTimer = setTimeout(() => {
        if (ownGeneration !== generation || !activeSession()) return
        myLucky.stop(index)
      }, 500)
    } catch (error) {
      if (ownGeneration !== generation) return
      if (error.unavailable) clearSession(error.message, true)
      else {
        revealResult = true
        feedback.textContent = error.message || '网络连接失败，结果尚未确认。可用原码重试，或重新验证查看。'
      }
    } finally {
      if (ownGeneration === generation && !spinning) { busy = false; renderSession() }
    }
  }

  async function loadPublic() {
    const ownGeneration = ++publicGeneration
    try {
      const response = await fetch('/api/studio/lottery/public/' + encodeURIComponent(tier), { credentials: 'omit', cache: 'no-store' })
      if (!response.ok) throw new Error('奖池暂时无法加载，请稍后重试验证兑换码。')
      const view = await response.json()
      if (ownGeneration !== publicGeneration || session) return
      if (!view || view.tier !== tier || typeof view.configured !== 'boolean') throw new Error('奖池配置暂不可用，请稍后重试。')
      const prizes = normalizePrizes(view.prizes)
      configured = view.configured
      renderWheel(prizes)
      if (!configured) codeStatus.textContent = '转盘尚未配置，请联系客服'
    } catch (error) {
      if (ownGeneration === publicGeneration && !session) codeStatus.textContent = error.message || '奖池暂时无法加载，请稍后重试验证兑换码。'
    }
    updateButtons()
  }

  function expireSession() {
    clearSession('兑换码已到期，无法抽奖或查看结果，请联系客服。', true)
    void loadPublic()
  }

  // Presentation only: outside callers cannot set remaining chances or a recorded result.
  function setData(data) {
    if (!data || typeof data !== 'object') return
    if (Array.isArray(data.rules)) display.rules = data.rules.filter(rule => typeof rule === 'string' && rule.trim())
    if (Array.isArray(data.recommendations)) display.recommendations = data.recommendations
    document.getElementById('activity-rules').replaceChildren(...display.rules.map(rule => textElement('li', rule)))
    renderRecommendations(display.recommendations)
  }
  window.WheelPage = Object.freeze({ setData })
  window.addEventListener('wheel-page:data', event => setData(event.detail))
  form.addEventListener('submit', event => { event.preventDefault(); void redeem(input.value.trim(), false) })
  input.addEventListener('input', () => {
    if (session || busy || spinning) clearSession('兑换码已更改，请重新验证。', false)
    updateButtons()
  })
  spinButtons.forEach(button => button.addEventListener('click', startDraw))
  setInterval(() => {
    if (session && millisLeft() <= 0) expireSession()
    else if (session) renderSession()
  }, 250)
  setInterval(() => {
    if (session && !document.hidden && !busy && !spinning) void redeem(session.code, true)
  }, 30000)
  document.addEventListener('visibilitychange', () => {
    if (!session) return
    if (document.hidden) {
      needsRevalidation = true
      renderSession()
      return
    }
    if (millisLeft() <= 0) return expireSession()
    const code = session.code
    clearSession('正在重新验证有效期…', false)
    void redeem(code, true)
  })
  window.addEventListener('pagehide', () => clearSession('', true))
  window.addEventListener('pageshow', event => { if (event.persisted) { clearSession('', true); void loadPublic() } })
  setData(display)
  renderWheel(Array.from({ length: 6 }, (_, index) => ({ id: tier + '-' + (index + 1), title: '', image: null })))
  renderSession()
  void loadPublic()
})()
