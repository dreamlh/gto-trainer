import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { BattleAudioTracker, battleTurnState } from '../src/battle/audioEvents'
import { battleTensionKey, createTensionMusic } from '../src/battle/tensionMusic'
import { BattleRoom } from '../server/room'
import type { RoomCommand, RoomSession, RoomView } from '../src/battle/types'

// These browser fakes observe public audio behavior; they do not know the melody,
// channel graph, oscillator frequencies, or the engine's internal fields.
const saved = new Map<string, string>()
const browserEvents = new Map<string, (event: { key: string | null; newValue: string | null }) => void>()
let sourceStarts = 0
let immediateStops = 0
const contexts: FakeAudioContext[] = []
const recordings: FakeRecording[] = []

class FakeRecording {
  private source = ''
  get src() { return this.source }
  set src(value: string) { this.source = value; this.currentTime = 0; this.paused = true }
  preload = ''
  loop = false
  paused = true
  currentTime = 0
  starts = 0
  deferPlay = false
  failNextPlay = false
  private pending: (() => void)[] = []
  constructor() { recordings.push(this) }
  play() {
    this.starts++
    if (this.failNextPlay) { this.failNextPlay = false; return Promise.reject(new Error('NotAllowedError')) }
    if (this.deferPlay) return new Promise<void>(resolve => this.pending.push(() => { this.paused = false; resolve() }))
    this.paused = false
    return Promise.resolve()
  }
  pause() { this.paused = true }
  finishPlay() {
    assert.ok(this.pending.length > 0, 'Expected pending music playback')
    this.pending.splice(0).forEach(finish => finish())
  }
}

class FakeParameter {
  value = 0
  setValueAtTime(value: number) { this.value = value }
  linearRampToValueAtTime(value: number) { this.value = value }
  exponentialRampToValueAtTime(value: number) { this.value = value }
  setTargetAtTime(value: number) { this.value = value }
}

class FakeNode {
  gain = new FakeParameter()
  frequency = new FakeParameter()
  type = ''
  buffer: unknown
  onended: (() => void) | null = null
  connect() {}
  disconnect() {}
  start() { sourceStarts++ }
  stop(at?: number) { if (at === undefined) immediateStops++ }
}

class FakeAudioContext {
  state = 'suspended'
  currentTime = 1
  sampleRate = 48_000
  destination = new FakeNode()
  deferResume = false
  private resumes: (() => void)[] = []
  constructor() { contexts.push(this) }
  createGain() { return new FakeNode() }
  createOscillator() { return new FakeNode() }
  createBiquadFilter() { return new FakeNode() }
  createBufferSource() { return new FakeNode() }
  createMediaElementSource() { return new FakeNode() }
  createBuffer(_channels: number, samples: number) { return { getChannelData: () => new Float32Array(samples) } }
  resume() {
    if (this.deferResume) return new Promise<void>(resolve => this.resumes.push(() => { this.state = 'running'; resolve() }))
    this.state = 'running'
    return Promise.resolve()
  }
  suspend() { this.state = 'suspended'; return Promise.resolve() }
  finishResumes() {
    const pending = this.resumes.splice(0)
    assert.ok(pending.length > 0, 'Expected a pending browser resume')
    pending.forEach(finish => finish())
  }
  advance(seconds: number) {
    this.currentTime += seconds
  }
}

Object.assign(globalThis, {
  Audio: FakeRecording,
  localStorage: {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  },
  window: {
    AudioContext: FakeAudioContext,
    addEventListener: (name: string, callback: (event: { key: string | null; newValue: string | null }) => void) => browserEvents.set(name, callback),
  },
})

const audio = await import('../src/battle/audio')
const settlePromises = async () => { for (let i = 0; i < 8; i++) await Promise.resolve() }
let assertions = 0

