import assert from 'node:assert/strict'
import { TableChatTracker, placeChatBubble } from '../src/battle/tableChat'
import { tableChatEnabled, setTableChatEnabled } from '../src/battle/tableChatSettings'
import type { RoomView } from '../src/battle/types'
const room = { instanceId:'r', seats:['a','b'], chat:[{id:'old',playerId:'a',text:'old',ts:1}] } as RoomView
const tracker = new TableChatTracker()
assert.equal(tracker.update(room,true,10).length,0,'Initial history is not replayed')
room.chat.push({id:'new',playerId:'a',text:'你好 😄 :nice:',ts:11})
const first = tracker.update(room,true,20)
assert.equal(first.length,1); assert.equal(first[0].text,'你好 😄 :nice:')
assert.equal(tracker.update(room,true,200).length,1,'Repeated polling retains one bubble')
room.chat.push({id:'other',playerId:'b',text:'Hi',ts:11},{id:'watcher',playerId:'observer',text:'Hi',ts:11})
assert.equal(tracker.update(room,true,300).length,2,'Only seated players get bubbles')
room.chat.push({id:'replacement',playerId:'a',text:'newer',ts:12})
assert.equal(tracker.update(room,true,400).find(m=>m.playerId==='a')!.text,'newer')
assert.equal(tracker.update(room,true,7350).length,1)
assert.equal(tracker.update(room,true,7400).length,0,'Absolute expiry does not extend on polling')
room.chat.push({id:'hidden',playerId:'a',text:'hidden',ts:13})
assert.equal(tracker.update(room,false,8000).length,0)
assert.equal(tracker.update(room,true,8001).length,0,'Enable, tab return and reconnect acknowledge history')
room.chat.push({id:'live',playerId:'a',text:'hello',ts:14})
assert.equal(tracker.update(room,true,8002).length,1)
room.seats[0] = 'c'
assert.equal(tracker.update(room,true,8003).length,0,'A bubble cannot move to a new seat occupant')
assert.equal(tracker.update({...room,instanceId:'other'},true,8004).length,0)
for(const width of [290,700]) {
 const seat={x:width-85,y:40,width:80,height:80}
 const result=placeChatBubble({width,height:450},seat,{width:98,height:65},[seat])
 assert(result.x>=4 && result.x+result.width<=width-4)
 assert(result.y>=4 && result.y+result.height<=446)
 assert(result.x+result.width<=seat.x || result.y+result.height<=seat.y || result.y>=seat.y+seat.height)
}
const data=new Map<string,string>()
Object.assign(globalThis,{localStorage:{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>data.set(key,value)}})
assert.equal(tableChatEnabled(),true)
setTableChatEnabled(false); assert.equal(tableChatEnabled(),false)
setTableChatEnabled(true); assert.equal(tableChatEnabled(),true)
Object.assign(globalThis,{localStorage:{getItem:()=> 'on',setItem:()=>{throw new Error('quota')}}})
setTableChatEnabled(false); assert.equal(tableChatEnabled(),false,'Failed writes still apply to this page')
console.log('Table chat passed: new messages, text/emoji payload, per-player replacement, expiry, no history replay, spectators, seat changes, layout, default-on setting and storage failure.')
