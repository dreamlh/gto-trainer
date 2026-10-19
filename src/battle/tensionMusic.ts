import type { RoomView } from './types'
import type { PokerTableEventView } from '../poker/tableEvents'

/** One uninterrupted cue covers the hand and its result until the next deal. */
export function battleTensionKey(room: (PokerTableEventView & Pick<RoomView, 'nextHandAt' | 'runoutVote'>) | null): string | null {
  const hand = room?.hand
  if (!room || !hand) return null
  if (hand.finished && room.settlementAt == null && !room.runoutPlayback && room.nextHandAt == null) return null
  // Public player.allin reflects the current stack. An uncalled refund can
  // restore that stack before the final pause, but the earlier shove still happened.
  const hadAllIn = hand.players.some(player => player.allin && !player.folded)
    || hand.history.some(action => action.allin === true)
    || hand.awaitingRunout || !!room.runoutVote || !!room.runoutPlayback
  return hadAllIn ? `${room.instanceId}:${hand.number}` : null
}

/**
 * Original all-in suspense cue, 96 BPM in D minor, an eight-bar seamless loop.
 * A heartbeat and a ticking clock keep time; muted strings pulse under a
 * Dm–B♭–Gm–A progression with tremolo strings above; an endlessly rising
 * Shepard–Risset glissando never resolves; each phrase opens on a low hit and
 * the last bar swells back into it.
 */
