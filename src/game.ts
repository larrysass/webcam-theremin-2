import * as Tone from "tone";
import { loadSong, SONGS, type ParsedSong, type SongNote, type SongConfig } from "./song";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const LOOKAHEAD        = 4.0;  // seconds of notes visible ahead of hit line
const START_DELAY      = 3;    // seconds of pre-roll (countdown) before song
const HIT_LINE_RATIO   = 0.22; // hit line x position as fraction of canvas width
const NOTE_HEIGHT      = 14;   // px
const TOLERANCE        = 2.0;  // semitones — within this = "hit"
const MIN_GAIN_TO_PLAY = 0.05; // theremin must be audible to count as playing

// ---------------------------------------------------------------------------
// Synth voice definitions per MIDI track name
// ---------------------------------------------------------------------------

type BasicWaveform = "sine" | "triangle" | "sawtooth" | "square";

interface Voice {
  type:       BasicWaveform;
  volume:     number;
  attack:     number;
  decay:      number;
  sustain:    number;
  release:    number;
  polyphony?: number;  // max simultaneous voices; defaults to 4 if unset
}

const VOICES: Record<string, Voice> = {
  // Ballgame v1
  "Marimba":              { type: "triangle", volume: -6,  attack: 0.001, decay: 0.4,  sustain: 0,   release: 0.5 },
  "Baseball Organ":       { type: "sine",     volume: -20, attack: 0.06,  decay: 0,    sustain: 1,   release: 0.4 },
  "Bass":                 { type: "triangle", volume: -14, attack: 0.02,  decay: 0.1,  sustain: 0.9, release: 0.2 },
  "Elec Piano":           { type: "triangle", volume: -20, attack: 0.01,  decay: 0.3,  sustain: 0.5, release: 0.3 },
  "Steel Drum":           { type: "triangle", volume: -20, attack: 0.001, decay: 0.3,  sustain: 0,   release: 0.3 },
  "Harmonica":            { type: "sawtooth", volume: -22, attack: 0.03,  decay: 0.1,  sustain: 0.6, release: 0.2 },
  // Ballgame v2
  "Trumpet":              { type: "sawtooth", volume: -6,  attack: 0.04,  decay: 0.05, sustain: 0.8, release: 0.2 },
  "Acc. Strings":         { type: "sawtooth", volume: -20, attack: 0.08,  decay: 0,    sustain: 1,   release: 0.4 },
  "Lead Strings":         { type: "sawtooth", volume: -20, attack: 0.08,  decay: 0,    sustain: 1,   release: 0.4 },
  "Bass Strings":         { type: "triangle", volume: -16, attack: 0.04,  decay: 0.1,  sustain: 0.9, release: 0.3 },
  "Clarinet":             { type: "triangle", volume: -20, attack: 0.02,  decay: 0.1,  sustain: 0.7, release: 0.2 },
  "Tuba":                 { type: "sawtooth", volume: -18, attack: 0.05,  decay: 0.1,  sustain: 0.8, release: 0.3 },
  "Trombone":             { type: "sawtooth", volume: -20, attack: 0.05,  decay: 0.1,  sustain: 0.7, release: 0.3 },
  "French Horn":          { type: "sawtooth", volume: -20, attack: 0.06,  decay: 0.05, sustain: 0.8, release: 0.3 },
  "French Horn 2":        { type: "sawtooth", volume: -20, attack: 0.06,  decay: 0.05, sustain: 0.8, release: 0.3 },
  "Bells":                { type: "sine",     volume: -18, attack: 0.001, decay: 0.5,  sustain: 0.1, release: 0.8 },
  "Flute":                { type: "triangle", volume: -20, attack: 0.03,  decay: 0.05, sustain: 0.8, release: 0.3 },
  // Say It Ain't So
  "Vocal Melody (lyrics)":{ type: "triangle", volume: -6,  attack: 0.02,  decay: 0.05, sustain: 0.9, release: 0.3, polyphony: 4 },
  "Bass Guitar":          { type: "triangle", volume: -14, attack: 0.01,  decay: 0.1,  sustain: 0.9, release: 0.2, polyphony: 2 },
  "Jazz Guitar":          { type: "sawtooth", volume: -22, attack: 0.01,  decay: 0.1,  sustain: 0.7, release: 0.2, polyphony: 6 },
  "Reggae Guitar":        { type: "sawtooth", volume: -22, attack: 0.02,  decay: 0.1,  sustain: 0.6, release: 0.2, polyphony: 6 },
  "Overdrive Guitar":     { type: "sawtooth", volume: -20, attack: 0.01,  decay: 0.05, sustain: 0.9, release: 0.2, polyphony: 6 },
  "Electric Guitar":      { type: "sawtooth", volume: -22, attack: 0.01,  decay: 0.05, sustain: 0.8, release: 0.2, polyphony: 6 },
  "Solo Jazz":            { type: "sawtooth", volume: -20, attack: 0.01,  decay: 0.05, sustain: 0.8, release: 0.2, polyphony: 4 },
  "Lead Guitar":          { type: "sawtooth", volume: -18, attack: 0.01,  decay: 0.05, sustain: 0.9, release: 0.2, polyphony: 4 },
};

