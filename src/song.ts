import { Midi } from "@tonejs/midi";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SongNote {
  time:     number;  // seconds from song start
  duration: number;  // seconds
  midi:     number;  // MIDI note number
}

export interface TrackInfo {
  name:   string;
  notes:  SongNote[];
  isDrum: boolean;
}

export interface ParsedSong {
  title:        string;
  melodyName:   string;   // track name of the melody, for voice lookup
  melody:       SongNote[];
  backing:      TrackInfo[];
  songDuration: number;
  midiMin:      number;
  midiMax:      number;
}

export interface SongConfig {
  title:            string;
  file:             string;
  melodyTrackIndex: number;    // 0-based index among tracks-with-notes
  skipTracks?:      string[];  // track names to exclude from backing synthesis
}

// ---------------------------------------------------------------------------
// Song catalogue
// ---------------------------------------------------------------------------

export const SONGS: SongConfig[] = [
  {
    title:            "Take Me Out to the Ballgame",
    file:             "/songs/Take_Me_Out_To_The_Ballgame_2.mid",
    melodyTrackIndex: 0,
  },
  {
    title:            "Say It Ain't So",
    file:             "/songs/Say_It_Ain't_So.mid",
    melodyTrackIndex: 7,
    // Jazz Guitar and Reggae Guitar are rhythm-guitar doubles; skipping them
    // halves the backing oscillator count and prevents CPU overload at dense
    // sections (~2-3 min mark).
    // skipTracks: ["Jazz Guitar", "Reggae Guitar"],
  },
];

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loadSong(config: SongConfig): Promise<ParsedSong> {
  const res = await fetch(config.file);
  const buf = await res.arrayBuffer();
  const midi = new Midi(buf);

  // Some MIDIs store track names on empty tracks that precede the note track.
  // Build a name map: for each named-but-empty track, assign its name to the
  // next track that actually has notes.
  const nameForTrack = new Map<number, string>();
  let pending = "";
  for (let i = 0; i < midi.tracks.length; i++) {
    const t = midi.tracks[i];
    if (t.notes.length === 0 && t.name.trim()) {
      pending = t.name.trim();
    } else if (t.notes.length > 0) {
      nameForTrack.set(i, t.name.trim() || pending);
      pending = "";
    }
  }

  const skipSet = new Set((config.skipTracks ?? []).map(s => s.toLowerCase()));

  const active: TrackInfo[] = midi.tracks
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.notes.length > 0)
    .map(({ t, i }) => {
      const name = nameForTrack.get(i) ?? t.name.trim() ?? t.instrument.name;
      return {
        name,
        // Drop notes shorter than 40 ms — inaudible and just add synthesis load.
        notes: t.notes
          .filter(n => n.duration >= 0.04)
          .map(n => ({ time: n.time, duration: n.duration, midi: n.midi })),
        isDrum: t.channel === 9,
      };
    })
    .filter(({ notes }) => notes.length > 0);

  const melodyTrack = active[config.melodyTrackIndex] ?? active.find(t => !t.isDrum)!;
  const backing     = active
    .filter(t => t !== melodyTrack)
    .filter(t => !skipSet.has(t.name.toLowerCase()));
  const midiVals    = melodyTrack.notes.map(n => n.midi);

  return {
    title:        config.title,
    melodyName:   melodyTrack.name,
    melody:       melodyTrack.notes,
    backing,
    songDuration: midi.duration,
    midiMin:      Math.min(...midiVals),
    midiMax:      Math.max(...midiVals),
  };
}