try {
  audio.setBattleAudioActive(true)
  audio.updateBattleAudioSettings({ music: .3, effects: .7, muted: false })
  audio.setBattleTensionMusic('first-room:1:betting')
  assert.equal(contexts.length, 0, 'Entering a room and changing preferences must not create audio before a gesture')
  assert.equal(recordings.length, 0, 'No soundtrack element or network request exists before a gesture')
  assert.equal(sourceStarts, 0, 'Even an all-in cannot start procedural music before a gesture')
  audio.setBattleTensionMusic(null)
  assertions++

  const persistedKey = [...saved.keys()][0]
  assert.deepEqual(JSON.parse(saved.get(persistedKey)!), { music: .3, effects: .7, muted: false, track: 'jazz-brunch' }, 'Independent channel levels are saved')
  assertions++

  audio.unlockBattleAudio()
  await settlePromises()
  assert.equal(contexts.length, 1)
  const context = contexts[0]
  assert.equal(context.state, 'running', 'The explicit gesture unlock starts the context')
  assert.equal(recordings.length, 1)
  const music = recordings[0]
  assert.equal(music.paused, false, 'Enabled recording plays after the gesture')
  assert.equal(music.src, audio.BATTLE_MUSIC.src)
  assert.equal(music.loop, true, 'The complete recording repeats')
  assert.equal(music.preload, 'none', 'Music does not eagerly download outside playback')
  const asset = await stat(new URL(`../public${audio.BATTLE_MUSIC.src}`, import.meta.url))
  assert.ok(asset.size > 100_000 && asset.size < 25_000_000, 'The bundled recording exists within the host asset size limit')
  assertions++

  audio.updateBattleAudioSettings({ effects: 0 })
  const beforeSilentEffect = sourceStarts
  audio.playBattleSound('win')
  assert.equal(sourceStarts, beforeSilentEffect, 'Effect volume zero suppresses effects while music stays enabled')
  assert.equal(context.state, 'running')
  assert.equal(music.paused, false)
  assertions++

  audio.updateBattleAudioSettings({ music: 0, effects: .7 })
  const beforeSilentMusic = sourceStarts
  context.advance(10)
  assert.equal(sourceStarts, beforeSilentMusic, 'Music volume zero schedules no music sources')
  assert.equal(music.paused, true, 'Music is paused instead of streaming silently at volume zero')
  audio.playBattleSound('check')
  assert.ok(sourceStarts > beforeSilentMusic, 'Effects remain available when music is silent')
  assertions++

  const afterCheck = sourceStarts
  audio.playBattleSound('call')
  assert.equal(sourceStarts, afterCheck, 'Rapid ordinary effects do not overlap into a burst')
  context.advance(.25)
  audio.playBattleSound('call')
  assert.ok(sourceStarts > afterCheck, 'An ordinarily spaced action still plays')
  assertions++

  audio.updateBattleAudioSettings({ muted: true })
  const mutedCount = sourceStarts
  audio.playBattleSound('allin')
  audio.playBattleSound('win')
  assert.equal(sourceStarts, mutedCount, 'Master mute also suppresses priority effects')
  assert.equal(context.state, 'suspended')
  assert.equal(music.paused, true)
  assert.ok(immediateStops > 0, 'Active sources are cancelled, not left to replay on return')
  assert.deepEqual(JSON.parse(saved.get(persistedKey)!), { music: 0, effects: .7, muted: true, track: 'jazz-brunch' }, 'Mute preserves the independent channel levels')
  assertions++

  audio.updateBattleAudioSettings({ muted: false, music: .3 })
  await settlePromises()
  assert.equal(context.state, 'running')
  music.currentTime = 42
  audio.setBattleAudioActive(false) // Same public path used by document visibility and app teardown.
  assert.equal(music.currentTime, 42, 'Backgrounding the app retains the current position instead of replaying the intro')
  assert.equal(context.state, 'suspended', 'Backgrounding the app suspends audio')
  assert.equal(music.paused, true)
  const inactiveCount = sourceStarts
  audio.playBattleSound('allin')
  assert.equal(sourceStarts, inactiveCount)
  assertions++

  context.deferResume = true
  audio.setBattleAudioActive(true)
  audio.updateBattleAudioSettings({ muted: true })
  const beforeLateResume = sourceStarts
  context.finishResumes()
  await settlePromises()
  assert.equal(context.state, 'suspended', 'A delayed browser resume cannot override a newer mute')
  assert.equal(sourceStarts, beforeLateResume)
  assert.equal(music.paused, true)
  assertions++

  audio.updateBattleAudioSettings({ muted: false })
  audio.setBattleAudioActive(false)
  context.finishResumes()
  await settlePromises()
  assert.equal(context.state, 'suspended', 'A delayed resume cannot override backgrounding the app')
  assert.equal(music.paused, true)
  assertions++

  audio.setBattleAudioActive(true)
  audio.updateBattleAudioSettings({ music: 0, effects: 0 })
  context.finishResumes()
  await settlePromises()
  assert.equal(context.state, 'suspended', 'Zeroing both channels during resume keeps audio stopped')
  assert.equal(music.paused, true)
  assertions++

  audio.setBattleAudioActive(false)
  context.deferResume = false
  audio.updateBattleAudioSettings({ music: .3, effects: .7, muted: false })
  music.deferPlay = true
  audio.setBattleAudioActive(true)
  await settlePromises()
  audio.updateBattleAudioSettings({ muted: true })
  music.finishPlay()
  await settlePromises()
  assert.equal(music.paused, true, 'A late media play promise cannot override mute')
  assertions++

  audio.updateBattleAudioSettings({ muted: false })
  await settlePromises()
  audio.setBattleAudioActive(false)
  music.finishPlay()
  await settlePromises()
  assert.equal(music.paused, true, 'A late media play promise cannot override backgrounding the app')
  assertions++

  music.deferPlay = false
  music.failNextPlay = true
  audio.setBattleAudioActive(true)
  await settlePromises()
  assert.equal(music.paused, true)
  const rejectedStarts = music.starts
  audio.unlockBattleAudio()
  await settlePromises()
  assert.ok(music.starts > rejectedStarts, 'The next gesture retries blocked media playback')
  assert.equal(music.paused, false)
  assert.equal(music.currentTime, 42, 'Resume does not rewind the full soundtrack')
  assertions++

  audio.setBattleAudioActive(false)
  let notifications = 0
  const unsubscribe = audio.subscribeBattleAudioSettings(() => notifications++)
  browserEvents.get('storage')!({ key: persistedKey, newValue: '{"muted":true,"music":0.25,"effects":0.6}' })
  assert.deepEqual(audio.getBattleAudioSettings(), { muted: true, music: .25, effects: .6, track: 'jazz-brunch' })
  assert.equal(notifications, 1, 'Other tabs update the settings controls')
  unsubscribe()
  assertions++

  audio.updateBattleAudioSettings({ music: 2, effects: -1 })
  assert.deepEqual(audio.getBattleAudioSettings(), { muted: true, music: 1, effects: 0, track: 'jazz-brunch' }, 'Volume inputs remain within their valid range')
  assertions++

  // App-shell listeners live across routes. Only document visibility suspends music.
  const surface = {
    hidden: false,
    listeners: new Map<string, Set<() => void>>(),
    addEventListener(name: string, callback: () => void) {
      const group = this.listeners.get(name) ?? new Set<() => void>()
      group.add(callback); this.listeners.set(name, group)
    },
    removeEventListener(name: string, callback: () => void) { this.listeners.get(name)?.delete(callback) },
    emit(name: string) { this.listeners.get(name)?.forEach(callback => callback()) },
  }
  audio.updateBattleAudioSettings({ muted: false, music: .3, effects: .7 })
  const detach = audio.attachGlobalAudioLifecycle(surface as unknown as Document)
  await settlePromises()
  assert.equal(music.paused, false, 'Music plays without requiring a battle room')
  assert.equal(contexts.length, 1)
  assert.equal(recordings.length, 1)
  const musicStartsBeforeNavigation = music.starts
  for (const page of ['trainer', 'battle', 'solver', 'ranges', 'equity', 'stats']) {
    surface.emit('pointerdown') // Navigation clicks are gestures, not playback restarts.
    await settlePromises()
    assert.equal(music.paused, false, `Music stays active on ${page}`)
  }
  assert.equal(music.starts, musicStartsBeforeNavigation, 'Route gestures do not restart the recording')
  assert.equal(contexts.length, 1, 'All routes share the same audio context')
  assertions++

  surface.hidden = true; surface.emit('visibilitychange')
  assert.equal(music.paused, true)
  assert.equal(context.state, 'suspended')
  surface.emit('pointerdown')
  await settlePromises()
  assert.equal(music.paused, true, 'Hidden-document gestures never resume audio')
  surface.hidden = false; surface.emit('visibilitychange')
  await settlePromises()
  assert.equal(music.paused, false)
  assert.equal(music.currentTime, 42)
  detach()
  assert.equal(music.paused, true)
  assert.ok([...surface.listeners.values()].every(group => group.size === 0), 'App cleanup removes its global listeners')
  assertions++

  // Only fields observed by the tracker are required in these server-view fixtures.
  const room = {
    instanceId: 'audio-room', selfId: 'hero', actionDeadline: 50000, runoutPlayback: null, isSpectator: false,
    hand: { number: 1, history: [], finished: false, toAct: 'other', players: [], board: [], runResults: [], delta: null, legal: { canFold: true, canCheck: false, callAmount: 2, minRaiseTo: 4, maxRaiseTo: 100 } },
  } as unknown as RoomView
  const tracker = new BattleAudioTracker()
  assert.equal(tracker.observe(room), null, 'Opening or rejoining a room never replays its past effects')
  room.hand!.history.push({ playerId: 'other', street: 'preflop', kind: 'raise', amount: 3 })
  assert.equal(tracker.observe(room)?.sound, 'raise', 'A live room action sounds even while another app page is open')
  for (const page of ['trainer', 'battle', 'solver', 'stats']) {
    assert.equal(tracker.observe(room), null, `Opening ${page} cannot duplicate the last room sound`)
  }
  room.hand!.toAct = 'hero'
  assert.equal(tracker.observe(room)?.sound, 'turn')
  assert.equal(tracker.observe(room), null, 'Repeated polls do not repeat the turn prompt')
  assert.deepEqual(battleTurnState(room), { deadline: 50000 }, 'The global notice uses the server action deadline')
  const ownLegal = room.hand!.legal
  room.hand!.legal = null
  assert.equal(battleTurnState(room), null, 'Recovered nicknames cannot receive a turn notice without current-hand action rights')
  room.hand!.legal = ownLegal; room.isSpectator = true
  assert.equal(battleTurnState(room), null, 'Spectators and late entrants do not receive a turn notice even if toAct still matches')
  room.isSpectator = false
  room.hand!.toAct = 'other'
  assert.equal(battleTurnState(room), null, 'The global notice clears when another player acts')
  tracker.observe(room)
  room.hand!.toAct = 'hero'
  assert.equal(tracker.observe(room)?.sound, 'turn', 'A later genuine turn gets a new prompt')
  assertions++

  room.hand!.history.push({ playerId: 'hero', street: 'preflop', kind: 'call', amount: 3 })
  room.hand!.toAct = 'other'
  assert.equal(tracker.observe(room, false), null, 'Browser-hidden events are consumed silently')
  room.hand!.toAct = 'hero'
  assert.equal(tracker.observe(room, true), null, 'Returning from browser background does not replay accumulated events')
  assert.deepEqual(battleTurnState(room), { deadline: 50000 }, 'The current turn still has a visible return-to-table notice')
  room.hand!.toAct = 'other'; tracker.observe(room)
  room.hand!.toAct = 'hero'
  assert.equal(tracker.observe(room)?.sound, 'turn')
  room.actionSeconds = 0; room.actionDeadline = null
  assert.deepEqual(battleTurnState(room), { deadline: null }, 'Unlimited turns retain a return-to-table notice without a countdown')
  room.hand!.toAct = 'other'; tracker.observe(room)
  assert.equal(battleTurnState(room), null, 'Unlimited turn notice clears for another actor')
  room.hand!.toAct = 'hero'
  assert.equal(tracker.observe(room)?.sound, 'turn', 'Unlimited turns still emit the normal turn sound')
  room.hand!.legal = null
  assert.equal(battleTurnState(room), null, 'Unlimited time does not bypass action eligibility')
  room.hand!.legal = ownLegal
  room.hand!.finished = true
  assert.equal(battleTurnState(room), null)
  tracker.observe(null)
  assert.equal(tracker.observe(room), null, 'Leaving and rejoining resets event continuity')
  assertions++

  const runoutTracker = new BattleAudioTracker()
  const pendingRoom = structuredClone(room), pendingAudio = new BattleAudioTracker()
  pendingRoom.hand!.finished = false; pendingRoom.hand!.toAct = null
  pendingAudio.observe(pendingRoom)
  pendingRoom.hand!.finished = true; pendingRoom.settlementAt = 2000
  assert.equal(pendingAudio.observe(pendingRoom), null, 'No result sound during the two-second reveal window')
  pendingRoom.settlementAt = null; pendingRoom.hand!.delta = { hero: 2 }
  assert.equal(pendingAudio.observe(pendingRoom)?.sound, 'win', 'Win sound starts only when the award is settled')
  assert.equal(pendingAudio.observe(pendingRoom), null, 'Polling the settlement cannot repeat the sound')
  assertions++

  room.hand!.finished = false; room.hand!.toAct = null; room.hand!.board = [0, 5, 10]
  room.runoutPlayback = { boardIndex: 0, revealedCount: 3, phase: 'dealing', completedResults: [], nextRevealAt: 100 }
  assert.equal(runoutTracker.observe(room), null)
  room.hand!.board.push(15); room.runoutPlayback.revealedCount = 4
  assert.equal(runoutTracker.observe(room)?.sound, 'deal')
  room.hand!.board.push(20); room.runoutPlayback.revealedCount = 5; room.runoutPlayback.phase = 'result'
  room.runoutPlayback.completedResults.push({ run: 1, board: [...room.hand!.board], winners: ['hero'], payouts: { hero: 50 } })
  assert.equal(runoutTracker.observe(room)?.sound, 'win')
  room.runoutPlayback.boardIndex = 1; room.runoutPlayback.revealedCount = 3; room.runoutPlayback.phase = 'dealing'; room.hand!.board = [0, 5, 10]
  assert.equal(runoutTracker.observe(room), null, 'Another run sharing the flop does not replay its cards')
  room.hand!.board.push(25); room.runoutPlayback.revealedCount = 4
  assert.equal(runoutTracker.observe(room)?.sound, 'deal')
  room.hand!.board.push(30); room.runoutPlayback.revealedCount = 5; room.runoutPlayback.phase = 'result'
  room.runoutPlayback.completedResults.push({ run: 2, board: [...room.hand!.board], winners: ['other'], payouts: { other: 50 } })
  assert.equal(runoutTracker.observe(room)?.sound, 'result')
  room.hand!.runResults = [...room.runoutPlayback.completedResults]; room.runoutPlayback = null; room.hand!.finished = true
  assert.equal(runoutTracker.observe(room), null, 'Final settlement does not duplicate the last run sound')
  assertions++

  for (const track of audio.BATTLE_MUSIC_TRACKS) {
    const file = await stat(new URL(`../public${track.src}`, import.meta.url))
    assert.ok(file.size > 100_000 && file.size < 25_000_000)
    assert.equal(track.license, 'https://creativecommons.org/licenses/by/4.0/')
  }
  audio.setBattleAudioActive(true)
  audio.updateBattleAudioSettings({ muted: false, music: .3, effects: .7, track: 'jazz-brunch' })
  await settlePromises()
  music.currentTime = 90
  audio.updateBattleAudioSettings({ track: 'cool-vibes' })
  await settlePromises()
  assert.equal(music.src, '/audio/cool-vibes.m4a')
  assert.equal(music.currentTime, 0, 'A new track begins from its own start')
  assert.equal(music.paused, false)
  assert.equal(recordings.length, 1, 'Switching reuses the only media element so songs cannot overlap')
  assert.equal(JSON.parse(saved.get(persistedKey)!).track, 'cool-vibes', 'The selected track is saved')
  assertions++

  audio.updateBattleAudioSettings({ muted: true, track: 'night-on-the-docks' })
  audio.unlockBattleAudio()
  await settlePromises()
  assert.equal(music.src, '/audio/night-on-the-docks.m4a')
  assert.equal(music.paused, true, 'Selecting a track respects master mute')
  audio.updateBattleAudioSettings({ muted: false, music: 0, track: 'jazz-brunch' })
  audio.unlockBattleAudio()
  await settlePromises()
  assert.equal(music.paused, true, 'Selecting a track respects zero music volume')
  assertions++

  browserEvents.get('storage')!({ key: persistedKey, newValue: '{"muted":false,"music":0.3,"effects":0.7,"track":"cool-vibes"}' })
  await settlePromises()
  assert.equal(audio.getBattleAudioSettings().track, 'cool-vibes')
  assert.equal(music.src, '/audio/cool-vibes.m4a', 'Track changes synchronize to other tabs')
  assert.equal(music.paused, false)
  browserEvents.get('storage')!({ key: persistedKey, newValue: '{"muted":false,"music":0.3,"effects":0.7,"track":"unknown"}' })
  await settlePromises()
  assert.equal(audio.getBattleAudioSettings().track, 'jazz-brunch', 'Old or invalid stored tracks fall back to the default')
  assertions++

  music.deferPlay = true
  audio.updateBattleAudioSettings({ track: 'cool-vibes' })
  audio.updateBattleAudioSettings({ track: 'night-on-the-docks' })
  audio.updateBattleAudioSettings({ muted: true })
  music.finishPlay()
  await settlePromises()
  assert.equal(music.src, '/audio/night-on-the-docks.m4a', 'Late play promises cannot restore an old track')
  assert.equal(music.paused, true, 'Late promises from either track still honor the latest mute')
  music.deferPlay = false
  audio.updateBattleAudioSettings({ muted: false })
  await settlePromises()
  assert.equal(music.paused, false, 'The selected song resumes normally after a switch-and-mute race')
  assertions++

  music.currentTime = 37
  const beforeTension = sourceStarts
  audio.setBattleTensionMusic('tension-room:1:betting')
  assert.equal(music.paused, true, 'All-in tension replaces rather than overlaps the lounge recording')
  assert.equal(sourceStarts, beforeTension + 1)
  audio.setBattleTensionMusic('tension-room:1:betting')
  audio.unlockBattleAudio()
  await settlePromises()
  assert.equal(sourceStarts, beforeTension + 1, 'Polling and repeated gestures cannot stack tension loops')
  const beforeNewHand = immediateStops
  audio.setBattleTensionMusic('tension-room:2:betting')
  assert.equal(immediateStops, beforeNewHand + 1, 'A new hand cancels the old loop first')
  assert.equal(sourceStarts, beforeTension + 2)
  audio.setBattleTensionMusic(null)
  await settlePromises()
  assert.equal(music.paused, false)
  assert.equal(music.currentTime, 37, 'The selected recording resumes from its previous position')
  assertions++

  audio.setBattleTensionMusic('tension-room:3:betting')
  let stopsBefore = immediateStops
  audio.updateBattleAudioSettings({ music: 0 })
  assert.equal(immediateStops, stopsBefore + 1, 'Music volume zero cancels tension while effects can remain enabled')
  const atZero = sourceStarts
  audio.setBattleTensionMusic('tension-room:4:betting')
  assert.equal(sourceStarts, atZero)
  audio.updateBattleAudioSettings({ music: .3, effects: 0 })
  await settlePromises()
  assert.equal(sourceStarts, atZero + 1, 'The music channel alone controls the tension loop')
  stopsBefore = immediateStops
  audio.updateBattleAudioSettings({ muted: true })
  assert.equal(immediateStops, stopsBefore + 1, 'Master mute cancels the loop immediately')
  assert.equal(context.state, 'suspended')
  audio.setBattleTensionMusic(null)
  audio.updateBattleAudioSettings({ muted: false, effects: .7 })
  await settlePromises()
  assert.equal(music.paused, false)
  assertions++

  audio.setBattleTensionMusic('tension-room:5:run-0')
  stopsBefore = immediateStops
  audio.setBattleAudioActive(false)
  assert.equal(immediateStops, stopsBefore + 1, 'Document backgrounding cancels active tension')
  const whileHidden = sourceStarts
  audio.setBattleTensionMusic(null)
  audio.setBattleAudioActive(true)
  await settlePromises()
  assert.equal(sourceStarts, whileHidden, 'A finished background hand never replays its old tension on return')
  assert.equal(music.paused, false)
  assertions++

  music.deferPlay = true
  audio.updateBattleAudioSettings({ track: 'cool-vibes' })
  audio.setBattleTensionMusic('tension-room:6:betting')
  music.finishPlay()
  await settlePromises()
  assert.equal(music.paused, true, 'A late recording play promise cannot overlap an active tension loop')
  music.deferPlay = false
  audio.setBattleTensionMusic(null)
  await settlePromises()
  assert.equal(music.paused, false, 'Leaving the phase releases the recording after a delayed play race')
  assertions++

  const tensionRoom = structuredClone(room)
  tensionRoom.hand!.finished = false; tensionRoom.runoutPlayback = null; tensionRoom.settlementAt = null
  tensionRoom.hand!.players = [{ id: 'other', allin: true, folded: false }] as NonNullable<RoomView['hand']>['players']
  const handKey = `${tensionRoom.instanceId}:${tensionRoom.hand!.number}`
  assert.equal(battleTensionKey(tensionRoom), handKey, 'Another player all-in is enough; the viewer need not be all-in')
  audio.setBattleTensionMusic(battleTensionKey(tensionRoom))
  const continuousStarts = sourceStarts, continuousStops = immediateStops
  tensionRoom.runoutVote = { handNumber: 1, eligibleIds: [], votes: {}, deadline: 100 }
  assert.equal(battleTensionKey(tensionRoom), handKey, 'The pending runout choice retains the same cue')
  tensionRoom.runoutVote = null
  for (let boardIndex = 0; boardIndex < 3; boardIndex++) {
    for (const phase of ['dealing', 'settling', 'result'] as const) {
      tensionRoom.runoutPlayback = { boardIndex, revealedCount: phase === 'dealing' ? 3 : 5, phase, completedResults: [], nextRevealAt: 100 }
      tensionRoom.settlementAt = phase === 'settling' ? 100 : null
      assert.equal(battleTensionKey(tensionRoom), handKey, `Run ${boardIndex + 1} ${phase} keeps the same hand cue`)
      audio.setBattleTensionMusic(battleTensionKey(tensionRoom))
      assert.equal(sourceStarts, continuousStarts, 'A run change or intermediate result never restarts the score')
      assert.equal(immediateStops, continuousStops, 'No intermediate pause stops the score')
      assert.equal(music.paused, true, 'The lounge recording remains paused across all run phases')
    }
  }
  tensionRoom.runoutPlayback = null; tensionRoom.settlementAt = 100
  tensionRoom.hand!.finished = true; tensionRoom.hand!.delta = null
  assert.equal(battleTensionKey(tensionRoom), handKey, 'finished=true still retains tension throughout the final two-second settlement')
  audio.setBattleTensionMusic(battleTensionKey(tensionRoom))
  assert.equal(sourceStarts, continuousStarts)
  assert.equal(immediateStops, continuousStops)
  tensionRoom.settlementAt = null; tensionRoom.hand!.delta = { hero: 10 }
  tensionRoom.nextHandAt = Date.now() + 3000
  assert.equal(battleTensionKey(tensionRoom), handKey, 'The final result and next-hand countdown keep the all-in score')
  audio.setBattleTensionMusic(battleTensionKey(tensionRoom))
  assert.equal(sourceStarts, continuousStarts)
  assert.equal(immediateStops, continuousStops)
  tensionRoom.nextHandAt = null
  assert.equal(battleTensionKey(tensionRoom), null, 'The score stops if no next hand is scheduled')
  audio.setBattleTensionMusic(battleTensionKey(tensionRoom))
  await settlePromises()
  assert.equal(immediateStops, continuousStops + 1)
  assert.equal(music.paused, false)
  // Single-run/all-folded endings use the same final-settlement contract.
  tensionRoom.hand!.finished = false; tensionRoom.hand!.delta = null
  assert.equal(battleTensionKey(tensionRoom), handKey)
  tensionRoom.hand!.finished = true; tensionRoom.settlementAt = Date.now() - 1000
  assert.equal(battleTensionKey(tensionRoom), handKey, 'A locally expired settlement timestamp cannot stop music before the server publishes payout')
  tensionRoom.settlementAt = null
  assert.equal(battleTensionKey(tensionRoom), null)
  tensionRoom.hand!.finished = false; tensionRoom.hand!.number++
  assert.notEqual(battleTensionKey(tensionRoom), handKey, 'A new hand receives its own cue ownership')
  const nextKey = battleTensionKey(tensionRoom)
  tensionRoom.instanceId = 'another-room'
  assert.notEqual(battleTensionKey(tensionRoom), nextKey, 'Room changes cannot inherit an old hand cue')
  tensionRoom.hand!.finished = false; tensionRoom.hand!.players[0].folded = true
  tensionRoom.hand!.history = []; tensionRoom.hand!.awaitingRunout = false
  assert.equal(battleTensionKey(tensionRoom), null)
  assert.equal(battleTensionKey(null), null)
  assertions++

  let generatedChannels: Float32Array[] = []
  createTensionMusic({ sampleRate: 24_000, createBuffer: (channels, size) => {
    generatedChannels = Array.from({ length: channels }, () => new Float32Array(size))
    return { getChannelData: (channel: number) => generatedChannels[channel] } as unknown as AudioBuffer
  } })
  assert.equal(generatedChannels.length, 2, 'The original battle score has a stereo soundstage')
  for (const generatedSamples of generatedChannels) {
    assert.ok(generatedSamples.length >= 24_000 * 12, 'The phrase develops over multiple bars instead of a short pulse')
    assert.ok(generatedSamples.every(value => Number.isFinite(value) && Math.abs(value) <= .761), 'The generated score leaves headroom and never clips')
    const rms = Math.sqrt(generatedSamples.reduce((sum, value) => sum + value * value, 0) / generatedSamples.length)
    assert.ok(rms > .04 && rms < .25, `The score maintains a controlled average level (${rms.toFixed(3)})`)
    assert.ok(Math.abs(generatedSamples[0] - generatedSamples[generatedSamples.length - 1]) < .01, 'The loop edge remains quiet and continuous')
  }
  assert.ok(generatedChannels[0].some((sample, index) => Math.abs(sample - generatedChannels[1][index]) > .01), 'The stereo parts retain spatial separation')
  assertions++

  // Use real server responses: refunds and staging change allin flags independently
  // of the public action history and final-result publication.
  const realNow = Date.now
  let serverNow = realNow()
  Date.now = () => serverNow
  try {
    const createServer = async () => {
      const values = new Map<string, unknown>()
      let queue: Promise<unknown> = Promise.resolve()
      const ctx = {
        storage: {
          get: async (key: string) => structuredClone(values.get(key)),
          put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)) },
          setAlarm: async () => {}, deleteAlarm: async () => {}, deleteAll: async () => { values.clear() },
        },
        blockConcurrencyWhile<T>(callback: () => Promise<T>): Promise<T> {
          const next = queue.then(callback); queue = next.catch(() => {}); return next
        },
      }
      const server = new BattleRoom(ctx as never)
      const request = async (operation: string, session?: RoomSession, body?: object) => {
        const response = await server.fetch(new Request(`https://audio-room.internal/AUDIO999/${operation}`, {
          method: body ? 'POST' : 'GET',
          headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(session ? { Authorization: `Bearer ${session.token}` } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        }))
        const payload = await response.json() as { room: RoomView; session: RoomSession; error?: string }
        assert.equal(response.status, 200, `${operation}: ${payload.error ?? response.status}`)
        return payload
      }
      const host = (await request('create', undefined, { name: 'Audio host', capacity: 2, initialStack: 100, actionSeconds: 0 })).session
      await request('command', host, { type: 'settings', initialStack: 50, actionSeconds: 0 })
      const guest = (await request('join', undefined, { name: 'Audio guest' })).session
      await request('command', guest, { type: 'sit', seat: 1 })
      const initial = (await request('command', host, { type: 'start' })).room
      const command = async (session: RoomSession, body: RoomCommand) => (await request('command', session, body)).room
      const view = async () => (await request('view', host)).room
      const act = (session: RoomSession, current: RoomView, kind: 'fold' | 'call' | 'raise') => command(session, {
        type: 'action', handNumber: current.hand!.number, revision: current.actionRevision,
        action: kind === 'raise' ? { kind, to: 100 } : { kind },
      })
      return { host, guest, initial, command, view, act }
    }
    const refunded = await createServer()
    let snapshot = await refunded.act(refunded.host, refunded.initial, 'raise')
    const refundKey = battleTensionKey(snapshot)
    assert.ok(refundKey)
    audio.setBattleTensionMusic(refundKey)
    const refundStarts = sourceStarts, refundStops = immediateStops
    snapshot = await refunded.act(refunded.guest, snapshot, 'fold')
    assert.equal(snapshot.hand!.finished, true)
    assert.equal(snapshot.hand!.delta, null)
    assert.ok(snapshot.settlementAt)
    assert.ok(snapshot.hand!.history.some(action => action.kind === 'refund'))
    assert.ok(snapshot.hand!.players.every(player => !player.allin && player.stack > 0), 'The real server clears every live all-in flag after returning the uncalled shove')
    assert.equal(battleTensionKey(snapshot), refundKey, 'Public all-in history preserves music through the actual refund settlement pause')
    audio.setBattleTensionMusic(battleTensionKey(snapshot))
    assert.equal(sourceStarts, refundStarts); assert.equal(immediateStops, refundStops)
    serverNow = snapshot.settlementAt!
    snapshot = await refunded.view()
    assert.ok(snapshot.hand!.delta)
    assert.ok(snapshot.nextHandAt)
    assert.equal(battleTensionKey(snapshot), refundKey, 'Real settled result and next-hand countdown retain the same score')
    audio.setBattleTensionMusic(battleTensionKey(snapshot))
    assert.equal(sourceStarts, refundStarts); assert.equal(immediateStops, refundStops)
    serverNow = snapshot.nextHandAt!
    snapshot = await refunded.view()
    assert.equal(snapshot.hand!.number, 2)
    assert.equal(battleTensionKey(snapshot), null, 'The next deal releases the previous hand score')
    audio.setBattleTensionMusic(battleTensionKey(snapshot))
    await settlePromises()
    assert.equal(immediateStops, refundStops + 1)
    assert.equal(music.paused, false)
    assertions++

    const multiple = await createServer()
    snapshot = await multiple.act(multiple.host, multiple.initial, 'raise')
    const runKey = battleTensionKey(snapshot)
    audio.setBattleTensionMusic(runKey)
    const runStarts = sourceStarts, runStops = immediateStops
    snapshot = await multiple.act(multiple.guest, snapshot, 'call')
    assert.ok(snapshot.runoutVote)
    assert.equal(battleTensionKey(snapshot), runKey)
    await multiple.command(multiple.host, { type: 'runouts', handNumber: snapshot.hand!.number, count: 3 })
    snapshot = await multiple.command(multiple.guest, { type: 'runouts', handNumber: snapshot.hand!.number, count: 3 })
    assert.equal(snapshot.hand!.players.find(player => player.id === multiple.host.playerId)!.allin, false, 'The real playback snapshot refunds the larger stack before revealing cards')
    const phases = new Set<string>()
    let steps = 0
    while (snapshot.runoutPlayback && steps++ < 30) {
      phases.add(`${snapshot.runoutPlayback.boardIndex}:${snapshot.runoutPlayback.phase}`)
      assert.equal(battleTensionKey(snapshot), runKey)
      audio.setBattleTensionMusic(battleTensionKey(snapshot))
      assert.equal(sourceStarts, runStarts, 'Real runout snapshots retain one continuously playing source')
      assert.equal(immediateStops, runStops)
      serverNow = snapshot.runoutPlayback.nextRevealAt
      snapshot = await multiple.view()
    }
    assert.equal(phases.size, 9, 'All three real dealing/settling/result phase sequences were checked')
    assert.equal(snapshot.hand!.finished, true)
    assert.equal(snapshot.settlementAt, null)
    assert.ok(snapshot.hand!.delta)
    assert.equal(battleTensionKey(snapshot), snapshot.nextHandAt == null ? null : runKey)
    snapshot.nextHandAt = null // A table without a follow-on hand releases the score at final payout.
    assert.equal(battleTensionKey(snapshot), null)
    audio.setBattleTensionMusic(battleTensionKey(snapshot))
    await settlePromises()
    assert.equal(immediateStops, runStops + 1, 'Only the final real payout stops the cue')
    assert.equal(music.paused, false)
    assertions++
  } finally { Date.now = realNow }

  {
    const starts = sourceStarts
    audio.setBattleTensionMusic('trainer:1', 'trainer')
    assert.equal(sourceStarts, starts + 1)
    audio.setBattleTensionMusic(null)
    assert.equal(sourceStarts, starts + 1, 'Clearing an absent room cannot stop the trainer cue')
    audio.setBattleTensionMusic('battle:1')
    assert.equal(sourceStarts, starts + 2)
    const stops = immediateStops
    audio.setBattleTensionMusic(null, 'trainer')
    assert.equal(immediateStops, stops, 'Trainer cleanup cannot stop a live multiplayer cue')
    audio.setBattleTensionMusic(null)
    assert.equal(immediateStops, stops + 1)
    assertions++
  }

  console.log(`Battle audio: ${assertions} lifecycle groups passed (gesture unlock, independent channels, mute, delayed playback races, app visibility, local tracks, all-in loop ownership, phase cleanup and generated score).`)
} finally {
  audio.setBattleTensionMusic(null)
  audio.setBattleAudioActive(false)
}
