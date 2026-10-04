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

/** Original straight-time industrial battle cue: 176 BPM, hard drums and distorted fifths. */
export function createTensionMusic(context: Pick<AudioContext, 'sampleRate' | 'createBuffer'>): AudioBuffer {
  const beat = 60 / 176
  const rate = context.sampleRate
  const length = Math.round(rate * beat * 64)
  const buffer = context.createBuffer(2, length, rate)
  const left = new Float32Array(length), right = new Float32Array(length)
  const tau = 2 * Math.PI
  const pitch = (root: number, semitones: number) => root * 2 ** (semitones / 12)
  let seed = 0x173a6e91
  const noise = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2147483648 - 1 }

  // Wrap note tails into the start of the sixteen-bar phrase for a continuous loop.
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
  const kick = (at: number, gain: number) => voice(at, .30, 0, time => {
    const phase = tau * (44 * time + 125 * (1 - Math.exp(-time * 48)) / 48)
    const punch = Math.tanh((Math.sin(phase) + .2 * Math.sin(phase * 2)) * 1.7)
    const click = noise() * Math.exp(-time * 210) * .20
    return (punch * Math.exp(-time * 12) + click) * gain * envelope(time, .30, .0015, .03)
  })
  const snare = (at: number, gain: number, pan: number) => {
    let previous = 0
    voice(at, .19, pan, time => {
      const white = noise(), crack = white - previous * .75
      previous = white
      const body = Math.sin(tau * 186 * time) + .35 * Math.sin(tau * 330 * time)
      return Math.tanh(crack * .9 + body * .55) * Math.exp(-time * 18) * gain * envelope(time, .19, .001, .035)
    })
  }
  const hat = (at: number, gain: number, pan: number, open: boolean) => {
    const duration = open ? .11 : .052
    let previous = 0
    voice(at, duration, pan, time => {
      const white = noise(), metallic = white - previous * .95
      previous = white
      return metallic * gain * Math.exp(-time * (open ? 25 : 65)) * envelope(time, duration, .001, .014)
    })
  }
  const bass = (at: number, frequency: number, gain: number, pan: number, duration = beat * .22) => voice(at, duration, pan, time => {
    const phase = tau * frequency * time
    const growl = Math.sin(phase) + .42 * Math.sin(phase * 2) + .24 * Math.sin(phase * 3) + .12 * Math.sin(phase * 5)
    // A short kick-shaped dip clears the low end without softening the subdivision.
    const pump = .48 + .52 * Math.min(1, ((at + time) % beat) / .075)
    return Math.tanh(growl * 2.4) * gain * pump * envelope(time, duration, .003, .023)
  })
  const stab = (at: number, root: number, gain: number, pan: number) => voice(at, beat * .46, pan, time => {
    const phase = tau * root * time
    const fifth = Math.sin(phase) + .72 * Math.sin(phase * 1.5) + .3 * Math.sin(phase * 3)
    return Math.tanh(fifth * 2.7) * gain * envelope(time, beat * .46, .002, .045)
  })

  const roots = [41.203, 36.708, 32.703, 43.654] // E–D–C–F power-riff movement; no swing or brass voicing.
  const riff = [0, 0, 7, 0, 12, 0, 7, 0, 0, 0, 7, 12, 0, 7, 10, 7]
  for (let bar = 0; bar < 16; bar++) {
    const at = bar * beat * 4, root = roots[Math.floor(bar / 2) % roots.length]
    for (let pulse = 0; pulse < 4; pulse++) {
      kick(at + pulse * beat, pulse === 0 ? .67 : .57)
      if (pulse % 2 === 1) snare(at + pulse * beat, .31, pulse === 1 ? -.12 : .12)
      bass(at + pulse * beat, root, .095, 0, beat * .78)
    }
    for (let step = 0; step < 16; step++) {
      const when = at + step * beat / 4
      const offbeat = step % 4 === 2
      hat(when, offbeat ? .09 : step % 2 ? .038 : .052, step % 2 ? .46 : -.46, offbeat)
      // Hard-gated sixteenths and octave/fifth jumps create the forward motion.
      bass(when, pitch(root * 2, riff[(step + (bar % 4 === 3 ? 4 : 0)) % riff.length]), step % 4 === 0 ? .16 : .12, step % 2 ? .18 : -.18)
    }
    stab(at, root * 4, .105, -.42)
    stab(at + beat * 2.5, root * 4, .09, .42)
    if (bar % 4 === 3) {
      for (let roll = 1; roll < 4; roll++) snare(at + beat * (3 + roll / 4), .09 + roll * .035, roll % 2 ? -.24 : .24)
      kick(at + beat * 3.5, .30)
    }
    // A short non-pitched metal strike marks each phrase, rather than a sustained horn.
    if (bar % 4 === 0) voice(at, .3, .28, time => {
      const metal = Math.sin(tau * 713 * time) * Math.sin(tau * 1039 * time) + noise() * .25
      return metal * .075 * Math.exp(-time * 17) * envelope(time, .3, .001, .06)
    })
  }

  const outLeft = buffer.getChannelData(0), outRight = buffer.getChannelData(1)
  // Tight stereo reflections keep the impacts sharp instead of washing out fast drums.
  const reflections = [[.019, .085], [.037, .055], [.071, .035]]
    .map(([seconds, gain]) => ({ delay: Math.round(seconds * rate), gain }))
  let peak = 0
  for (let i = 0; i < length; i++) {
    let l = left[i], r = right[i]
    for (const { delay, gain } of reflections) {
      const index = (i - delay + length) % length
      l += right[index] * gain; r += left[index] * gain
    }
    outLeft[i] = Math.tanh(l * 1.05); outRight[i] = Math.tanh(r * 1.05)
    peak = Math.max(peak, Math.abs(outLeft[i]), Math.abs(outRight[i]))
  }
  // Keep master/music controls authoritative, with headroom for table effects.
  const headroom = Math.min(1, .76 / peak)
  for (let i = 0; i < length; i++) {
    // A four-millisecond cosine join removes residual noisy transients at the
    // phrase boundary without rounding off the intervening kick/snare attacks.
    const edge = Math.min(1, i / (rate * .004), (length - 1 - i) / (rate * .004))
    const gain = headroom * (.5 - .5 * Math.cos(Math.PI * edge))
    outLeft[i] *= gain; outRight[i] *= gain
  }
  return buffer
}