const DEFAULT_VOICE: Voice = { type: "sine", volume: -24, attack: 0.02, decay: 0.1, sustain: 0.5, release: 0.3, polyphony: 4 };

// ---------------------------------------------------------------------------
// VoicePool
//
// Pre-allocates a fixed set of Tone.Synth instances at construction time and
// cycles through them round-robin. No new AudioContext nodes are ever created
// after setup — eliminates the unbounded accumulation that Tone.PolySynth
// suffers on long, dense songs.
// ---------------------------------------------------------------------------

class VoicePool {
  readonly #voices: Tone.Synth[];
  #next = 0;

  constructor(size: number, voice: Voice, output: Tone.ToneAudioNode) {
    this.#voices = Array.from({ length: size }, () => {
      const s = new Tone.Synth({
        oscillator: { type: voice.type },
        envelope: {
          attack:  voice.attack,
          decay:   voice.decay,
          sustain: voice.sustain,
          release: voice.release,
        },
        volume: voice.volume,
      });
      s.connect(output);
      return s;
    });
  }

  trigger(freq: number, duration: number, time: number) {
    // Round-robin: steal the oldest voice if all are busy — predictable, bounded
    const v = this.#voices[this.#next % this.#voices.length];
    this.#next = (this.#next + 1) % this.#voices.length;
    v.triggerAttackRelease(freq, duration, time);
  }

  dispose() {
    for (const v of this.#voices) { v.disconnect(); v.dispose(); }
  }
}

// ---------------------------------------------------------------------------
// Game class
// ---------------------------------------------------------------------------

export class Game {
  readonly #canvas: HTMLCanvasElement;
  readonly #ctx:    CanvasRenderingContext2D;
  readonly #getPlayerState: () => { freq: number; gain: number };

  #isRunning = false;
  #rafId:      number | null = null;

  // Song data
  #songPromise: Promise<ParsedSong>;
  #parsedSong:  ParsedSong | null = null;
  #songConfig:  SongConfig;

  // Audio
  #pools:     VoicePool[]                              = [];
  #drumSynths: (Tone.MembraneSynth | Tone.NoiseSynth)[] = [];
  #parts:     Tone.Part[]                              = [];
  #reverb:    Tone.Reverb | null                       = null;

  // Scoring
  #hitFrames   = 0;
  #totalFrames = 0;

