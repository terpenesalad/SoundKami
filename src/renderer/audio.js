// SoundKami audio engine.
//
//   mic ──► micGain ──► duck ──┐
//   sounds ─► soundsPre ─► soundsGain ─┼─► mainBus ─► limiter ─► [virtual cable]  (what Discord hears)
//   shared apps ─► musicGain ──┘
//   soundsPre ─► monitorGain ─► monitorDest ─► <audio> [your headphones]  (what you hear)

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();      // file -> AudioBuffer
    this.loading = new Map();      // file -> Promise<AudioBuffer>
    this.voices = new Map();       // soundId -> Set<voice>
    this.music = new Map();        // key -> { node, leftover }
    this.micStream = null;
    this.micSource = null;
    this.listeners = new Set();
    this.duckTimer = null;
    this.settings = {};
    this.cableId = '';
    this.monitorId = '';
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(type, data) { for (const fn of this.listeners) fn(type, data); }

  async init() {
    const ctx = new AudioContext({ latencyHint: 'interactive', sampleRate: 48000 });
    this.ctx = ctx;
    await ctx.audioWorklet.addModule('pcm-worklet.js');

    this.mainBus = ctx.createGain();
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -2;
    this.limiter.knee.value = 0;
    this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.002;
    this.limiter.release.value = 0.12;
    this.mainBus.connect(this.limiter).connect(ctx.destination);

    this.outAnalyser = ctx.createAnalyser();
    this.outAnalyser.fftSize = 1024;
    this.limiter.connect(this.outAnalyser);

    this.micGain = ctx.createGain();
    this.duck = ctx.createGain();
    this.micAnalyser = ctx.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    this.micGain.connect(this.duck).connect(this.mainBus);
    this.micGain.connect(this.micAnalyser);

    this.soundsPre = ctx.createGain();
    this.soundsGain = ctx.createGain();
    this.soundsPre.connect(this.soundsGain).connect(this.mainBus);
    this.soundsAnalyser = ctx.createAnalyser();
    this.soundsAnalyser.fftSize = 1024;
    this.soundsGain.connect(this.soundsAnalyser);

    this.previewBus = ctx.createGain(); // editor previews: you only

    this.monitorGain = ctx.createGain();
    this.monitorDest = ctx.createMediaStreamDestination();
    this.soundsPre.connect(this.monitorGain);
    this.previewBus.connect(this.monitorDest);
    this.monitorGain.connect(this.monitorDest);
    this.monitorAudio = new Audio();
    this.monitorAudio.srcObject = this.monitorDest.stream;

    this.musicGain = ctx.createGain();
    this.musicAnalyser = ctx.createAnalyser();
    this.musicAnalyser.fftSize = 1024;
    this.musicGain.connect(this.mainBus);
    this.musicGain.connect(this.musicAnalyser);

    this._levelBuf = new Float32Array(1024);

    // Browsers sometimes start contexts suspended; resume on any interaction.
    const resume = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
    window.addEventListener('pointerdown', resume, true);
    window.addEventListener('keydown', resume, true);
    resume();
  }

  // -------------------------------------------------------------- settings
  apply(s) {
    this.settings = s;
    const t = this.ctx.currentTime;
    this.micGain.gain.setTargetAtTime(s.micEnabled ? s.micVolume : 0, t, 0.02);
    this.soundsGain.gain.setTargetAtTime(s.soundVolume, t, 0.02);
    this.monitorGain.gain.setTargetAtTime(s.monitorSounds ? s.monitorVolume : 0, t, 0.02);
    this.previewBus.gain.setTargetAtTime(Math.max(0.15, s.monitorVolume ?? 0.6), t, 0.02);
    this.musicGain.gain.setTargetAtTime(s.musicVolume, t, 0.02);
    if (!s.duckMic) this.duck.gain.setTargetAtTime(1, t, 0.05);
  }

  async setOutputs(cableId, monitorId) {
    // Mic + sounds + shared audio go to the virtual cable. With no cable we
    // render silently rather than echo your mic out of your speakers.
    if (cableId !== this.cableId || !this._sinkApplied) {
      this.cableId = cableId;
      this._sinkApplied = true;
      try {
        await this.ctx.setSinkId(cableId ? cableId : { type: 'none' });
      } catch (e) {
        this.emit('error', { where: 'cable', message: e.message });
        try { await this.ctx.setSinkId({ type: 'none' }); } catch {}
      }
    }
    if (monitorId !== this.monitorId || !this._monitorApplied) {
      this.monitorId = monitorId;
      this._monitorApplied = true;
      try {
        await this.monitorAudio.setSinkId(monitorId === 'default' ? '' : monitorId || '');
      } catch (e) {
        this.emit('error', { where: 'monitor', message: e.message });
      }
      this.monitorAudio.play().catch(() => {});
    }
  }

  async setMic(enabled, deviceId, processing) {
    const key = JSON.stringify([enabled, deviceId, processing]);
    if (key === this._micKey) return;
    this._micKey = key;
    this.stopMic();
    if (!enabled) return;
    try {
      const constraints = {
        audio: {
          deviceId: deviceId && deviceId !== 'default' ? { exact: deviceId } : undefined,
          echoCancellation: !!processing.echoCancellation,
          noiseSuppression: !!processing.noiseSuppression,
          autoGainControl: !!processing.autoGainControl,
          channelCount: { ideal: 1 },
          latency: { ideal: 0.01 },
        },
        video: false,
      };
      this.micStream = await navigator.mediaDevices.getUserMedia(constraints);
      this.micSource = this.ctx.createMediaStreamSource(this.micStream);
      this.micSource.connect(this.micGain);
      this.emit('mic', { ok: true });
    } catch (e) {
      this._micKey = null;
      this.emit('mic', { ok: false, message: e.message || String(e) });
    }
  }

  stopMic() {
    if (this.micSource) { try { this.micSource.disconnect(); } catch {} this.micSource = null; }
    if (this.micStream) { for (const t of this.micStream.getTracks()) t.stop(); this.micStream = null; }
  }

  // -------------------------------------------------------------- buffers
  async getBuffer(file) {
    if (this.buffers.has(file)) return this.buffers.get(file);
    if (this.loading.has(file)) return this.loading.get(file);
    const p = (async () => {
      const data = await window.sk.readSound(file);
      const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      const buf = await this.ctx.decodeAudioData(ab);
      this.buffers.set(file, buf);
      return buf;
    })();
    this.loading.set(file, p);
    try { return await p; } finally { this.loading.delete(file); }
  }

  forget(file) { this.buffers.delete(file); }

  static peaks(buf, count = 64) {
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
    const size = Math.max(1, Math.floor(ch0.length / count));
    const out = [];
    let max = 0;
    for (let i = 0; i < count; i++) {
      let peak = 0;
      const end = Math.min(ch0.length, (i + 1) * size);
      for (let j = i * size; j < end; j += 4) {
        const v = Math.max(Math.abs(ch0[j]), Math.abs(ch1[j]));
        if (v > peak) peak = v;
      }
      out.push(peak);
      if (peak > max) max = peak;
    }
    return out.map((v) => Math.round((v / (max || 1)) * 100));
  }

  // -------------------------------------------------------------- playback
  isPlaying(id) { const v = this.voices.get(id); return !!(v && v.size); }
  anyPlaying() { for (const v of this.voices.values()) if (v.size) return true; return false; }

  async play(sound, { preview = false } = {}) {
    const buf = await this.getBuffer(sound.file);
    const ctx = this.ctx;
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});

    const id = preview ? `preview:${sound.id}` : sound.id;
    const existing = this.voices.get(id);
    const mode = preview ? 'restart' : (sound.mode || 'restart');
    if (existing && existing.size) {
      if (mode === 'stop') { this.stop(id); return; }
      if (mode === 'restart') this.stop(id, 0.01);
    }
    if (!preview && this.settings.overlap === 'cut') {
      for (const other of this.voices.keys()) if (other !== id && !other.startsWith('preview:')) this.stop(other, 0.02);
    }

    const start = clamp(sound.start || 0, 0, buf.duration);
    let end = sound.end && sound.end > start ? Math.min(sound.end, buf.duration) : buf.duration;
    if (end - start < 0.01) end = buf.duration;

    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const vol = clamp(sound.volume ?? 1, 0, 2);
    const fadeIn = sound.fadeIn || 0;
    if (fadeIn > 0) {
      g.gain.setValueAtTime(0, ctx.currentTime);
      g.gain.linearRampToValueAtTime(vol, ctx.currentTime + fadeIn);
    } else {
      g.gain.value = vol;
    }
    src.connect(g).connect(preview ? this.previewBus : this.soundsPre);

    const voice = { src, g, t0: ctx.currentTime, start, end, loop: !!sound.loop, id };
    if (voice.loop) {
      src.loop = true;
      src.loopStart = start;
      src.loopEnd = end;
      src.start(0, start);
    } else {
      src.start(0, start, end - start);
    }
    src.onended = () => {
      const set = this.voices.get(id);
      if (set) { set.delete(voice); if (!set.size) this.voices.delete(id); }
      try { g.disconnect(); } catch {}
      this.emit('ended', id);
      this.updateDuck();
    };
    if (!this.voices.has(id)) this.voices.set(id, new Set());
    this.voices.get(id).add(voice);
    this.emit('started', id);
    this.updateDuck();
  }

  stop(id, fade = 0.04) {
    const set = this.voices.get(id);
    if (!set) return;
    const t = this.ctx.currentTime;
    for (const v of set) {
      try {
        v.g.gain.cancelScheduledValues(t);
        v.g.gain.setValueAtTime(v.g.gain.value, t);
        v.g.gain.linearRampToValueAtTime(0, t + fade);
        v.src.stop(t + fade + 0.01);
      } catch {}
    }
  }

  stopAll() {
    for (const id of [...this.voices.keys()]) this.stop(id, 0.05);
  }

  progress(id) {
    const set = this.voices.get(id);
    if (!set || !set.size) return -1;
    let latest = null;
    for (const v of set) if (!latest || v.t0 > latest.t0) latest = v;
    const len = latest.end - latest.start;
    const el = this.ctx.currentTime - latest.t0;
    return latest.loop ? (el % len) / len : clamp(el / len, 0, 1);
  }

  updateDuck() {
    if (!this.settings.duckMic) return;
    const playing = [...this.voices.keys()].some((k) => !k.startsWith('preview:'));
    const t = this.ctx.currentTime;
    clearTimeout(this.duckTimer);
    if (playing) {
      this.duck.gain.setTargetAtTime(this.settings.duckAmount ?? 0.3, t, 0.03);
    } else {
      this.duckTimer = setTimeout(() => this.duck.gain.setTargetAtTime(1, this.ctx.currentTime, 0.12), 250);
    }
  }

  // -------------------------------------------------------------- shared app audio
  musicStart(key) {
    if (this.music.has(key)) return;
    const node = new AudioWorkletNode(this.ctx, 'pcm-player', { numberOfInputs: 0, outputChannelCount: [2] });
    node.connect(this.musicGain);
    this.music.set(key, { node, leftover: null });
  }

  musicFormat(key, fmt) {
    const m = this.music.get(key);
    if (m) m.node.port.postMessage({ type: 'format', rate: fmt.rate, channels: fmt.channels });
  }

  musicData(key, chunk) {
    const m = this.music.get(key);
    if (!m) return;
    let bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    if (m.leftover) {
      const merged = new Uint8Array(m.leftover.length + bytes.length);
      merged.set(m.leftover);
      merged.set(bytes, m.leftover.length);
      bytes = merged;
      m.leftover = null;
    }
    const usable = bytes.length - (bytes.length % 4);
    if (usable < bytes.length) m.leftover = bytes.slice(usable);
    if (!usable) return;
    const copy = bytes.slice(0, usable).buffer; // aligned, transferable
    m.node.port.postMessage({ type: 'pcm', buffer: copy }, [copy]);
  }

  musicStop(key) {
    const m = this.music.get(key);
    if (!m) return;
    try { m.node.disconnect(); } catch {}
    this.music.delete(key);
  }

  // -------------------------------------------------------------- meters
  level(analyser) {
    if (!analyser) return 0;
    const b = this._levelBuf;
    analyser.getFloatTimeDomainData(b);
    let peak = 0;
    for (let i = 0; i < b.length; i++) { const v = Math.abs(b[i]); if (v > peak) peak = v; }
    // map -60..0 dBFS to 0..1
    const db = 20 * Math.log10(peak || 1e-6);
    return clamp((db + 60) / 60, 0, 1);
  }

  levels() {
    return {
      mic: this.level(this.micAnalyser),
      out: this.level(this.outAnalyser),
      sounds: this.level(this.soundsAnalyser),
      music: this.level(this.musicAnalyser),
    };
  }

  // -------------------------------------------------------------- test tone
  testTone(target) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.frequency.value = 660;
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    g.gain.setValueAtTime(0.25, ctx.currentTime + 0.35);
    g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.45);
    osc.connect(g).connect(target === 'cable' ? this.mainBus : this.previewBus);
    osc.start();
    osc.stop(ctx.currentTime + 0.5);
  }
}
