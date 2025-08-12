class GoertzelDetector extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const p = options?.processorOptions || {};
    this.sr = sampleRate;
    this.f0 = p.f0 ?? 650;
    this.delta = p.delta ?? 10;
    this.track = !!p.track;
    this.M = 64; // step size for updates (latency ~M/sr)
    this.resetBins();

    // Envelope & gating
    this.env = 0;
    // Coefficients tuned for updates every M samples rather than each sample
    const stepSec = this.M / this.sr;
    // Shorter envelope window so gating reacts quickly to tone edges
    this.aEnv = Math.exp(-stepSec / 0.005); // ~5ms LP
    this.noise = 1e-6;
    this.peak = 1e-5;
    // Track noise and peak over a shorter ~50ms window
    this.aNoise = Math.exp(-stepSec / 0.050);
    this.aPeak = Math.exp(-stepSec / 0.050);
    this.stateOn = false;
    this.samplesSinceEdge = 0;

    // Telemetry pacing
    this.teleSamples = 0;
    this.teleEvery = Math.floor(0.1 * this.sr); // 100ms
    this._enter = 0;
    this._exit = 0;

    this.port.onmessage = (e) => {
      const d = e.data || {};
      if (d.cmd === "setFreq") {
        this.f0 = d.f0;
        this.resetBins();
      }
      if (d.cmd === "track") {
        this.track = !!d.on;
      }
    };
  }

  makeBin(f) {
    const w = (2 * Math.PI * f) / this.sr;
    return { f, cos: 2 * Math.cos(w), s1: 0, s2: 0 };
  }

  resetBins() {
    this.binC = this.makeBin(this.f0);
    this.binL = this.makeBin(this.f0 - this.delta);
    this.binR = this.makeBin(this.f0 + this.delta);
  }

  stepBin(bin, x) {
    const s0 = x + bin.cos * bin.s1 - bin.s2;
    bin.s2 = bin.s1;
    bin.s1 = s0;
  }

  mag2(bin) {
    return bin.s1 * bin.s1 + bin.s2 * bin.s2 - bin.cos * bin.s1 * bin.s2;
  }

  clearBins() {
    this.binC.s1 = this.binC.s2 = 0;
    this.binL.s1 = this.binL.s2 = 0;
    this.binR.s1 = this.binR.s2 = 0;
  }

  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const N = ch.length;

    for (let i = 0; i < N; i++) {
      const x = ch[i];
      this.stepBin(this.binC, x);
      this.stepBin(this.binL, x);
      this.stepBin(this.binR, x);
      this.samplesSinceEdge++;
      this.teleSamples++;

      if (((i + 1) % this.M) === 0) {
        const pC = this.mag2(this.binC);
        const pL = this.mag2(this.binL);
        const pR = this.mag2(this.binR);
        let p = pC,
          which = 0;
        if (this.track) {
          if (pL > p) {
            p = pL;
            which = -1;
          }
          if (pR > p) {
            p = pR;
            which = +1;
          }
          // nudge f0 slowly
          if (which !== 0) {
            this.f0 += 0.4 * which;
            if (this.f0 < 0) this.f0 = 0;
          }
          if ((i % (this.M * 8)) === 0) this.resetBins();
        }
        this.clearBins();

        // Envelope on sqrt power
        const amp = Math.sqrt(Math.max(0, p));
        this.env = this.env * this.aEnv + amp * (1 - this.aEnv);

        // Track noise/peak
        if (!this.stateOn)
          this.noise = this.aNoise * this.noise + (1 - this.aNoise) * this.env;
        else
          this.peak = this.aPeak * this.peak + (1 - this.aPeak) * this.env;
        const span = Math.max(1e-6, this.peak - this.noise);
        const enter = this.noise + 0.6 * span;
        const exit = this.noise + 0.35 * span;
        this._enter = enter;
        this._exit = exit;

        // Gate
        const wantOn = this.env >= (this.stateOn ? exit : enter);
        if (wantOn !== this.stateOn) {
          // Emit edge with duration spent in the PREVIOUS state
          this.port.postMessage({
            type: "EDGE",
            on: wantOn,
            span: this.samplesSinceEdge,
          });
          this.samplesSinceEdge = 0;
          this.stateOn = wantOn;
          if (this.stateOn) this.peak = this.env;
          else this.noise = this.env;
        }

        // Telemetry every ~100 ms
        if (this.teleSamples >= this.teleEvery) {
          const snr = span > 0 ? span / Math.max(1e-6, this.noise) : 0;
          this.port.postMessage({
            type: "TEL",
            f0: this.f0,
            snr,
            enter,
            exit,
            env: this.env,
          });
          this.teleSamples = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("goertzel-detector", GoertzelDetector);

