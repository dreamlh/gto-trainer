# Table music

All three recordings are by **Kevin MacLeod (incompetech.com)**, under
**Creative Commons Attribution 4.0 International (CC BY 4.0)**.

- License: https://creativecommons.org/licenses/by/4.0/
- Official licensing page: https://incompetech.com/music/royalty-free/licenses/
- Official catalog: https://incompetech.com/music/royalty-free/pieces.json
- Retrieved: 2026-10-02

## Jazz Brunch

“Jazz Brunch” — Kevin MacLeod (incompetech.com). Licensed under CC BY 4.0.

- Official track and attribution: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1700074
- Official download: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Jazz%20Brunch.mp3
- Local asset: `jazz-brunch.m4a`
- ISRC: `USUAN1700074`; full duration 323.050 s, 100 BPM.
- Instruments: electric piano, drums, bass, organ, guitar.

## Cool Vibes

“Cool Vibes” — Kevin MacLeod (incompetech.com). Licensed under CC BY 4.0.

- Official track and attribution: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100863
- Official download: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cool%20Vibes.mp3
- Local asset: `cool-vibes.m4a`
- ISRC: `USUAN1100863`; full duration 218.313 s, 83 BPM.
- Instruments: vibraphone, bass, drum kit.

## Night on the Docks - Piano

“Night on the Docks - Piano” — Kevin MacLeod (incompetech.com). Licensed under CC BY 4.0.

- Official track and attribution: https://incompetech.com/music/royalty-free/index.html?isrc=USUAN1100135
- Official download: https://incompetech.com/music/royalty-free/mp3-royaltyfree/Night%20on%20the%20Docks.mp3
- Local asset: `night-on-the-docks.m4a`
- ISRC: `USUAN1100135`; full duration 174.000 s.
- Instrument: electric piano.

## Processing and playback

Each full recording was transcoded from its official MP3 to stereo AAC (target
128 kbps) using macOS Core Audio. No music was cut, recomposed or added.
Playback repeats the selected complete recording, retaining its natural ending;
these are not presented as seamless musical loops. The selected track's title,
composer, original source and license link are visible in the app's global sound
settings. No endorsement by the composer is implied.

Example conversion, after downloading the official MP3:

```sh
afconvert /tmp/track.mp3 /tmp/track.wav -f WAVE -d LEI16
afconvert /tmp/track.wav public/audio/track.m4a -f m4af -d aac -b 128000 -q 127
```

Decoded source measurements (44.1 kHz stereo, no clipped PCM samples):

- Jazz Brunch: peak −0.53 dBFS, RMS −18.84 dBFS.
- Cool Vibes: peak −9.31 dBFS, RMS −30.49 dBFS.
- Night on the Docks - Piano: peak −7.76 dBFS, RMS −27.94 dBFS.

To avoid abrupt loudness changes, the app applies track gains of 0.72, 2.45 and
2.05 respectively, before the user's music volume and master gain. The adjusted
RMS levels are approximately −21.7, −22.7 and −21.7 dBFS; peak headroom remains
at least 1.5 dB before the 0.8 master gain. No dynamics compression is applied.
These are signal measurements, not a claim of subjective audition.

The app uses one media element, so switching songs first stops the old recording.
Track selection, independent music/effect volumes and master mute are persisted
and synchronized between tabs. Music loads on demand after a user gesture,
continues across app pages, and pauses when the browser document is hidden.
