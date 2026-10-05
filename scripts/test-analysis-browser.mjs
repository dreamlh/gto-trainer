// Run against Vite on an isolated port. Supply PLAYWRIGHT_MODULE if not installed locally.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.GTO_ANALYSIS_URL || 'http://127.0.0.1:5178'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors = []
const navigate = async (page, name) => {
  const trigger = page.locator('.app-navigation-trigger')
  if (await trigger.isVisible() && await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await page.locator('nav.tabs').getByRole('button', { name, exact: true }).click()
}
const noOverflow = async page => assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Horizontal viewport overflow')
try {
  if (!process.argv.includes('--storage-only')) for (const width of [1440, 320]) for (const language of ['en', 'zh']) {
    const context = await browser.newContext({ viewport: { width, height: width === 320 ? 740 : 1050 }, hasTouch: width === 320 })
    await context.addInitScript(language => localStorage.setItem('gto.language', language), language)
    const page = await context.newPage()
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(base)
    await navigate(page, language === 'en' ? 'Equity' : '权益计算')
    const eq = page.locator('.panel').filter({ has: page.locator('.eq-board') })
    await eq.getByRole('button', { name: 'A♠', exact: true }).click()
    await eq.getByRole('button', { name: 'K♠', exact: true }).click()
    await eq.getByRole('button', { name: language === 'en' ? 'Calculate equity' : '计算权益', exact: true }).click()
    await eq.locator('.eq-result').waitFor()
    const editor = eq.locator('.analysis-range')
    assert.equal(await editor.locator('textarea').isVisible(), false)
    await editor.locator('.analysis-matrix-details summary').click()
    const aa = editor.locator('[data-hand="0"]')
    const old = await aa.getAttribute('aria-pressed')
    if (width === 320) await aa.tap(); else await aa.click()
    assert.notEqual(await aa.getAttribute('aria-pressed'), old)
    assert.equal(await eq.locator('.eq-result').count(), 0, 'Editing invalidates equity')
    await aa.focus(); await page.keyboard.press('ArrowRight')
    assert.equal(await page.locator(':focus').getAttribute('data-hand'), '1')
    await page.keyboard.press('Space')
    await noOverflow(page)
    await page.screenshot({ path: `/tmp/gto-range-replay-${width}-${language}.png`, fullPage: true })
    // Inactive exact hands must no longer block cards; switching back removes conflicts.
    const first = eq.locator('.eq-player').first()
    await first.getByRole('button', { name: language === 'en' ? 'Range' : '范围', exact: true }).click()
    await eq.locator('.eq-board .card-slot').first().click()
    assert.equal(await eq.getByRole('button', { name: 'A♠', exact: true }).isEnabled(), true)
    await eq.getByRole('button', { name: 'A♠', exact: true }).click()
    await first.getByRole('button', { name: language === 'en' ? 'Exact hand' : '指定手牌', exact: true }).click()
    assert.equal(await first.locator('.card-slot').first().innerText(), '?')
    await navigate(page, language === 'en' ? 'Solver' : '求解器')
    const solver = page.locator('.panel').filter({ has: page.locator('.solver-inputs') })
    await solver.getByRole('button', { name: language === 'en' ? 'Apply scenario' : '应用场景', exact: true }).waitFor()
    await page.waitForFunction(() => [...document.querySelectorAll('.solver-inputs')].some(el => el.parentElement.querySelector('.analysis-range-summary')?.textContent.includes('%')))
    for (const card of ['2♥','3♦','4♣','5♥','6♦']) await solver.getByRole('button', { name: card, exact: true }).click()
    for (const range of await solver.locator('.analysis-range').all()) await range.getByRole('button', { name: language === 'en' ? 'Premium QQ+/AK' : '超强牌 QQ+/AK', exact: true }).click()
    await solver.getByRole('button', { name: language === 'en' ? 'Quick' : '快速', exact: true }).click()
    await solver.getByRole('button', { name: language === 'en' ? 'Solve' : '求解', exact: true }).click()
    await solver.locator('.solver-result').waitFor({ timeout: 60000 })
    await solver.locator('.num-input').first().fill('10')
    assert.equal(await solver.locator('.solver-result').count(), 0)
    await solver.getByRole('button', { name: language === 'en' ? 'Solve' : '求解', exact: true }).click()
    await solver.locator('.num-input').first().fill('11')
    await page.waitForTimeout(1200)
    assert.equal(await solver.locator('.solver-result').count(), 0, 'Cancelled old solve must not restore results')
    await noOverflow(page)
    console.log(`PASS ${width}px ${language}: no text input, matrix/touch/keyboard, cards/range mode, actual solve, invalidation and layout`)
    await context.close()
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } })
  await context.addInitScript(() => localStorage.setItem('gto.language', 'en'))
  const page = await context.newPage(), second = await context.newPage()
  await page.goto(base); await second.goto(base)
  const positions = ['UTG','HJ','CO','BTN','SB','BB']
  const action = (playerId, kind, amount = 0, street = 'preflop') => ({ playerId, kind, amount, street })
  const hand = { number: 1, finishedAt: 1, bigBlind: 1, smallBlind: .5, board: [1,6,11,13,18], boards: [[1,6,11,13,18]],
    players: positions.map(position => ({ id: position, name: position, position, bot: false })), myCards: [48,44], delta: {}, showdown: true, runResults: [],
    replay: { version: 1, mode: 'cash', startingStacks: Object.fromEntries(positions.map(p => [p,100])) },
    history: [action('SB','small-blind',.5),action('BB','big-blind',1),action('UTG','fold'),action('HJ','fold'),action('CO','fold'),action('BTN','raise',2.5),action('SB','fold'),action('BB','call',1.5),
      action('BB','check',0,'flop'),action('BTN','raise',2,'flop'),action('BB','call',2,'flop'),action('BB','raise',6,'turn'),action('BTN','call',6,'turn')] }
  const room = { instanceId: 'browser-review', selfId: 'BTN', handHistory: Array.from({length:1005}, (_,i) => ({...hand,number:i+1,finishedAt:i+1})) }
  const seed = (target, input) => target.evaluate(async room => { const m = await import('/src/db/replayStore.ts'); await m.saveRoomReplays(room); return m.listReplays() }, input)
  let stored = await seed(page, room)
  assert.equal(stored.records.length, 1000)
  assert.equal(stored.records.at(-1).hand.number, 6)
  await page.reload()
  await navigate(page, 'Statistics')
  await page.getByText('1000 / 1,000 hands', { exact: false }).waitFor()
  const history = page.locator('.analysis-history-list')
  await history.locator('summary').first().click()
  await history.getByRole('button', { name: 'Review hand', exact: true }).first().click()
  let dialog = page.getByRole('dialog', { name: 'Choose a review spot' })
  await dialog.getByText('Pot: 5.5 BB', { exact: true }).waitFor()
  assert.equal(await dialog.locator('.slot-row .card-face').count(), 3)
  await dialog.getByRole('button', {name:'Calculate equity',exact:true}).click()
  await page.locator('[data-page="equity"]').waitFor()
  assert.equal(await page.locator('.eq-player').first().locator('.card-slot .card-face').count(), 2)
  await navigate(page, 'Statistics')
  await history.getByRole('button', {name:'Review hand',exact:true}).first().click()
  dialog = page.getByRole('dialog', { name: 'Choose a review spot' })
  await dialog.getByLabel('Review street', { exact: true }).selectOption('river')
  await dialog.getByText('Pot: 21.5 BB', {exact:true}).waitFor()
  await dialog.getByRole('button', {name:'Open solver',exact:true}).click()
  await page.locator('[data-page="solver"]').waitFor()
  assert.equal(await page.locator('.solver-inputs .num-input').first().inputValue(), '21.5')
  assert.equal(await page.locator('.solver-inputs .num-input').last().inputValue(), '89.5')
  await seed(second, room)
  await navigate(page,'Statistics')
  await page.getByRole('button',{name:'Clear history',exact:true}).click()
  await page.getByRole('dialog').getByRole('button',{name:'Clear history',exact:true}).click()
  await page.getByRole('dialog').waitFor({state:'hidden'})
  await page.getByText('0 / 1,000 hands', {exact:false}).waitFor()
  stored = await seed(second, room)
  assert.equal(stored.records.length,0,'Stale tab must not reimport cleared server history')
  const third = await context.newPage(); await third.goto(base)
  stored = await seed(third,room)
  assert.equal(stored.records.length,0,'Reloaded tab must respect persistent clear watermark')
  const next = {...room,handHistory:[{...hand,number:1006,finishedAt:1006}]}
  stored = await seed(second,next)
  assert.equal(stored.records.length,1)
  await page.reload(); await navigate(page,'Statistics')
  await page.getByText('1 / 1,000 hands',{exact:false}).waitFor()
  console.log('PASS IndexedDB: reload, 1000-hand cap, review imports, street values, clear UI, stale tabs, persistent watermarks and post-clear new hands')
  await context.close()
  for (const unavailable of [true, false]) {
    const fallback = await browser.newContext()
    await fallback.addInitScript(unavailable => {
      localStorage.setItem('gto.language', 'en')
      if (unavailable) Object.defineProperty(window, 'indexedDB', { value: undefined })
      else {
        const transaction = IDBDatabase.prototype.transaction
        IDBDatabase.prototype.transaction = function(stores,mode,...rest) {
          if (this.name === 'gto-replays' && mode === 'readwrite') throw new DOMException('Simulated quota exhaustion', 'QuotaExceededError')
          return transaction.call(this,stores,mode,...rest)
        }
      }
    },unavailable)
    const p = await fallback.newPage(); p.on('pageerror',e=>errors.push(e.message)); await p.goto(base)
    const data = await seed(p,{...room,handHistory:[hand]})
    assert.equal(data.available,false)
    assert.equal(data.records.length,1,'Storage failure retains the current-page review')
    await navigate(p,'Statistics')
    await p.getByText('Local storage is unavailable or a write failed.',{exact:false}).waitFor()
    if (unavailable) {
      await p.getByRole('button',{name:'Clear history',exact:true}).click()
      await p.getByRole('dialog').getByRole('button',{name:'Clear history',exact:true}).click()
      await p.getByText('0 / 1,000 hands',{exact:false}).waitFor()
      assert.equal((await seed(p,{...room,handHistory:[hand]})).records.length,0,'Memory-only clear also blocks stale polls')
    }
    await navigate(p,'Equity')
    await p.getByRole('button',{name:'Calculate equity',exact:true}).waitFor()
    await fallback.close()
  }
  console.log('PASS unavailable storage and write failures: visible warning, memory fallback, clear tombstones and usable analysis UI')
  assert.deepEqual(errors,[])
} finally { await browser.close() }
