// Plays raw interleaved s16 stereo PCM pushed from the main thread (shared app
// audio). Keeps a small jitter buffer, resamples to the context rate, and
// trims latency if the producer runs ahead.
class PcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.cap = Math.ceil(sampleRate * 2);
    this.L = new Float32Array(this.cap);
    this.R = new Float32Array(this.cap);
    this.read = 0;
    this.write = 0;
    this.count = 0;
    this.frac = 0;
    this.step = 1;
    this.channels = 2;
    this.target = Math.round(sampleRate * 0.06); // ~60 ms jitter buffer
    this.maxLatency = Math.round(sampleRate * 0.3);
    this.primed = false;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'format') {
        this.step = m.rate / sampleRate;
        this.channels = m.channels || 2;
      } else if (m.type === 'pcm') {
        this.push(new Int16Array(m.buffer));
      } else if (m.type === 'clear') {
        this.read = this.write = this.count = 0;
        this.primed = false;
      }
    };
  }

  push(s) {
    const ch = this.channels;
    const frames = Math.floor(s.length / ch);
    for (let i = 0; i < frames; i++) {
      const l = s[i * ch] / 32768;
      const r = ch > 1 ? s[i * ch + 1] / 32768 : l;
      this.L[this.write] = l;
      this.R[this.write] = r;
      this.write = (this.write + 1) % this.cap;
      if (this.count < this.cap) this.count++;
      else this.read = (this.read + 1) % this.cap; // overwrite oldest
    }
    // Producer ahead of us (clock drift or a stall): skip to the target latency.
    const ahead = this.count / this.step;
    if (ahead > this.maxLatency) {
      const drop = Math.floor(this.count - this.target * this.step);
      this.read = (this.read + drop) % this.cap;
      this.count -= drop;
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0];
    const oR = out[1] || out[0];
    const n = oL.length;
    if (!this.primed) {
      if (this.count / this.step < this.target) {
        oL.fill(0); if (oR !== oL) oR.fill(0);
        return true;
      }
      this.primed = true;
    }
    for (let i = 0; i < n; i++) {
      if (this.count < 2) {
        this.primed = false;
        oL[i] = 0; oR[i] = 0;
        continue;
      }
      const a = this.read;
      const b = (a + 1) % this.cap;
      const f = this.frac;
      oL[i] = this.L[a] + (this.L[b] - this.L[a]) * f;
      oR[i] = this.R[a] + (this.R[b] - this.R[a]) * f;
      this.frac += this.step;
      while (this.frac >= 1) {
        this.frac -= 1;
        this.read = (this.read + 1) % this.cap;
        this.count--;
      }
    }
    return true;
  }
}

registerProcessor('pcm-player', PcmPlayer);