  constructor(
    canvas:         HTMLCanvasElement,
    getPlayerState: () => { freq: number; gain: number },
  ) {
    this.#canvas         = canvas;
    this.#ctx            = canvas.getContext("2d")!;
    this.#getPlayerState = getPlayerState;

    // Pre-load the default song so it's ready by the time the user hits Play
    this.#songConfig  = SONGS[0];
    this.#songPromise = loadSong(SONGS[0]);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get isRunning() { return this.#isRunning; }

  get scorePct() {
    return this.#totalFrames > 0
      ? Math.round((this.#hitFrames / this.#totalFrames) * 100)
      : 0;
  }

  async start() {
    this.#canvas.width  = this.#canvas.offsetWidth;
    this.#canvas.height = this.#canvas.offsetHeight;

    this.#hitFrames   = 0;
    this.#totalFrames = 0;
    this.#isRunning   = true;

    // Wait for MIDI to finish loading (instant if already resolved)
    this.#parsedSong = await this.#songPromise;

    // Reset transport BEFORE scheduling Parts so cancel() doesn't wipe them
    const transport = Tone.getTransport();
    transport.cancel();
    transport.stop();
    transport.seconds = 0;

    await this.#setupAudio();

    transport.start();
    this.#draw();
  }

  stop() {
    this.#isRunning = false;
    if (this.#rafId !== null) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    Tone.getTransport().stop();
    this.#teardownAudio();
  }

  setSong(config: SongConfig) {
    if (this.#isRunning) this.stop();
    this.#songConfig  = config;
    this.#songPromise = loadSong(config);
    this.#parsedSong  = null;
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------

  async #setupAudio() {
    const song = this.#parsedSong!;

    // Reverb — melody only. Backing tracks go dry to avoid feeding many
    // simultaneous sources through the ConvolverNode.
    this.#reverb = new Tone.Reverb({ decay: 1.5, wet: 0.2 });
    await this.#reverb.generate();
    this.#reverb.toDestination();

    const dest = Tone.getDestination();

    const addMelodicTrack = (notes: SongNote[], voice: Voice, isMelody = false) => {
      // Backing: short release so voices are freed quickly; polyphony capped at 3
      // to limit the number of simultaneous oscillators (CPU budget).
      const v: Voice = isMelody
        ? voice
        : { ...voice, release: Math.min(voice.release, 0.08), polyphony: Math.min(voice.polyphony ?? 4, 3) };

      const pool = new VoicePool(
        v.polyphony ?? 4,
        v,
        isMelody ? this.#reverb! : dest,
      );
      this.#pools.push(pool);

      const part = new Tone.Part<SongNote>((time, note) => {
        const dur = isMelody ? note.duration : Math.min(note.duration, 0.4);
        pool.trigger(Tone.Frequency(note.midi, "midi").toFrequency(), dur, time);
      }, notes as unknown as SongNote[]);
      part.start(START_DELAY);
      this.#parts.push(part);
    };

    // Four shared drum synths — pre-allocated once, dispatched by GM note number.
    // NoiseSynth (~2 Web Audio nodes) replaces MetalSynth (~18 nodes) for
    // snare/hihat/cymbal to keep the audio-thread node count manageable.
    const kick = new Tone.MembraneSynth({
      pitchDecay: 0.05, octaves: 6, volume: -10,
      envelope: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.1 },
    }).toDestination();
    const snare = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.14, sustain: 0, release: 0.01 },
      volume: -14,
    }).toDestination();
    const hihat = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.01 },
      volume: -22,
    }).toDestination();
    const cymbal = new Tone.NoiseSynth({
      noise: { type: "white" },
      envelope: { attack: 0.001, decay: 0.35, sustain: 0, release: 0.05 },
      volume: -24,
    }).toDestination();
    this.#drumSynths = [kick, snare, hihat, cymbal];

    const addDrumTrack = (notes: SongNote[], trackName: string) => {
      const part = new Tone.Part<SongNote>((time, note) => {
        const m = note.midi;
        if      (m === 35 || m === 36 || trackName === "Kick Drum" || trackName === "Bass drum")
          kick.triggerAttackRelease("C1", "8n", time);
        else if (m === 38 || m === 40 || trackName === "Snare")
          snare.triggerAttackRelease("8n", time);
        else if ((m >= 42 && m <= 46) || trackName === "Closed HiHat" || trackName === "Maracas")
          hihat.triggerAttackRelease("8n", time);
        else
          cymbal.triggerAttackRelease("8n", time);
      }, notes as unknown as SongNote[]);
      part.start(START_DELAY);
      this.#parts.push(part);
    };

    addMelodicTrack(song.melody, VOICES[song.melodyName] ?? DEFAULT_VOICE, true);

    for (const track of song.backing) {
      if (track.isDrum) {
        addDrumTrack(track.notes, track.name);
      } else {
        addMelodicTrack(track.notes, VOICES[track.name] ?? DEFAULT_VOICE, false);
      }
    }
  }

  #teardownAudio() {
    for (const part of this.#parts) part.dispose();
    for (const pool of this.#pools) pool.dispose();
    for (const s    of this.#drumSynths) { s.disconnect(); s.dispose(); }
    this.#parts     = [];
    this.#pools     = [];
    this.#drumSynths = [];
    this.#reverb?.dispose();
    this.#reverb = null;
  }

  // -------------------------------------------------------------------------
  // Render loop
  // -------------------------------------------------------------------------

  #draw = () => {
    if (!this.#isRunning || !this.#parsedSong) return;
    this.#rafId = requestAnimationFrame(this.#draw);

    const { melody, songDuration, midiMin, midiMax } = this.#parsedSong;
    const songTime = Tone.getTransport().seconds - START_DELAY;
    const { width, height } = this.#canvas;
    const hitX      = width * HIT_LINE_RATIO;
    const pixPerSec = (width - hitX) / LOOKAHEAD;

    // Background
    this.#ctx.fillStyle = "#0b0b0b";
    this.#ctx.fillRect(0, 0, width, height);

    this.#drawGrid(hitX, width, height, midiMin, midiMax);

    for (const note of melody) {
      this.#drawNote(note, songTime, hitX, pixPerSec, height, midiMin, midiMax);
    }

    // Hit line
    this.#ctx.strokeStyle = "rgba(255,255,255,0.2)";
    this.#ctx.lineWidth   = 1;
    this.#ctx.setLineDash([5, 5]);
    this.#ctx.beginPath();
    this.#ctx.moveTo(hitX, 0);
    this.#ctx.lineTo(hitX, height);
    this.#ctx.stroke();
    this.#ctx.setLineDash([]);

    this.#drawCursor(hitX, height, midiMin, midiMax);

    // Countdown
    if (songTime < 0) {
      const n = Math.ceil(-songTime);
      this.#ctx.fillStyle    = "rgba(255,255,255,0.75)";
      this.#ctx.font         = `bold ${Math.round(height * 0.45)}px 'Courier New'`;
      this.#ctx.textAlign    = "center";
      this.#ctx.textBaseline = "middle";
      this.#ctx.fillText(String(n), hitX, height / 2);
      this.#ctx.textAlign    = "left";
      this.#ctx.textBaseline = "alphabetic";
    }

    // Live score
    this.#ctx.fillStyle = "rgba(255,255,255,0.5)";
    this.#ctx.font      = "11px 'Courier New'";
    this.#ctx.fillText(`${this.scorePct}%`, width - 36, 15);

    if (songTime >= songDuration + 2) {
      this.stop();
      this.#drawFinalScore();
    }
  };

  // -------------------------------------------------------------------------
  // Drawing helpers
  // -------------------------------------------------------------------------

  #midiToY(midi: number, height: number, midiMin: number, midiMax: number): number {
    const pad = height * 0.08;
    const t   = (midi - midiMin) / (midiMax - midiMin);
    return height - pad - t * (height - 2 * pad);
  }

  #drawGrid(hitX: number, width: number, height: number, midiMin: number, midiMax: number) {
    this.#ctx.strokeStyle = "rgba(255,255,255,0.04)";
    this.#ctx.lineWidth   = 1;
    for (let midi = midiMin; midi <= midiMax; midi++) {
      const y = this.#midiToY(midi, height, midiMin, midiMax);
      this.#ctx.beginPath();
      this.#ctx.moveTo(0,     y);
      this.#ctx.lineTo(width, y);
      this.#ctx.stroke();
    }
    // Highlight E notes (tonic of E major / E4 = midi 64)
    this.#ctx.strokeStyle = "rgba(255,255,255,0.1)";
    for (let midi = midiMin; midi <= midiMax; midi++) {
      if (midi % 12 === 4) {
        const y = this.#midiToY(midi, height, midiMin, midiMax);
        this.#ctx.beginPath();
        this.#ctx.moveTo(hitX, y);
        this.#ctx.lineTo(width, y);
        this.#ctx.stroke();
      }
    }
  }

  #drawNote(
    note: SongNote, songTime: number,
    hitX: number, pixPerSec: number, height: number,
    midiMin: number, midiMax: number,
  ) {
    const xStart = hitX + (note.time - songTime) * pixPerSec;
    const xEnd   = hitX + (note.time + note.duration - songTime) * pixPerSec;
    if (xEnd < 0 || xStart > this.#canvas.width) return;

    const y      = this.#midiToY(note.midi, height, midiMin, midiMax);
    const noteW  = Math.max(4, xEnd - xStart);
    const isActive = note.time <= songTime
                  && songTime  <= note.time + note.duration
                  && songTime  >= 0;

    let color: string;
    if (isActive) {
      const { freq, gain } = this.#getPlayerState();
      const playerMidi = 12 * Math.log2(freq / 440) + 69;
      const hitting    = Math.abs(playerMidi - note.midi) <= TOLERANCE
                      && gain > MIN_GAIN_TO_PLAY;
      color = hitting ? "#00ff88" : "#ff4444";
      this.#totalFrames++;
      if (hitting) this.#hitFrames++;
      this.#ctx.shadowColor = color;
      this.#ctx.shadowBlur  = 14;
    } else if (xEnd < hitX) {
      color = "rgba(255,255,255,0.12)";
    } else {
      color = "rgba(255,255,255,0.6)";
    }

    this.#ctx.fillStyle = color;
    this.#ctx.beginPath();
    this.#ctx.roundRect(Math.max(0, xStart), y - NOTE_HEIGHT / 2, noteW, NOTE_HEIGHT, 4);
    this.#ctx.fill();
    this.#ctx.shadowBlur = 0;
  }

  #drawCursor(hitX: number, height: number, midiMin: number, midiMax: number) {
    const { freq, gain } = this.#getPlayerState();
    if (gain < MIN_GAIN_TO_PLAY) return;

    const playerMidi  = 12 * Math.log2(freq / 440) + 69;
    const clampedMidi = Math.max(midiMin - 2, Math.min(midiMax + 2, playerMidi));
    const cursorY     = this.#midiToY(clampedMidi, height, midiMin, midiMax);

    this.#ctx.strokeStyle = "rgba(0, 255, 136, 0.85)";
    this.#ctx.lineWidth   = 2;
    this.#ctx.shadowColor = "#00ff88";
    this.#ctx.shadowBlur  = 8;
    this.#ctx.beginPath();
    this.#ctx.moveTo(0,         cursorY);
    this.#ctx.lineTo(hitX + 24, cursorY);
    this.#ctx.stroke();

    this.#ctx.fillStyle = "#00ff88";
    this.#ctx.beginPath();
    this.#ctx.arc(hitX, cursorY, 5, 0, Math.PI * 2);
    this.#ctx.fill();
    this.#ctx.shadowBlur = 0;
  }

  #drawFinalScore() {
    const { width, height } = this.#canvas;
    const pct = this.scorePct;

    this.#ctx.fillStyle = "rgba(0,0,0,0.72)";
    this.#ctx.fillRect(0, 0, width, height);

    this.#ctx.textAlign    = "center";
    this.#ctx.textBaseline = "middle";

    this.#ctx.fillStyle = "rgba(255,255,255,0.45)";
    this.#ctx.font      = `${Math.round(height * 0.13)}px 'Courier New'`;
    this.#ctx.fillText("final score", width / 2, height * 0.35);

    this.#ctx.fillStyle = "#00ff88";
    this.#ctx.font      = `bold ${Math.round(height * 0.32)}px 'Courier New'`;
    this.#ctx.fillText(`${pct}%`, width / 2, height * 0.62);

    this.#ctx.textAlign    = "left";
    this.#ctx.textBaseline = "alphabetic";
  }
}
