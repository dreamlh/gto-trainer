import { createTensionMusic } from './tensionMusic'

/** Locally bundled lounge recording, with synthesized table effects. Music credits: public/audio/README.md. */
export interface BattleAudioSettingsValue { muted: boolean; music: number; effects: number; track: BattleMusicId }
export type BattleSound = 'deal' | 'check' | 'fold' | 'call' | 'raise' | 'allin' | 'win' | 'result' | 'turn'

const MUSIC_LICENSE = 'https://creativecommons.org/licenses/by/4.0/'
export const BATTLE_MUSIC_TRACKS = [
  {
    id: 'jazz-brunch', title: 'Jazz Brunch', artist: 'Kevin MacLeod',
    src: '/audio/jazz-brunch.m4a', source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1700074',
    license: MUSIC_LICENSE, zh: '轻爵士', en: 'Light jazz', duration: '5:23', gain: 0.72,
  },
  {
    id: 'cool-vibes', title: 'Cool Vibes', artist: 'Kevin MacLeod',
    src: '/audio/cool-vibes.m4a', source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100863',
    license: MUSIC_LICENSE, zh: '慢拍爵士', en: 'Slow jazz', duration: '3:38', gain: 2.45,
  },
  {
    id: 'night-on-the-docks', title: 'Night on the Docks - Piano', artist: 'Kevin MacLeod',
    src: '/audio/night-on-the-docks.m4a', source: 'https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100135',
    license: MUSIC_LICENSE, zh: '夜色电钢琴', en: 'Late-night piano', duration: '2:54', gain: 2.05,
  },
] as const
export type BattleMusicId = typeof BATTLE_MUSIC_TRACKS[number]['id']
export const BATTLE_MUSIC = BATTLE_MUSIC_TRACKS[0]
export function getBattleMusicTrack(id: BattleMusicId) { return BATTLE_MUSIC_TRACKS.find(track => track.id === id) ?? BATTLE_MUSIC }
const validTrack = (value: unknown, fallback: BattleMusicId = BATTLE_MUSIC.id): BattleMusicId =>
  BATTLE_MUSIC_TRACKS.find(track => track.id === value)?.id ?? fallback

const STORAGE_KEY = 'gto.battle.audio.v1'
const DEFAULTS: BattleAudioSettingsValue = { muted: false, music: 0.18, effects: 0.45, track: BATTLE_MUSIC.id }
const listeners = new Set<() => void>()
let settings: BattleAudioSettingsValue | null = null
let engine: TableAudio | null = null
const clamp = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback

function readSettings(raw: string | null): BattleAudioSettingsValue {
  try {
    const value = raw ? JSON.parse(raw) : null
    return { muted: typeof value?.muted === 'boolean' ? value.muted : DEFAULTS.muted, music: clamp(value?.music, DEFAULTS.music), effects: clamp(value?.effects, DEFAULTS.effects), track: validTrack(value?.track) }
  } catch { return { ...DEFAULTS } }
}

export function getBattleAudioSettings(): BattleAudioSettingsValue {
  if (!settings) {
    try { settings = readSettings(localStorage.getItem(STORAGE_KEY)) } catch { settings = { ...DEFAULTS } }
  }
  return settings
}

export function subscribeBattleAudioSettings(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function updateBattleAudioSettings(patch: Partial<BattleAudioSettingsValue>): void {
  const previous = getBattleAudioSettings()
  settings = {
    muted: typeof patch.muted === 'boolean' ? patch.muted : previous.muted,
    music: clamp(patch.music, previous.music),
    effects: clamp(patch.effects, previous.effects),
    track: validTrack(patch.track, previous.track),
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(settings)) } catch { /* Audio preferences still work for this visit. */ }
  engine?.sync()
  listeners.forEach(listener => listener())
}

if (typeof window !== 'undefined') window.addEventListener('storage', event => {
  if (event.key !== STORAGE_KEY && event.key !== null) return
  settings = readSettings(event.key === null ? null : event.newValue)
  engine?.sync()
  listeners.forEach(listener => listener())
})

class TableAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private music: GainNode | null = null
  private effects: GainNode | null = null
  private tension: GainNode | null = null
  private tensionKey: string | null = null
  private tensionBuffer: AudioBuffer | null = null
  private tensionSource: AudioBufferSourceNode | null = null
  private recording: HTMLAudioElement | null = null
  private recordingStartPending: number | null = null
  private recordingGeneration = 0
  private recordingTrack: BattleMusicId | null = null
  private active = false
  private lastEffectAt = -Infinity
  private noiseBuffer: AudioBuffer | null = null
  private disposed = false
  private voices = new Set<AudioScheduledSourceNode>()

  async unlock(): Promise<void> {
    if (this.disposed) return
    try {
      if (!this.context) {
        const AudioConstructor = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        if (!AudioConstructor) { this.disposed = true; return }
        this.context = new AudioConstructor()
        this.master = this.context.createGain()
        this.master.gain.value = 0
        this.music = this.context.createGain()
        this.effects = this.context.createGain()
        this.tension = this.context.createGain()
        this.music.connect(this.master)
        this.effects.connect(this.master)
        this.tension.connect(this.master)
        this.master.connect(this.context.destination)
        // A full recording is streamed from our own static assets. Do not fetch it
        // until the user has interacted and enabled music; effects remain immediate.
        this.recording = new Audio()
        this.recording.preload = 'none'
        this.recording.loop = true
        this.recordingTrack = getBattleAudioSettings().track
        this.recording.src = getBattleMusicTrack(this.recordingTrack).src
        this.context.createMediaElementSource(this.recording).connect(this.music)
        const samples = this.context.sampleRate * 0.15
        this.noiseBuffer = this.context.createBuffer(1, samples, this.context.sampleRate)
        const data = this.noiseBuffer.getChannelData(0)
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
      }
      // Start the media element in the same gesture call stack. Safari can reject
      // play() when it is first called only after an awaited context.resume().
      this.syncMusic()
      if (this.active && !getBattleAudioSettings().muted && this.context.state !== 'running') await this.context.resume()
      this.sync()
    } catch { /* Unsupported or blocked browser audio must never interrupt a hand. */ }
  }

  setActive(active: boolean): void {
    this.active = active
    this.sync()
  }

  setTension(key: string | null): void {
    if (this.tensionKey === key) return
    this.stopTension()
    this.tensionKey = key
    this.sync()
  }

  sync(): void {
    const context = this.context
    if (!context || !this.master || !this.music || !this.effects) return
    const preferences = getBattleAudioSettings()
    const audible = this.active && !preferences.muted && (preferences.music > 0 || preferences.effects > 0)
    if (!this.active || preferences.muted || preferences.music === 0) this.recording?.pause()
    this.master.gain.setTargetAtTime(audible ? 0.8 : 0, context.currentTime, 0.025)
    this.music.gain.setTargetAtTime(preferences.music * getBattleMusicTrack(preferences.track).gain, context.currentTime, 0.06)
    this.tension?.gain.setTargetAtTime(preferences.music * .9, context.currentTime, 0.04)
    this.effects.gain.setTargetAtTime(preferences.effects, context.currentTime, 0.025)
    if (!audible) {
      this.stopTension()
      this.recording?.pause()
      this.voices.forEach(voice => { try { voice.stop() } catch { /* Already stopped. */ } })
      this.voices.clear()
      if (context.state === 'running') void context.suspend().catch(() => {})
      return
    }
    // A context already unlocked by a gesture may resume when the app returns to the foreground.
    if (context.state === 'suspended') void context.resume().then(() => this.sync()).catch(() => {})
    else this.syncMusic()
  }

  private syncMusic(): void {
    const recording = this.recording
    if (!recording) return
    const selected = getBattleMusicTrack(getBattleAudioSettings().track)
    if (this.recordingTrack !== selected.id) {
      // Reuse one media element and source node: switching cannot overlap tracks.
      recording.pause()
      this.recordingGeneration++
      this.recordingStartPending = null
      this.recordingTrack = selected.id
      recording.src = selected.src
    }
    if (this.tensionKey) {
      recording.pause()
      if (this.shouldPlayMusic() && this.context?.state === 'running') this.startTension()
      else this.stopTension()
      return
    }
    this.stopTension()
    if (!this.shouldPlayMusic()) { recording.pause(); return }
    if (!recording.paused || this.recordingStartPending !== null) return
    const generation = this.recordingGeneration
    this.recordingStartPending = generation
    // Ignore promises from an old selection. A slow previous load must neither
    // restart its track nor pause the newly selected recording.
    void recording.play().then(() => {
      if (!this.shouldPlayMusic() || this.tensionKey) recording.pause()
    }).catch(() => {
      // Autoplay restrictions or failed assets never interrupt poker. The next
      // gesture may retry, and the separate effects channel remains available.
    }).finally(() => {
      if (this.recordingStartPending === generation) this.recordingStartPending = null
    })
  }

  private shouldPlayMusic(): boolean {
    const preferences = getBattleAudioSettings()
    return this.active && !preferences.muted && preferences.music > 0
  }

  private startTension(): void {
    if (this.tensionSource || !this.context || !this.tension) return
    this.tensionBuffer ??= createTensionMusic(this.context)
    const source = this.context.createBufferSource()
    source.buffer = this.tensionBuffer
    source.loop = true
    source.connect(this.tension)
    source.start()
    this.tensionSource = source
  }

  private stopTension(): void {
    const source = this.tensionSource
    this.tensionSource = null
    if (!source) return
    try { source.stop() } catch { /* Already stopped by the browser. */ }
    source.disconnect()
  }

  private tone(frequency: number, at: number, duration: number, gain: number, bus: GainNode, type: OscillatorType = 'sine', attack = 0.006): void {
    if (!this.context) return
    const oscillator = this.context.createOscillator()
    const envelope = this.context.createGain()
    oscillator.type = type
    oscillator.frequency.value = frequency
    envelope.gain.setValueAtTime(0, at)
    envelope.gain.linearRampToValueAtTime(gain, at + attack)
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    oscillator.connect(envelope)
    envelope.connect(bus)
    this.voices.add(oscillator)
    oscillator.start(at)
    oscillator.stop(at + duration + 0.02)
    oscillator.onended = () => { this.voices.delete(oscillator); oscillator.disconnect(); envelope.disconnect() }
  }

  private rustle(at: number, gain: number, highpass: number, duration = 0.065): void {
    if (!this.context || !this.noiseBuffer || !this.effects) return
    const source = this.context.createBufferSource()
    const filter = this.context.createBiquadFilter()
    const envelope = this.context.createGain()
    source.buffer = this.noiseBuffer
    filter.type = 'highpass'
    filter.frequency.value = highpass
    envelope.gain.setValueAtTime(gain, at)
    envelope.gain.exponentialRampToValueAtTime(0.0001, at + duration)
    source.connect(filter)
    filter.connect(envelope)
    envelope.connect(this.effects)
    this.voices.add(source)
    source.start(at)
    source.stop(at + duration)
    source.onended = () => { this.voices.delete(source); source.disconnect(); filter.disconnect(); envelope.disconnect() }
  }

  play(sound: BattleSound): void {
    const context = this.context
    const preferences = getBattleAudioSettings()
    if (!context || context.state !== 'running' || !this.effects || !this.active || preferences.muted || preferences.effects === 0) return
    const at = context.currentTime + 0.01
    // Polling can batch many actions; do not produce an overlapping burst of clicks.
    if (at - this.lastEffectAt < 0.14 && sound !== 'allin' && sound !== 'win') return
    this.lastEffectAt = at
    const note = (frequency: number, offset: number, duration: number, gain: number) => this.tone(frequency, at + offset, duration, gain, this.effects!)
    switch (sound) {
      case 'deal': this.rustle(at, 0.07, 1900); this.rustle(at + 0.12, 0.05, 1900); break
      case 'fold': this.rustle(at, 0.025, 1100, 0.09); break
      case 'check': note(410, 0, 0.055, 0.13); note(355, 0.09, 0.05, 0.09); break
      case 'call':
      case 'raise':
        [0, 0.06, ...(sound === 'raise' ? [0.12] : [])].forEach((offset, index) => {
          this.rustle(at + offset, 0.055, 2500, 0.035)
          note(1800 + index * 230, offset, 0.06, 0.035)
        })
        break
      case 'allin':
        note(98, 0, 0.45, 0.22)
        ;[392, 493.883, 587.33].forEach((frequency, index) => note(frequency, index * 0.095, 0.5, 0.09))
        this.rustle(at + 0.18, 0.1, 2000, 0.12)
        break
      case 'win': [523.251, 659.255, 783.991].forEach((frequency, index) => note(frequency, index * 0.12, 0.45, 0.09)); break
      case 'result': note(330, 0, 0.25, 0.05); break
      case 'turn': note(659.255, 0, 0.16, 0.055); break
    }
  }
}

