import { useEffect, useSyncExternalStore } from 'react'
import {
  BATTLE_MUSIC_TRACKS, getBattleMusicTrack, getBattleAudioSettings, subscribeBattleAudioSettings,
  setBattleTensionMusic, unlockBattleAudio, updateBattleAudioSettings, type BattleMusicId,
} from '../battle/audio'
import { useLanguage } from '../battle/i18n'
import { usePokerAudioEvents } from './usePokerAudioEvents'
import { PokerAllInEffect } from './PokerAllInEffect'
import { playerDisplayName } from '../battle/presentation'
import { battleTensionKey } from '../battle/tensionMusic'
import type { RoomView } from '../battle/types'
import '../battle/atmosphere.css'

export function useAudioSettings() {
  return useSyncExternalStore(subscribeBattleAudioSettings, getBattleAudioSettings, getBattleAudioSettings)
}

export function SpeakerIcon({ muted }: { muted: boolean }) {
  return <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M11 4 6 8H3v8h3l5 4z" />
    {muted ? <path d="m16 9 5 6m0-6-5 6" /> : <><path d="M15 8a6 6 0 0 1 0 8" /><path d="M18 5a10 10 0 0 1 0 14" /></>}
  </svg>
}

export function BattleAudioSettings() {
  const { t } = useLanguage()
  const settings = useAudioSettings()
  const selected = getBattleMusicTrack(settings.track)
  return <section className="battle-audio-settings" aria-label={t('声音设置', 'Sound settings')}>
    <div className="battle-audio-settings-heading"><h3>{t('声音', 'Sound')}</h3><button type="button" role="switch" aria-checked={!settings.muted}
      className="battle-audio-switch" aria-label={t('游戏声音', 'Game sound')}
      onClick={() => { updateBattleAudioSettings({ muted: !settings.muted }); unlockBattleAudio() }}>
      <span aria-hidden="true" /><span>{settings.muted ? t('关闭', 'Off') : t('开启', 'On')}</span>
    </button></div>
    <label className="battle-music-picker">
      <span>{t('背景曲目', 'Music track')}</span>
      <select value={settings.track} onChange={event => {
        updateBattleAudioSettings({ track: event.target.value as BattleMusicId })
        unlockBattleAudio()
      }}>
        {BATTLE_MUSIC_TRACKS.map(track => <option key={track.id} value={track.id}>{track.title} · {t(track.zh, track.en)}</option>)}
      </select>
      <small>{t(selected.zh, selected.en)} · {selected.duration}</small>
    </label>
    {(['music', 'effects'] as const).map(channel => <label className="battle-audio-volume" key={channel}>
      <span>{channel === 'music' ? t('背景音乐', 'Background music') : t('游戏音效', 'Game effects')}</span>
      <input type="range" min="0" max="100" step="1" value={Math.round(settings[channel] * 100)}
        aria-valuetext={`${Math.round(settings[channel] * 100)}%`} onChange={event => {
          updateBattleAudioSettings({ [channel]: Number(event.target.value) / 100 })
          unlockBattleAudio()
        }} />
      <output>{Math.round(settings[channel] * 100)}%</output>
    </label>)}
    <p className="battle-music-credit">
      <a href={selected.source} target="_blank" rel="noreferrer">{selected.title}</a>
      {' · '}{selected.artist}{' · '}
      <a href={selected.license} target="_blank" rel="noreferrer">CC BY 4.0</a>
      <span>{t('已转码，完整曲目', 'Transcoded · full recording')}</span>
    </p>
  </section>
}

/** Room events remain audible while another app page is open. App owns playback lifecycle. */
export function BattleAtmosphere({ room, active }: { room: RoomView | null; active: boolean }) {
  const { t } = useLanguage()
  const allin = usePokerAudioEvents(room)
  const tensionKey = battleTensionKey(room)
  useEffect(() => { setBattleTensionMusic(tensionKey) }, [tensionKey])
  useEffect(() => () => { setBattleTensionMusic(null) }, [])
  const player = room?.players.find(member => member.id === allin?.ids[0])
  const name = allin && allin.ids.length > 1 ? t(`${allin.ids.length} 人全下`, `${allin.ids.length} players`)
    : player ? playerDisplayName(player, t) : ''
  return allin && active ? <PokerAllInEffect eventKey={allin.key} name={name} /> : null
}
