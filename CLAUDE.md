# Webcam Theremin — Claude Context

## What this project is

A browser-based theremin controlled by hand tracking (MediaPipe), with a Guitar Hero-style game mode that plays MIDI-backed songs. The user controls pitch with their right hand (horizontal position) and volume with their left hand (vertical position).

## Stack

- **Vite** + **TypeScript** — no framework
- **Tone.js** (`tone@14`) — Web Audio synthesis and transport scheduling
- **`@tonejs/midi`** — MIDI file parsing (ticks → seconds via tempo map)
- **MediaPipe Tasks Vision** — hand landmark detection, loaded from CDN

## Running

```
npm run dev    # dev server
npm run build  # production build
npx tsc --noEmit  # type-check (run via ./node_modules/.bin/tsc if npx hangs)
```

## File map

| File | Role |
|---|---|
| `src/main.ts` | `Theremin` class — camera, hand tracking, audio oscillator, UI wiring |
| `src/game.ts` | `Game` class — MIDI playback, piano roll canvas, scoring |
| `src/song.ts` | `loadSong()`, `SONGS` catalogue, shared types |
| `src/style.css` | All styles (dark theme, monospace) |
| `index.html` | Single page; all DOM IDs are stable |
| `public/songs/` | MIDI files served as static assets |

## Architecture notes

### Theremin (src/main.ts)
- MediaPipe runs in `VIDEO` mode; landmarks are detected once per unique video frame
- Right hand X → pitch (logarithmic, A2–A6); left hand Y → volume
- EMA smoothing (`SMOOTH = 0.14`) applied every rAF tick
- Wrist Y oscillation → vibrato depth via RMS of recent frames
- Quantize snaps frequency to a scale before smoothing so notes glide into place

### Game (src/game.ts)
- `VoicePool` pre-allocates a fixed set of `Tone.Synth` instances; round-robin assignment prevents unbounded node accumulation
- `Tone.Part` schedules all note callbacks on the Transport timeline
- Transport ordering is critical: `cancel()` → `stop()` → `seconds = 0` → `setupAudio()` → `start()` (reversed order silences audio)
- Melody track gets a `Tone.Reverb`; backing tracks are dry (ConvolverNode is expensive to run for many parallel sources)
- Drums use `MembraneSynth` (kick) and `NoiseSynth` (snare/hihat/cymbal). `NoiseSynth` replaced `MetalSynth` because MetalSynth uses ~18 Web Audio nodes per instance
- Backing polyphony is capped at 3 voices max regardless of `VOICES` config

### Song loading (src/song.ts)
- Some MIDIs store track names on empty tracks before the note-bearing track ("name-pairing" pattern); `loadSong` forward-scans and carries the pending name forward
- `melodyTrackIndex` is 0-based among tracks-that-have-notes (not all MIDI tracks)
- Notes shorter than 40 ms are filtered at load time — inaudible but add scheduling overhead
- `skipTracks` in `SongConfig` lets per-song configs exclude redundant backing tracks

## Song catalogue

| Song | File | Melody track index | Notes |
|---|---|---|---|
| Take Me Out to the Ballgame | `Take_Me_Out_To_The_Ballgame_2.mid` | 0 (Trumpet) | |
| Say It Ain't So (Weezer) | `Say_It_Ain't_So.mid` | 7 (Vocal Melody) | Jazz Guitar + Reggae Guitar skipped (rhythm doubles, cause CPU overload at dense sections ~2-3 min) |

## Known issues / ongoing work

- **Audio degradation on "Say It Ain't So" in Firefox**: audio slows and becomes crunchy around the 2-3 minute mark. The MIDI has a density spike (~270 notes/10s window at ~170-180s). Attempted fixes: VoicePool, polyphony caps, note duration caps, reverb bypass, skipping tracks, NoiseSynth drums. Polyphony cap (max 3 backing voices) + skipping 2 guitar tracks + NoiseSynth drums reduced node count from ~180 to ~70 but results in Firefox are still being tested. Chrome/Safari are the recommended browsers.
- **`skipTracks` for Weezer was temporarily commented out** in a linter pass — check `src/song.ts` and restore if missing.

## Web Audio / Tone.js gotchas

- `Tone.Part` events are wired to `Tone.Transport`. Always `transport.cancel()` before scheduling new Parts; always reset transport BEFORE calling `setupAudio()`, not after.
- `Tone.Reverb.generate()` is async. Must be awaited before connecting to destination or audio is silenced.
- `MetalSynth` constructor does not accept a `frequency` field — omit it.
- `OscillatorNode` in Web Audio cannot be restarted after stop; `Tone.Oscillator` creates a new native node per `start()` call. This is expected behavior, not a leak.
- Firefox has significantly higher per-node CPU cost than Chrome for complex Web Audio graphs. If adding new synthesis, test in Firefox early.