export function createTensionMusic(context: Pick<AudioContext, 'sampleRate' | 'createBuffer'>): AudioBuffer {
  const beat = 60 / 96
  const bar = beat * 4
  // 24 kHz holds everything this cue contains and halves the render cost; the
  // browser resamples buffer playback to the context rate.
  const rate = Math.min(context.sampleRate, 24_000)
  const seconds = bar * 8
  const length = Math.round(rate * seconds)
  const buffer = context.createBuffer(2, length, rate)
  const left = new Float32Array(length), right = new Float32Array(length)
  const tau = 2 * Math.PI
  const note = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12)
  let seed = 0x5eed1e55
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1 }

  // Events wrap their tails into the start of the phrase, so the loop has no seam.
  const voice = (at: number, duration: number, pan: number, sample: (time: number) => number) => {
    const start = Math.round(at * rate), count = Math.ceil(duration * rate)
    const l = Math.sqrt((1 - pan) / 2), r = Math.sqrt((1 + pan) / 2)
    for (let i = 0; i < count; i++) {
      const index = (start + i) % length
      const value = sample(i / rate)
      left[index] += value * l; right[index] += value * r
    }
  }
  const envelope = (time: number, duration: number, attack: number, release: number) =>
    Math.min(1, time / attack) * Math.min(1, Math.max(0, duration - time) / release)

  // Heartbeat: a low "lub" on the beat and a softer "dub" just after it.
  const thump = (at: number, gain: number) => voice(at, .32, 0, time => {
    const phase = tau * (42 * time + 30 * (1 - Math.exp(-time * 30)) / 30)
    const body = Math.tanh((Math.sin(phase) + .25 * Math.sin(phase * 2)) * 1.6)
    return body * Math.exp(-time * 11) * gain * envelope(time, .32, .004, .05)
  })
  // Clock: alternating tick and tock, short and dry.
  const tick = (at: number, frequency: number, gain: number, pan: number) => voice(at, .03, pan, time =>
    (Math.sin(tau * frequency * time) * .7 + noise() * .3) * Math.exp(-time * 220) * gain * envelope(time, .03, .0008, .005))
  // Muted string/bass pulse: a few odd and even harmonics, choked quickly.
  const pulse = (at: number, frequency: number, gain: number, pan: number) => voice(at, beat * .45, pan, time => {
    const phase = tau * frequency * time
    const tone = Math.sin(phase) + .5 * Math.sin(phase * 2) + .28 * Math.sin(phase * 3) + .12 * Math.sin(phase * 4)
    return Math.tanh(tone * 1.4) * gain * Math.exp(-time * 7) * envelope(time, beat * .45, .006, .05)
  })
  // Tremolo strings: a gently detuned pair per note, bowed in sixteenths.
  const strings = (at: number, duration: number, frequency: number, gain: number, pan: number) => voice(at, duration, pan, time => {
    const absolute = at + time
    const cycle = (absolute / (beat / 4)) % 1
    const bow = .55 + .45 * (1 - Math.abs(2 * cycle - 1))
    const vibrato = 1 + .003 * Math.sin(tau * 5.2 * time)
    const phase = tau * frequency * vibrato * time
    const tone = Math.sin(phase) + .35 * Math.sin(phase * 2 + .4) + .5 * Math.sin(tau * frequency * 1.004 * time) + .15 * Math.sin(phase * 3)
    return tone * bow * gain * envelope(time, duration, .25, .4)
  })
  // Low cinematic hit: a sub drop, a dissonant cluster and a burst of air.
  const hit = (at: number, gain: number) => {
    voice(at, 2.6, 0, time => {
      const sub = Math.sin(tau * (36 * time + 40 * (1 - Math.exp(-time * 6)) / 6))
      const cluster = [note(-31), note(-24), note(-18)].reduce((sum, f) => sum + Math.sin(tau * f * time) + .4 * Math.sin(tau * f * 2.003 * time), 0) / 3
      return Math.tanh(sub * 1.3 + cluster * .9) * Math.exp(-time * 1.6) * gain * envelope(time, 2.6, .006, .4)
    })
    voice(at, .5, 0, time => noise() * Math.exp(-time * 9) * gain * .35 * envelope(time, .5, .003, .05))
  }
  // Rising swell back into the phrase: filtered-feeling air and a cluster crescendo.
  const swell = (at: number, duration: number, gain: number) => {
    let previous = 0
    voice(at, duration, 0, time => {
      const rise = (time / duration) ** 2.4
      const white = noise()
      previous = previous + (white - previous) * (.04 + .5 * rise)
      const cluster = Math.sin(tau * note(-19) * time) + Math.sin(tau * note(-18) * time) + .6 * Math.sin(tau * note(-12) * time)
      return (previous * .9 + cluster * .25) * rise * gain * envelope(time, duration, .01, .012)
    })
  }

  // Dm – B♭ – Gm – A, two bars each; the A major chord leaves the question open.
  const progression = [
    { bass: note(-31), chord: [note(-7), note(-4), note(0)] },
    { bass: note(-35), chord: [note(-11), note(-7), note(-4)] },
    { bass: note(-38), chord: [note(-14), note(-11), note(-7)] },
    { bass: note(-36), chord: [note(-12), note(-8), note(-5)] },
  ]
  for (let b = 0; b < 8; b++) {
    const at = b * bar
    const { bass, chord } = progression[Math.floor(b / 2)]
    for (let i = 0; i < 4; i++) {
      thump(at + i * beat, .5)
      thump(at + i * beat + .2, .3)
    }
    for (let i = 0; i < 8; i++) {
      tick(at + i * beat / 2, i % 2 ? 2350 : 3150, i % 2 ? .05 : .065, i % 2 ? .38 : -.38)
      pulse(at + i * beat / 2, i % 4 === 3 ? bass * 2 : bass, i % 2 ? .07 : .1, i % 2 ? .15 : -.15)
    }
    if (b % 2 === 0) chord.forEach((frequency, i) => strings(at, bar * 2, frequency * 2, .022, [-.45, 0, .45][i]))
  }
  hit(0, .55)
  hit(bar * 4, .38)
  swell(bar * 7, bar, .22)

  // Shepard–Risset glissando: six octave-spaced voices rise one octave per loop.
  // Each voice's phase depends only on its position, so voice k at the end of
  // the loop continues exactly as voice k + 1 at its start.
  const octaves = 6, base = 55, centre = 3, spread = 1.15
  const scale = base * seconds / Math.LN2
  const weights = new Float64Array(octaves)
  const lower = Array.from({ length: octaves }, (_, k) => scale * 2 ** k)
  const upper = Array.from({ length: octaves }, (_, k) => scale * 2 ** (k - octaves))
  const step = 2 ** (1 / length)
  let rise = 1
  for (let i = 0; i < length; i++, rise *= step) {
    const progress = i / length
    // Loudness bells move slowly; refreshing them every 32 samples is inaudible.
    if ((i & 31) === 0) for (let k = 0; k < octaves; k++) {
      const position = (k + progress) % octaves
      weights[k] = Math.exp(-(((position - centre) / spread) ** 2))
    }
    let value = 0
    for (let k = 0; k < octaves; k++) {
      if (weights[k] < .003) continue
      const cycles = (k + progress >= octaves ? upper[k] : lower[k]) * rise
      const phase = tau * (cycles - Math.floor(cycles))
      const sine = Math.sin(phase)
      value += weights[k] * sine * (1 + .5 * Math.cos(phase))
    }
    const shimmer = value * .028
    left[i] += shimmer; right[i] += shimmer * .9
  }

  const outLeft = buffer.getChannelData(0), outRight = buffer.getChannelData(1)
  // A small room: crossed early reflections widen the strings without smearing the beat.
  const reflections = [[.023, .1], [.041, .07], [.067, .05], [.113, .03]]
    .map(([delay, gain]) => ({ delay: Math.round(delay * rate), gain }))
  let peak = 0
  for (let i = 0; i < length; i++) {
    let l = left[i], r = right[i]
    for (const { delay, gain } of reflections) {
      const index = (i - delay + length) % length
      l += right[index] * gain; r += left[index] * gain
    }
    outLeft[i] = Math.tanh(l * 1.1); outRight[i] = Math.tanh(r * 1.1)
    peak = Math.max(peak, Math.abs(outLeft[i]), Math.abs(outRight[i]))
  }
  // Keep master/music controls authoritative, with headroom for table effects.
  // Every layer wraps or is phase-continuous, so the loop needs no fade at its join.
  const headroom = Math.min(1, .76 / peak)
  for (let i = 0; i < length; i++) { outLeft[i] *= headroom; outRight[i] *= headroom }
  return buffer
}
