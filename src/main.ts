import { HandLandmarker, FilesetResolver } from "@mediapipe/tasks-vision";
import type { NormalizedLandmark } from "@mediapipe/tasks-vision";
import * as Tone from "tone";
import { Game } from "./game";
import { SONGS } from "./song";
import { PITCH_COLOR, VOLUME_COLOR, BG_DEEP } from "./tokens";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const WASM_CDN  = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const MIN_FREQ      = 110;  // A2
const MAX_FREQ      = 1760; // A6
const INDEX_TIP     = 8;
const WRIST         = 0;
const SMOOTH        = 0.14;
const VIBRATO_SMOOTH = 0.08;
const WRIST_HISTORY = 20;

const SCALES: Record<string, number[]> = {
  chromatic:        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  major:            [0, 2, 4, 5, 7, 9, 11],
  minor:            [0, 2, 3, 5, 7, 8, 10],
  pentatonic_major: [0, 2, 4, 7, 9],
  pentatonic_minor: [0, 3, 5, 7, 10],
  blues:            [0, 3, 5, 6, 7, 10],
};

const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [0, 9], [9, 10], [10, 11], [11, 12],
  [0, 13], [13, 14], [14, 15], [15, 16],
  [0, 17], [17, 18], [18, 19], [19, 20],
  [5, 9], [9, 13], [13, 17],
];

const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

type BasicWaveform = "sine" | "triangle" | "sawtooth" | "square";

const lerpLog = (t: number) => MIN_FREQ * Math.pow(MAX_FREQ / MIN_FREQ, t);

const freqToNote = (freq: number): string => {
  const midi    = Math.round(12 * Math.log2(freq / 440) + 69);
  const clamped = Math.max(0, Math.min(127, midi));
  return `${NOTE_NAMES[clamped % 12]}${Math.floor(clamped / 12) - 1}`;
};

/**
 * Snap a frequency to the nearest degree of the given scale.
 * Applied to the target before EMA smoothing so notes glide into place.
 */
const quantize = (freq: number, scale: number[]): number => {
  const midiFloat  = 12 * Math.log2(freq / 440) + 69;
  const octaveBase = Math.floor(midiFloat / 12) * 12;

  let bestMidi = octaveBase + scale[0];
  let bestDist = Infinity;

  for (let oct = -1; oct <= 1; oct++) {
    for (const degree of scale) {
      const candidate = octaveBase + oct * 12 + degree;
      const dist = Math.abs(midiFloat - candidate);
      if (dist < bestDist) { bestDist = dist; bestMidi = candidate; }
    }
  }

  return 440 * Math.pow(2, (bestMidi - 69) / 12);
};

/**
 * Right hand X → pitch.
 * rawX ≈ 0 = LEFT of raw frame = RIGHT in mirrored selfie view.
 * Right of screen → low rawX → high frequency.
 */
const pitchFromRawX = (rawX: number) => lerpLog(1 - rawX);

/**
 * Left hand Y → volume.
 * rawY = 0 at top; hand raised = loud.
 * Usable range clamped to [0.15, 0.75].
 */
const gainFromRawY = (rawY: number): number => {
  const t = (rawY - 0.15) / (0.75 - 0.15);
  return Math.max(0, Math.min(1, 1 - t));
};

// ---------------------------------------------------------------------------
// Theremin class
// ---------------------------------------------------------------------------

class Theremin {
  // DOM
  readonly #video:          HTMLVideoElement;
  readonly #canvas:         HTMLCanvasElement;
  readonly #ctx:            CanvasRenderingContext2D;
  readonly #startBtn:       HTMLButtonElement;
  readonly #statusEl:       HTMLParagraphElement;
  readonly #pitchDisplay:   HTMLSpanElement;
  readonly #volumeBar:      HTMLDivElement;
  readonly #waveBtns:       NodeListOf<HTMLButtonElement>;
  readonly #quantizeBtn:    HTMLButtonElement;
  readonly #scaleSelect:    HTMLSelectElement;
  readonly #sustainBtn:     HTMLButtonElement;
  readonly #gameBtn:        HTMLButtonElement;
  readonly #songSelect:     HTMLSelectElement;
  readonly #waveformCanvas: HTMLCanvasElement;
  readonly #waveformCtx:    CanvasRenderingContext2D;

  // Game
  #game: Game;

  // MediaPipe
  #landmarker:    HandLandmarker | null = null;

  // Audio nodes
  #oscillator:  Tone.Oscillator | null = null;
  #vibratoNode: Tone.Vibrato    | null = null;
  #gain:        Tone.Gain       | null = null;
  #analyser:    Tone.Analyser   | null = null;

