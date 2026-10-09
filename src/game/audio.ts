/** Tiny Web Audio synth — every sound is generated, no audio files. */
import { Music, type TrackId } from "./music";
import type { EventType } from "./types";

type Wave = OscillatorType;

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private muted = false;
  private paused = false;
  private music: Music | null = null;
  private wantTrack: TrackId | null = null;

  /** Must be called from a user gesture (start/click/key) to satisfy autoplay rules. */
  unlock() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.level;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 1;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.music = new Music(this.ctx, this.master);
      this.music.play(this.wantTrack);
    }
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => {});
  }

  /** Choose the background track (null = silence). Safe to call every frame. */
  setTrack(id: TrackId | null, fade?: number) {
    this.wantTrack = id;
    if (this.music && this.music.track !== id) this.music.play(id, fade);
  }

  /** for debugging/automated checks */
  get status() {
    return { ctx: this.ctx?.state ?? "none", track: this.music?.track ?? null, muted: this.muted };
  }

  stingVictory() {
    if (!this.muted) this.music?.sting();
  }

  dispose() {
    this.music?.dispose();
    this.music = null;
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }

  private get level() {
    return this.muted ? 0 : this.paused ? 0.12 : 0.5;
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.02);
  }

  /** Pause menu: duck everything (music keeps its place instead of restarting). */
  setPaused(p: boolean) {
    this.paused = p;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.level, this.ctx.currentTime, 0.05);
  }

  private tone(freq: number, dur: number, opts: { type?: Wave; vol?: number; slide?: number; delay?: number; attack?: number } = {}) {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master || this.muted) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = opts.type ?? "square";
    o.frequency.setValueAtTime(freq, t0);
    if (opts.slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, opts.slide), t0 + dur);
    const v = opts.vol ?? 0.2;
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + (opts.attack ?? 0.008));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(master);
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  private noise(dur: number, opts: { freq?: number; q?: number; vol?: number; slide?: number; delay?: number; type?: BiquadFilterType } = {}) {
    const ctx = this.ctx, master = this.master;
    if (!ctx || !master || !this.noiseBuf || this.muted) return;
    const t0 = ctx.currentTime + (opts.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = opts.type ?? "bandpass";
    f.frequency.setValueAtTime(opts.freq ?? 1200, t0);
    if (opts.slide) f.frequency.exponentialRampToValueAtTime(opts.slide, t0 + dur);
    f.Q.value = opts.q ?? 1;
    const g = ctx.createGain();
    const v = opts.vol ?? 0.3;
    g.gain.setValueAtTime(v, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(f).connect(g).connect(master);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  private arp(notes: number[], step: number, opts: { type?: Wave; vol?: number; dur?: number } = {}) {
    notes.forEach((n, i) => this.tone(n, opts.dur ?? step * 1.6, { type: opts.type ?? "square", vol: opts.vol ?? 0.12, delay: i * step }));
  }

  play(type: EventType) {
    if (!this.ctx || this.muted) return;
    switch (type) {
      case "swing":
        this.noise(0.16, { freq: 700, slide: 3200, q: 2.5, vol: 0.28 });
        break;
      case "hit":
        this.tone(220, 0.09, { type: "square", vol: 0.18, slide: 90 });
        this.noise(0.08, { freq: 2500, q: 0.8, vol: 0.35 });
        break;
      case "enemyDie":
        this.tone(520, 0.25, { type: "sawtooth", vol: 0.14, slide: 60 });
        this.noise(0.25, { freq: 600, slide: 150, vol: 0.25, type: "lowpass" });
        break;
      case "bossDie":
        this.tone(300, 1.2, { type: "sawtooth", vol: 0.2, slide: 30 });
        this.noise(1.2, { freq: 900, slide: 60, vol: 0.4, type: "lowpass" });
        this.arp([392, 523, 659, 784], 0.12);
        break;
      case "rupee":
        this.tone(1318.5, 0.07, { type: "triangle", vol: 0.16 });
        this.tone(1975.5, 0.14, { type: "triangle", vol: 0.16, delay: 0.06 });
        break;
      case "heart":
        this.arp([784, 988, 1175], 0.06, { type: "triangle", vol: 0.15 });
        break;
      case "hurt":
        this.tone(330, 0.22, { type: "square", vol: 0.2, slide: 110 });
        this.noise(0.12, { freq: 400, vol: 0.2, type: "lowpass" });
        break;
      case "key":
        this.arp([523, 659, 784, 1047], 0.09, { type: "square", vol: 0.12 });
        break;
      case "gate":
        this.noise(0.9, { freq: 220, slide: 80, vol: 0.45, type: "lowpass" });
        this.arp([196, 247, 294, 392], 0.13, { type: "triangle", vol: 0.16, dur: 0.4 });
        break;
      case "gateSlam":
        this.noise(0.5, { freq: 300, slide: 60, vol: 0.5, type: "lowpass" });
        this.tone(80, 0.5, { type: "sine", vol: 0.35, slide: 40 });
        break;
      case "bossRoar":
        this.tone(110, 0.9, { type: "sawtooth", vol: 0.16, slide: 55, attack: 0.1 });
        this.tone(116, 0.9, { type: "sawtooth", vol: 0.12, slide: 58, attack: 0.1 });
        break;
      case "bossCharge":
        // rising growl over the windup — the cue to get out of the lane
        this.tone(70, 0.75, { type: "sawtooth", vol: 0.14, slide: 330, attack: 0.25 });
        this.tone(105, 0.75, { type: "square", vol: 0.05, slide: 495, attack: 0.3 });
        this.noise(0.75, { freq: 300, slide: 2400, q: 3, vol: 0.12 });
        break;
      case "globLand":
        // wet plop, then an accelerating fuse tick
        this.tone(260, 0.12, { type: "sine", vol: 0.16, slide: 90 });
        [0.18, 0.4, 0.56, 0.67, 0.74].forEach((d, i) => this.tone(1200 + i * 220, 0.04, { type: "square", vol: 0.045, delay: d }));
        break;
      case "lunge":
        this.noise(0.25, { freq: 400, slide: 1600, vol: 0.25 });
        break;
      case "clank":
        this.tone(1760, 0.12, { type: "square", vol: 0.1 });
        this.tone(2637, 0.18, { type: "square", vol: 0.07, delay: 0.01 });
        this.noise(0.08, { freq: 5000, q: 2, vol: 0.25, type: "highpass" });
        break;
      case "bossStun":
        this.tone(880, 0.6, { type: "triangle", vol: 0.12, slide: 330 });
        this.tone(1320, 0.5, { type: "triangle", vol: 0.06, slide: 495, delay: 0.08 });
        this.noise(0.3, { freq: 200, vol: 0.35, type: "lowpass" });
        break;
      case "spit":
        this.tone(140, 0.35, { type: "sawtooth", vol: 0.1, slide: 420 });
        this.noise(0.3, { freq: 600, slide: 1600, q: 4, vol: 0.18 });
        break;
      case "splash":
        this.tone(320, 0.25, { type: "sine", vol: 0.22, slide: 70 });
        this.noise(0.3, { freq: 900, slide: 200, vol: 0.3, type: "lowpass" });
        break;
      case "chestAppear":
        this.arp([523, 784, 1047], 0.1, { type: "triangle", vol: 0.14 });
        break;
      case "chest":
        // the classic "you found it" four-note rise, in our own key
        this.arp([587, 740, 880, 1175], 0.14, { type: "square", vol: 0.13, dur: 0.22 });
        this.tone(1175, 0.8, { type: "triangle", vol: 0.16, delay: 0.56 });
        break;
      case "tuft":
        this.noise(0.12, { freq: 3500, q: 0.7, vol: 0.18, type: "highpass" });
        break;
      case "pot":
        this.noise(0.18, { freq: 1800, q: 3, vol: 0.35 });
        this.tone(900, 0.06, { type: "triangle", vol: 0.1, slide: 500 });
        break;
      case "spawn":
        this.tone(200, 0.2, { type: "sine", vol: 0.08, slide: 420 });
        break;
      case "door":
        this.noise(0.4, { freq: 500, slide: 150, vol: 0.2, type: "lowpass" });
        break;
      case "gameover":
        this.arp([392, 330, 262, 196], 0.18, { type: "triangle", vol: 0.16, dur: 0.35 });
        break;
      case "victory":
        this.arp([523, 659, 784, 1047, 784, 1047, 1319], 0.12, { type: "square", vol: 0.1, dur: 0.25 });
        break;
    }
  }
}
