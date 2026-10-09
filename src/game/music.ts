/**
 * Synthesized background music — Web Audio oscillators only, no samples.
 * A lookahead scheduler (Chris Wilson's "A Tale of Two Clocks" pattern): a 25 ms timer schedules
 * every note that falls within the next ~150 ms on the AudioContext clock, so timing stays tight
 * even when the main thread is busy rendering.
 */
export type TrackId = "over" | "dungeon" | "boss";

interface Note {
  step: number;
  midi: number;
  len: number;
}
interface Voice {
  notes: Note[];
  wave: OscillatorType;
  vol: number;
  /** send to the echo bus */
  echo?: number;
  /** lowpass cutoff (Hz) */
  cutoff?: number;
  attack?: number;
  release?: number;
  detune?: number;
}
interface Track {
  bpm: number;
  steps: number; // 16th notes per loop
  voices: Voice[];
  drums: string; // one char per 16th: k=kick s=snare h=hat t=tick .=rest (looped)
  drumVol: number;
}

const NOTE: Record<string, number> = { C: 0, "C#": 1, Db: 1, D: 2, "D#": 3, Eb: 3, E: 4, F: 5, "F#": 6, Gb: 6, G: 7, "G#": 8, Ab: 8, A: 9, "A#": 10, Bb: 10, B: 11 };
function midiOf(name: string): number {
  const m = /^([A-G][#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error("bad note " + name);
  return 12 * (parseInt(m[2]) + 1) + NOTE[m[1]];
}
/** "A4:2 D5:2 r:4 …" → notes (lengths in 16ths) */
function seq(src: string): Note[] {
  const out: Note[] = [];
  let step = 0;
  for (const tok of src.trim().split(/\s+/)) {
    const [n, l] = tok.split(":");
    const len = parseInt(l);
    if (n !== "r") out.push({ step, midi: midiOf(n), len });
    step += len;
  }
  return out;
}
/** chord roots per bar → steady pattern of notes (e.g. bass or arpeggio) */
function pattern(chords: string[][], offsets: number[], len: number): Note[] {
  const out: Note[] = [];
  chords.forEach((tones, bar) => {
    offsets.forEach((ti, i) => {
      if (ti < 0) return;
      out.push({ step: bar * 16 + i * len, midi: midiOf(tones[ti % tones.length]), len });
    });
  });
  return out;
}
const freq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

// ───────────── Track 1: "Hearthollow Air" — bright, pastoral, D major ─────────────
const OVER: Track = {
  bpm: 112,
  steps: 128,
  drumVol: 0.05,
  drums: "k.h.t.h.k.h.t.h.",
  voices: [
    {
      wave: "triangle",
      vol: 0.16,
      echo: 0.15,
      release: 0.12,
      notes: seq(`A4:2 D5:2 F#5:4 E5:2 D5:2 E5:4
                  G5:4 F#5:2 E5:2 D5:4 B4:4
                  F#5:6 E5:2 D5:4 C#5:4
                  E5:8 r:4 A4:2 C#5:2
                  D5:2 F#5:2 A5:4 G5:2 F#5:2 E5:4
                  D5:2 E5:2 G5:4 B5:4 A5:4
                  G5:4 F#5:2 E5:2 D5:4 E5:4
                  C#5:4 E5:4 D5:8`),
    },
    {
      wave: "square",
      vol: 0.035,
      cutoff: 1800,
      notes: pattern(
        [["D4", "F#4", "A4"], ["G4", "B4", "D5"], ["B3", "D4", "F#4"], ["A3", "C#4", "E4"], ["D4", "F#4", "A4"], ["G4", "B4", "D5"], ["E4", "G4", "B4"], ["A3", "C#4", "E4"]],
        [0, 1, 2, 1, 0, 1, 2, 1],
        2,
      ),
    },
    {
      wave: "triangle",
      vol: 0.2,
      notes: pattern([["D2", "A2"], ["G2", "D3"], ["B1", "F#2"], ["A1", "E2"], ["D2", "A2"], ["G2", "D3"], ["E2", "B2"], ["A1", "E2"]], [0, 1, 0, 1], 4),
    },
  ],
};

// ───────────── Track 2: "Mossgrave Echoes" — moody, sparse, A minor, lots of echo ─────────────
const DUNGEON: Track = {
  bpm: 70,
  steps: 128,
  drumVol: 0.06,
  drums: "k.......t.....t.",
  voices: [
    {
      wave: "sine",
      vol: 0.16,
      echo: 0.6,
      attack: 0.005,
      release: 0.5,
      notes: seq(`E5:4 r:4 C5:4 B4:4
                  A4:8 r:8
                  D5:4 r:2 F5:2 E5:4 D5:4
                  B4:8 G#4:8
                  E5:4 r:4 A5:4 G5:4
                  F5:8 E5:4 C5:4
                  D5:6 C5:2 B4:4 A4:4
                  G#4:8 r:8`),
    },
    {
      wave: "sine",
      vol: 0.13,
      attack: 0.6,
      release: 0.8,
      notes: pattern([["A2"], ["F2"], ["D2"], ["E2"], ["A2"], ["F2"], ["D2"], ["E2"]], [0], 16),
    },
    {
      wave: "triangle",
      vol: 0.04,
      echo: 0.4,
      attack: 0.3,
      release: 0.6,
      detune: 7,
      notes: pattern([["A3", "C4", "E4"], ["F3", "A3", "C4"], ["D3", "F3", "A3"], ["E3", "G#3", "B3"], ["A3", "C4", "E4"], ["F3", "A3", "C4"], ["D3", "F3", "A3"], ["E3", "G#3", "B3"]], [0, -1, 1, -1, 2, -1, 1, -1], 2),
    },
  ],
};

// ───────────── Track 3: "Warden's Wrath" — tense, driving, E minor ─────────────
const BOSS: Track = {
  bpm: 152,
  steps: 128,
  drumVol: 0.11,
  drums: "k.hhs.hhk.hks.hh",
  voices: [
    {
      wave: "square",
      vol: 0.075,
      cutoff: 3200,
      echo: 0.1,
      release: 0.06,
      notes: seq(`E5:2 r:1 E5:1 G5:2 r:2 F#5:2 E5:2 D5:2 B4:2
                  C5:2 r:1 C5:1 E5:2 r:2 G5:4 F#5:4
                  D5:2 r:1 D5:1 F#5:2 r:2 A5:2 G5:2 F#5:2 D5:2
                  D#5:4 F#5:4 B5:6 r:2
                  E5:2 r:1 E5:1 G5:2 r:2 B5:2 A5:2 G5:2 E5:2
                  C6:2 r:1 B5:1 A5:2 r:2 G5:4 E5:4
                  D5:2 r:1 F#5:1 A5:2 r:2 D6:2 C6:2 A5:2 F#5:2
                  B5:2 A5:2 G5:2 F#5:2 D#5:4 B4:4`),
    },
    {
      wave: "sawtooth",
      vol: 0.09,
      cutoff: 700,
      release: 0.04,
      notes: pattern(
        [["E2", "E3"], ["C2", "C3"], ["D2", "D3"], ["B1", "B2"], ["E2", "E3"], ["C2", "C3"], ["D2", "D3"], ["B1", "B2"]],
        [0, 0, 1, 0, 0, 1, 0, 1],
        2,
      ),
    },
    {
      wave: "square",
      vol: 0.025,
      cutoff: 2000,
      notes: pattern([["E4", "G4", "B4"], ["C4", "E4", "G4"], ["D4", "F#4", "A4"], ["B3", "D#4", "F#4"], ["E4", "G4", "B4"], ["C4", "E4", "G4"], ["D4", "F#4", "A4"], ["B3", "D#4", "F#4"]], [0, 1, 2, 1, 0, 1, 2, 1], 2),
    },
  ],
};

const TRACKS: Record<TrackId, Track> = { over: OVER, dungeon: DUNGEON, boss: BOSS };

interface Playing {
  gain: GainNode;
  step: number;
  next: number;
  active: boolean;
  stopAt: number;
}

export class Music {
  private bus: GainNode;
  private echoIn: GainNode;
  private playing = new Map<TrackId, Playing>();
  private current: TrackId | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private noise: AudioBuffer;
  private readonly LOOKAHEAD = 0.15;

  constructor(private ctx: AudioContext, dest: AudioNode) {
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.55; // music sits under the SFX
    this.bus.connect(dest);
    // feedback echo bus
    this.echoIn = ctx.createGain();
    const delay = ctx.createDelay(1.5);
    delay.delayTime.value = 0.32;
    const fb = ctx.createGain();
    fb.gain.value = 0.42;
    const damp = ctx.createBiquadFilter();
    damp.type = "lowpass";
    damp.frequency.value = 2200;
    this.echoIn.connect(delay);
    delay.connect(damp).connect(fb).connect(delay);
    damp.connect(this.bus);
    const len = ctx.sampleRate * 0.5;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  get track() {
    return this.current;
  }

  /** Crossfade to a track (or silence with null). */
  play(id: TrackId | null, fade = 1.5) {
    if (id === this.current) return;
    const now = this.ctx.currentTime;
    if (this.current) {
      const p = this.playing.get(this.current);
      if (p) {
        p.gain.gain.cancelScheduledValues(now);
        p.gain.gain.setValueAtTime(p.gain.gain.value, now);
        p.gain.gain.linearRampToValueAtTime(0, now + fade);
        p.stopAt = now + fade + 0.1;
      }
    }
    this.current = id;
    if (!id) return;
    let p = this.playing.get(id);
    if (!p || !p.active) {
      const gain = p?.gain ?? this.ctx.createGain();
      if (!p) gain.connect(this.bus);
      gain.gain.cancelScheduledValues(now);
      gain.gain.setValueAtTime(0, now);
      p = { gain, step: 0, next: now + 0.08, active: true, stopAt: Infinity };
      this.playing.set(id, p);
    }
    p.stopAt = Infinity;
    p.gain.gain.cancelScheduledValues(now);
    p.gain.gain.setValueAtTime(p.gain.gain.value, now);
    p.gain.gain.linearRampToValueAtTime(1, now + fade * 0.8);
  }

  /** A short major-key sting (e.g. boss defeated) played over whatever is fading. */
  sting(notes = [64, 68, 71, 76], step = 0.12) {
    const t0 = this.ctx.currentTime + 0.05;
    notes.forEach((m, i) => this.note(this.bus, "square", m, t0 + i * step, step * (i === notes.length - 1 ? 6 : 1.4), 0.09, 0.005, 0.2, 2400));
  }

  private schedule() {
    const now = this.ctx.currentTime;
    for (const [id, p] of this.playing) {
      if (!p.active) continue;
      if (now > p.stopAt) {
        p.active = false;
        continue;
      }
      const tr = TRACKS[id];
      const stepDur = 60 / tr.bpm / 4;
      if (p.next < now - 0.2) p.next = now + 0.02; // tab was asleep: resync instead of bursting
      while (p.next < now + this.LOOKAHEAD) {
        this.playStep(tr, p, p.step, p.next, stepDur);
        p.next += stepDur;
        p.step = (p.step + 1) % tr.steps;
      }
    }
  }

  private playStep(tr: Track, p: Playing, step: number, t: number, stepDur: number) {
    for (const v of tr.voices)
      for (const n of v.notes)
        if (n.step === step) {
          const dur = n.len * stepDur;
          this.note(p.gain, v.wave, n.midi, t, dur, v.vol, v.attack ?? 0.01, v.release ?? 0.08, v.cutoff, v.echo, v.detune);
        }
    const c = tr.drums[step % tr.drums.length];
    if (c === "k") this.kick(p.gain, t, tr.drumVol * 2.2);
    else if (c === "s") this.hit(p.gain, t, tr.drumVol * 1.4, 1800, 0.12, "bandpass");
    else if (c === "h") this.hit(p.gain, t, tr.drumVol * 0.6, 8000, 0.04, "highpass");
    else if (c === "t") this.hit(p.gain, t, tr.drumVol * 0.5, 5000, 0.03, "highpass");
  }

  private note(dest: AudioNode, wave: OscillatorType, midi: number, t: number, dur: number, vol: number, attack: number, release: number, cutoff?: number, echo?: number, detune?: number) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = wave;
    o.frequency.value = freq(midi);
    if (detune) o.detune.value = detune;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + attack);
    g.gain.setValueAtTime(vol, t + Math.max(attack, dur - release * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + release);
    let node: AudioNode = o;
    if (cutoff) {
      const f = ctx.createBiquadFilter();
      f.type = "lowpass";
      f.frequency.value = cutoff;
      o.connect(f);
      node = f;
    }
    node.connect(g).connect(dest);
    if (echo) {
      const e = ctx.createGain();
      e.gain.value = echo;
      g.connect(e).connect(this.echoIn);
    }
    o.start(t);
    o.stop(t + dur + release + 0.05);
  }

  private kick(dest: AudioNode, t: number, vol: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(dest);
    o.start(t);
    o.stop(t + 0.2);
  }

  private hit(dest: AudioNode, t: number, vol: number, f: number, dur: number, type: BiquadFilterType) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const flt = this.ctx.createBiquadFilter();
    flt.type = type;
    flt.frequency.value = f;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(flt).connect(g).connect(dest);
    src.start(t);
    src.stop(t + dur + 0.02);
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.bus.disconnect();
  }
}