function getEngine(): TableAudio { return engine ??= new TableAudio() }
export function unlockBattleAudio(): void { void getEngine().unlock() }
export function setBattleAudioActive(active: boolean): void { getEngine().setActive(active) }
const tensionOwners = new Map<string, string>()
export function setBattleTensionMusic(key: string | null, owner = 'battle'): void {
  if (key) tensionOwners.set(owner, key)
  else tensionOwners.delete(owner)
  // A live multiplayer room keeps its cue while local training is inactive.
  getEngine().setTension(tensionOwners.get('battle') ?? tensionOwners.get('trainer') ?? null)
}
export function playBattleSound(sound: BattleSound): void { engine?.play(sound) }


/** Installed once by the app shell, independent of its current page or room. */
export function attachGlobalAudioLifecycle(surface: Document = document): () => void {
  const update = () => setBattleAudioActive(!surface.hidden)
  const unlock = () => { if (!surface.hidden) unlockBattleAudio() }
  update()
  surface.addEventListener('visibilitychange', update)
  surface.addEventListener('pointerdown', unlock, { capture: true, passive: true })
  surface.addEventListener('keydown', unlock, { capture: true })
  return () => {
    surface.removeEventListener('visibilitychange', update)
    surface.removeEventListener('pointerdown', unlock, true)
    surface.removeEventListener('keydown', unlock, true)
    setBattleAudioActive(false)
  }
}
