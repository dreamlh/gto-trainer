// Mock only the room transport; exercise the actual table, composer and local setting.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const base = process.env.GTO_ANALYSIS_URL || 'http://127.0.0.1:5178'
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const errors = []
function makeRoom(capacity) {
  const ids = Array.from({length: capacity}, (_,i) => `p${i}`)
  const stats = Object.fromEntries(['hands','vpip','pfr','threeBet','threeBetOpportunities','cbet','cbetOpportunities','sawFlop','showdowns','showdownWins','betsRaises','calls','netBB'].map(k => [k,0]))
  return { code: 'CHATTEST', instanceId: `chat-${capacity}`, revision: 1, actionRevision: 1, hostId: 'p0', selfId: 'p0', capacity, initialStack: 100, mode: 'cash',
    players: ids.map((id,seat) => ({id,seat,name:`Player ${seat+1}`,bot:false,connected:true,score:0,pendingSeat:null,stack:97.5,sittingOut:false,timeCards:3,stats,shareWithSpectators:false,entryStatus:'ready'})),
    hand: {number:1,street:'flop',board:[1,6,11],boards:[[1,6,11]],pot:5, dealerId:ids.at(-1),smallBlindId:'p0',bigBlindId:'p1',toAct:'p0',
      players: ids.map((id,seat) => ({id,seat,cards:seat===0?[48,44]:null,stack:97.5,invested:2.5,streetBet:0,folded:false,allin:false})),
      legal:{canFold:true,canCheck:true,callAmount:0,minRaiseTo:1,maxRaiseTo:97.5},pendingPlayerIds:ids,finished:false,showdown:false,awaitingRunout:false,runCount:1,delta:null,history:[]},
    actionSeconds:0,handActionSeconds:0,actionDeadline:null,nextHandAt:null,started:true,seats:ids,reservations:ids.map(()=>null),runoutVote:null,
    chat:[{id:'old',playerId:'p1',name:'Player 2',text:'Old history',ts:1}],canFastForward:false,nextTimeCardAt:Date.now()+300000,revealed:{},isSpectator:false,seatRequests:[],handHistory:[] }
}
try {
  for (const width of process.argv.includes('--compact') ? [320] : [1440,320]) for (const capacity of [2,6,9]) {
    const language = width === 320 ? 'zh' : 'en'
    const context = await browser.newContext({viewport:{width,height:width===320?740:1050}})
    await context.addInitScript(language => { localStorage.setItem('gto.language',language); sessionStorage.setItem('gto.battle.session.v1',JSON.stringify({code:'CHATTEST',playerId:'p0',token:'test-only'})) },language)
    let room = makeRoom(capacity), seq = 0
    const incoming = (playerId,text) => { room = {...room,revision:room.revision+1,chat:[...room.chat,{id:`new${++seq}`,playerId,name:playerId,text,ts:Date.now()}]}; return `new${seq}` }
    await context.route('**/api/rooms/CHATTEST**', async route => {
      if (route.request().method() === 'POST') { const command = route.request().postDataJSON(); if(command.type==='chat') incoming('p0',command.text) }
      await route.fulfill({json:{room}})
    })
    const page = await context.newPage(); page.on('pageerror',e=>errors.push(e.message))
    await page.goto(`${base}/?battle=1`)
    await page.locator('.battle-seat').first().waitFor().catch(async error => { console.error(errors, await page.locator('body').innerText()); throw error })
    await page.waitForTimeout(300)
    assert.equal(await page.locator('.table-chat-bubble').count(),0,'Joining must not replay old chat')
    const id = incoming('p1','好牌！Nice hand 👏 :nice-hand:')
    const bubble = page.locator(`[data-message="${id}"]`)
    await bubble.waitFor({state:'visible'})
    assert.match(await bubble.innerText(),/Nice hand 👏/)
    await bubble.locator('.battle-chat-sticker').waitFor()
    const inside = await bubble.evaluate(el => { const b=el.getBoundingClientRect(),t=el.closest('.battle-table').getBoundingClientRect(); return b.left>=t.left&&b.right<=t.right&&b.top>=t.top&&b.bottom<=t.bottom })
    assert(inside,'Bubble must remain in the table')
    assert(await bubble.evaluate(el => {
      const a=el.getBoundingClientRect()
      return [...el.closest('.battle-table').querySelectorAll('.battle-table-center,.battle-seat-self')].every(node=> {
        const b=node.getBoundingClientRect()
        return Math.min(a.right,b.right)<=Math.max(a.left,b.left)||Math.min(a.bottom,b.bottom)<=Math.max(a.top,b.top)
      })
    }),'Bubble must avoid the board and own cards')
    await page.screenshot({path:`/tmp/gto-table-chat-${width}-${capacity}.png`,fullPage:true})
    const settingName = language==='en'?'Show player chat on the table':'在牌桌上显示玩家聊天'
    const openSettings = async () => page.getByRole('button',{name:language==='en'?'Room settings':'房间设置',exact:true}).click()
    await openSettings()
    const toggle = page.getByRole('switch',{name:settingName,exact:true})
    assert(await toggle.isChecked(),'Setting defaults on')
    await toggle.uncheck()
    assert.equal(await page.locator('.table-chat-bubble').count(),0)
    await page.keyboard.press('Escape')
    await page.reload(); await page.locator('.battle-seat').first().waitFor()
    await openSettings(); assert.equal(await toggle.isChecked(),false,'Setting persists after reload')
    await toggle.check(); await page.keyboard.press('Escape')
    await page.waitForTimeout(900)
    assert.equal(await page.locator('.table-chat-bubble').count(),0,'Re-enabling must not replay historical chat')
    incoming('p0','新消息 New message 😀')
    await page.locator('.table-chat-bubble[data-player="p0"]').waitFor({state:'visible'})
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No horizontal overflow')
    if (width===320&&capacity===9) {
      // Messages actually submitted through the shared rich composer also appear beside the sender.
      await page.getByRole('button',{name:'聊天',exact:false}).click()
      const composer=page.getByRole('textbox',{name:'聊天消息',exact:true})
      await composer.fill('通过输入框发送 👍')
      await composer.press('Enter')
      await page.locator('.table-chat-bubble[data-player="p0"]').filter({hasText:'通过输入框发送 👍'}).waitFor()
      await page.waitForTimeout(7600)
      assert.equal(await page.locator('.table-chat-bubble').count(),0,'Bubbles expire without restarting on polls')
    }
    console.log(`PASS table chat ${capacity} seats / ${width}px: new message, mixed content, bounds, default toggle, persistence, no historical replay`)
    await context.close()
  }
  assert.deepEqual(errors,[])
} finally { await browser.close() }