  // Playback state
  #isPlaying    = false;
  #rafId:         number | null = null;
  #lastVideoTime = -1;

  // Smoothed audio parameters
  #smoothFreq    = 440;
  #smoothGain    = 0;
  #smoothVibrato = 0;
  #lastGain      = 0;
  #wristYHistory: number[] = [];

  // Options
  #waveform:        BasicWaveform = "sine";
  #quantizeEnabled  = false;
  #sustainEnabled   = false;

  constructor() {
    this.#video        = document.getElementById("video")         as HTMLVideoElement;
    this.#canvas       = document.getElementById("canvas")        as HTMLCanvasElement;
    this.#ctx          = this.#canvas.getContext("2d")!;
    this.#startBtn     = document.getElementById("start-btn")     as HTMLButtonElement;
    this.#statusEl     = document.getElementById("status")        as HTMLParagraphElement;
    this.#pitchDisplay = document.getElementById("pitch-display") as HTMLSpanElement;
    this.#volumeBar    = document.getElementById("volume-bar")    as HTMLDivElement;
    this.#waveBtns     = document.querySelectorAll<HTMLButtonElement>(".wave-btn");
    this.#quantizeBtn  = document.getElementById("quantize-btn")  as HTMLButtonElement;
    this.#scaleSelect  = document.getElementById("scale-select")  as HTMLSelectElement;
    this.#sustainBtn   = document.getElementById("sustain-btn")   as HTMLButtonElement;
    this.#gameBtn        = document.getElementById("game-btn")      as HTMLButtonElement;
    this.#songSelect     = document.getElementById("song-select")   as HTMLSelectElement;
    this.#waveformCanvas = document.getElementById("waveform")      as HTMLCanvasElement;
    this.#waveformCtx    = this.#waveformCanvas.getContext("2d")!;

    // Populate song dropdown from catalogue
    SONGS.forEach((s, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = s.title;
      this.#songSelect.appendChild(opt);
    });

    this.#game = new Game(
      document.getElementById("game-canvas") as HTMLCanvasElement,
      () => ({ freq: this.#smoothFreq, gain: this.#smoothGain }),
    );

    this.#bindEvents();
  }

  // -------------------------------------------------------------------------
  // Public entry point
  // -------------------------------------------------------------------------

  async init() {
    this.#statusEl.textContent = "Requesting camera…";

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: 640, height: 480, facingMode: "user" },
      });
      this.#video.srcObject = stream;
      await this.#waitForVideo();
    } catch {
      this.#statusEl.textContent = "Camera access denied. Please allow camera and reload.";
      return;
    }

    this.#statusEl.textContent = "Loading hand tracking model…";

    try {
      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      this.#landmarker = await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 2,
      });
    } catch (err) {
      this.#statusEl.textContent = `Failed to load model: ${(err as Error).message}`;
      return;
    }

    this.#statusEl.textContent = "Ready — raise hands to play";
    this.#startBtn.disabled = false;

    this.#waveformCanvas.width  = this.#waveformCanvas.offsetWidth;
    this.#waveformCanvas.height = this.#waveformCanvas.offsetHeight;
    this.#drawIdleWaveform();
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  #bindEvents() {
    this.#startBtn.addEventListener("click", () => {
      if (this.#isPlaying) this.#stop(); else this.#start();
    });

    this.#waveBtns.forEach((btn) => {
      btn.addEventListener("click", () => {
        this.#waveBtns.forEach((b) => b.classList.remove("active"));
        btn.classList.add("active");
        this.#waveform = btn.dataset.wave as BasicWaveform;
        if (this.#oscillator) this.#oscillator.type = this.#waveform;
      });
    });

    this.#quantizeBtn.addEventListener("click", () => {
      this.#quantizeEnabled = !this.#quantizeEnabled;
      this.#quantizeBtn.textContent = this.#quantizeEnabled ? "on" : "off";
      this.#quantizeBtn.classList.toggle("on", this.#quantizeEnabled);
      this.#scaleSelect.disabled = !this.#quantizeEnabled;
    });

    this.#sustainBtn.addEventListener("click", () => {
      this.#sustainEnabled = !this.#sustainEnabled;
      this.#sustainBtn.textContent = this.#sustainEnabled ? "on" : "off";
      this.#sustainBtn.classList.toggle("on", this.#sustainEnabled);
    });

    this.#songSelect.addEventListener("change", () => {
      const config = SONGS[Number(this.#songSelect.value)];
      if (config) this.#game.setSong(config);
    });

    this.#gameBtn.addEventListener("click", async () => {
      if (this.#game.isRunning) {
        this.#game.stop();
        this.#gameBtn.textContent = "Play";
        this.#gameBtn.classList.remove("playing");
        this.#songSelect.disabled = false;
      } else {
        await Tone.start();
        this.#songSelect.disabled = true;
        this.#game.start();
        this.#gameBtn.textContent = "Stop";
        this.#gameBtn.classList.add("playing");
      }
    });
  }

  // -------------------------------------------------------------------------
  // Audio lifecycle
  // -------------------------------------------------------------------------

  #startAudio() {
    this.#gain        = new Tone.Gain(0).toDestination();
    this.#analyser    = new Tone.Analyser("waveform", 1024);
    this.#gain.connect(this.#analyser);
    this.#vibratoNode = new Tone.Vibrato({ frequency: 5.5, depth: 0, wet: 1 });
    this.#vibratoNode.connect(this.#gain);
    this.#oscillator  = new Tone.Oscillator(440, this.#waveform);
    this.#oscillator.connect(this.#vibratoNode);
    this.#oscillator.start();
  }

  #stopAudio() {
    this.#oscillator?.stop();
    this.#oscillator?.dispose();
    this.#vibratoNode?.dispose();
    this.#gain?.dispose();
    this.#analyser?.dispose();
    this.#oscillator  = null;
    this.#vibratoNode = null;
    this.#gain        = null;
    this.#analyser    = null;
    this.#drawIdleWaveform();
  }

  // -------------------------------------------------------------------------
  // Playback control
  // -------------------------------------------------------------------------

  async #start() {
    await Tone.start();
    this.#startAudio();
    this.#isPlaying    = true;
    this.#smoothFreq   = 440;
    this.#smoothGain   = 0;
    this.#lastGain     = 0;
    this.#startBtn.textContent = "Stop";
    this.#startBtn.classList.add("playing");
    this.#renderLoop();
  }

  #stop() {
    this.#isPlaying = false;
    if (this.#rafId !== null) { cancelAnimationFrame(this.#rafId); this.#rafId = null; }
    this.#stopAudio();
    this.#startBtn.textContent = "Start";
    this.#startBtn.classList.remove("playing");
    this.#pitchDisplay.textContent = "—";
    this.#volumeBar.style.width    = "0%";
    this.#ctx.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
  }

  // -------------------------------------------------------------------------
  // Render / detection loop (arrow property preserves `this` in rAF callback)
  // -------------------------------------------------------------------------

  #renderLoop = () => {
    if (!this.#isPlaying || !this.#landmarker) return;
    this.#rafId = requestAnimationFrame(this.#renderLoop);

    if (this.#video.currentTime === this.#lastVideoTime) return;
    this.#lastVideoTime = this.#video.currentTime;

    const result = this.#landmarker.detectForVideo(this.#video, performance.now());

    // Draw mirrored video frame
    const { width, height } = this.#canvas;
    this.#ctx.save();
    this.#ctx.translate(width, 0);
    this.#ctx.scale(-1, 1);
    this.#ctx.drawImage(this.#video, 0, 0, width, height);
    this.#ctx.restore();

    // Separate hands by handedness (labels from the person's perspective)
    let rightHand: NormalizedLandmark[] | null = null;
    let leftHand:  NormalizedLandmark[] | null = null;

    for (let i = 0; i < result.handednesses.length; i++) {
      const label = result.handednesses[i][0].categoryName;
      if (label === "Right") rightHand = result.landmarks[i];
      else                   leftHand  = result.landmarks[i];
    }

    // --- Pitch ---
    let targetFreq = this.#smoothFreq;

    if (rightHand) {
      targetFreq = pitchFromRawX(rightHand[INDEX_TIP].x);
      if (this.#quantizeEnabled) targetFreq = quantize(targetFreq, SCALES[this.#scaleSelect.value]);
      this.#drawHand(rightHand, PITCH_COLOR);

      this.#wristYHistory.push(rightHand[WRIST].y);
      if (this.#wristYHistory.length > WRIST_HISTORY) this.#wristYHistory.shift();
    } else {
      this.#wristYHistory.length = 0;
    }

    // --- Vibrato depth from wrist oscillation RMS ---
    let targetVibrato = 0;

    if (this.#wristYHistory.length >= 2) {
      const sumSq = this.#wristYHistory.reduce((acc, y, i) => {
        if (i === 0) return acc;
        const dy = y - this.#wristYHistory[i - 1];
        return acc + dy * dy;
      }, 0);
      const rms = Math.sqrt(sumSq / (this.#wristYHistory.length - 1));
      targetVibrato = Math.min(1, rms * 25);
    }

    // --- Volume ---
    let targetGain: number;

    if (leftHand || rightHand) {
      const controlHand = leftHand ?? rightHand!;
      targetGain     = gainFromRawY(controlHand[INDEX_TIP].y);
      this.#lastGain = targetGain;
      if (leftHand) this.#drawHand(leftHand, VOLUME_COLOR);
    } else {
      targetGain = this.#sustainEnabled ? this.#lastGain : 0;
    }

    // --- EMA smoothing ---
    this.#smoothFreq    += (targetFreq    - this.#smoothFreq)    * SMOOTH;
    this.#smoothGain    += (targetGain    - this.#smoothGain)    * SMOOTH;
    this.#smoothVibrato += (targetVibrato - this.#smoothVibrato) * VIBRATO_SMOOTH;

    // --- Apply to audio ---
    if (this.#oscillator)  this.#oscillator.frequency.value = this.#smoothFreq;
    if (this.#gain)        this.#gain.gain.value             = this.#smoothGain;
    if (this.#vibratoNode) this.#vibratoNode.depth.value     = this.#smoothVibrato;

    // --- Update HUD ---
    this.#pitchDisplay.textContent = `${Math.round(this.#smoothFreq)} Hz  ${freqToNote(this.#smoothFreq)}`;
    this.#volumeBar.style.width    = `${Math.round(this.#smoothGain * 100)}%`;

    this.#drawWaveform();
  };

  // -------------------------------------------------------------------------
  // Canvas helpers
  // -------------------------------------------------------------------------

  #drawHand(landmarks: NormalizedLandmark[], color: string) {
    const { width, height } = this.#canvas;
    const toX = (rawX: number) => (1 - rawX) * width;
    const toY = (rawY: number) => rawY * height;

    this.#ctx.strokeStyle = color;
    this.#ctx.fillStyle   = color;
    this.#ctx.lineWidth   = 2;
    this.#ctx.globalAlpha = 0.85;

    for (const [a, b] of CONNECTIONS) {
      this.#ctx.beginPath();
      this.#ctx.moveTo(toX(landmarks[a].x), toY(landmarks[a].y));
      this.#ctx.lineTo(toX(landmarks[b].x), toY(landmarks[b].y));
      this.#ctx.stroke();
    }
    for (const lm of landmarks) {
      this.#ctx.beginPath();
      this.#ctx.arc(toX(lm.x), toY(lm.y), 4, 0, Math.PI * 2);
      this.#ctx.fill();
    }

    this.#ctx.globalAlpha = 1;
  }

  // -------------------------------------------------------------------------
  // Waveform visualizer
  // -------------------------------------------------------------------------

  #drawWaveform() {
    if (!this.#analyser) return;

    const data   = this.#analyser.getValue() as Float32Array;
    const canvas = this.#waveformCanvas;
    const ctx    = this.#waveformCtx;
    const { width, height } = canvas;
    const mid    = height / 2;

    ctx.fillStyle = BG_DEEP;
    ctx.fillRect(0, 0, width, height);

    // Color and glow track the pitch color (green) when audible, dim when silent
    const audible = this.#smoothGain > 0.01;
    ctx.strokeStyle = audible ? PITCH_COLOR : `color-mix(in srgb, ${PITCH_COLOR} 18%, transparent)`;
    ctx.lineWidth   = 1.5;
    ctx.shadowColor = PITCH_COLOR;
    ctx.shadowBlur  = audible ? 6 : 0;

    ctx.beginPath();
    const step = width / (data.length - 1);
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = mid - data[i] * mid * 0.85;  // scale so peaks don't clip edges
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  #drawIdleWaveform() {
    const ctx    = this.#waveformCtx;
    const { width, height } = this.#waveformCanvas;

    ctx.fillStyle   = BG_DEEP;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = `color-mix(in srgb, ${PITCH_COLOR} 18%, transparent)`;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0,     height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();
  }

  // -------------------------------------------------------------------------
  // Setup helpers
  // -------------------------------------------------------------------------

  #waitForVideo(): Promise<void> {
    return new Promise((resolve) => {
      this.#video.onloadedmetadata = () => {
        this.#video.play();
        this.#canvas.width  = this.#video.videoWidth;
        this.#canvas.height = this.#video.videoHeight;
        resolve();
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

new Theremin().init();
