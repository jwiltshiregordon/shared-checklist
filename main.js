import { MORSE, REV } from "./morse.js";
      (() => {
        // ---------- Config & constants ----------
        const DEFAULT_WPM = 28;
        const DEFAULT_TONE = 650;
        const ATTACK_S = 0.006; // raised-cosine-ish edges to reduce clicks
        const RELEASE_S = 0.006;
// Morse tables and helpers imported from morse.js


        // ---------- DOM ----------
        const txInput = document.getElementById("txInput");
        const sendBtn = document.getElementById("sendBtn");
        const sendVVVBtn = document.getElementById("sendVVVBtn");
        const txStatus = document.getElementById("txStatus");

        const wpm = document.getElementById("wpm");
        const wpmVal = document.getElementById("wpmVal");
        const tone = document.getElementById("tone");
        const toneVal = document.getElementById("toneVal");
        const vol = document.getElementById("vol");
        const volVal = document.getElementById("volVal");

        const listenBtn = document.getElementById("listenBtn");
        const stopBtn = document.getElementById("stopBtn");
        const clearBtn = document.getElementById("clearBtn");
        const lockSpeed = document.getElementById("lockSpeed");
        const trackFreq = document.getElementById("trackFreq");

        const rxOutput = document.getElementById("rxOutput");
        const estWpmEl = document.getElementById("estWpm");
        const unitMsEl = document.getElementById("unitMs");
        const f0El = document.getElementById("f0");
        const snrEl = document.getElementById("snr");
        const rxStatus = document.getElementById("rxStatus");

        wpm.addEventListener("input", () => (wpmVal.textContent = wpm.value));
        tone.addEventListener(
          "input",
          () => (toneVal.textContent = tone.value)
        );
        vol.addEventListener(
          "input",
          () => (volVal.textContent = Number(vol.value).toFixed(2))
        );
        wpmVal.textContent = wpm.value;
        toneVal.textContent = tone.value;
        volVal.textContent = Number(vol.value).toFixed(2);

        // ---------- Audio (shared) ----------
        let audioCtx;
        function getAudioCtx() {
          if (!audioCtx)
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
          if (audioCtx.state === "suspended") audioCtx.resume();
          return audioCtx;
        }

        // ---------- Transmit ----------
        sendBtn.addEventListener("click", async () => {
          const text = (txInput.value || "").toUpperCase();
          if (!text.trim()) {
            txStatus.textContent = "Nothing to send.";
            return;
          }
          await safeTransmit(text);
        });

        sendVVVBtn.addEventListener("click", async () => {
          await safeTransmit("VVV VVV");
        });

        async function safeTransmit(text) {
          const ctx = getAudioCtx();
          sendBtn.disabled = true;
          sendVVVBtn.disabled = true;
          txStatus.textContent = "Transmitting…";
          try {
            await transmit(
              ctx,
              text,
              Number(wpm.value),
              Number(tone.value),
              Number(vol.value)
            );
            txStatus.textContent = "Done.";
          } catch (e) {
            console.error(e);
            txStatus.textContent = "Error during transmit (see console).";
          } finally {
            sendBtn.disabled = false;
            sendVVVBtn.disabled = false;
          }
        }

        function scheduleRaisedCosine(gain, tStart, durMs) {
          // Simple piecewise linear approximation to raised-cosine
          const t0 = tStart,
            t1 = tStart + durMs / 1000;
          const steps = 6;
          gain.gain.setValueAtTime(0, t0);
          for (let k = 1; k <= steps; k++) {
            const frac = k / steps;
            const y = 0.5 - 0.5 * Math.cos(Math.min(1, frac) * Math.PI);
            gain.gain.linearRampToValueAtTime(y, t0 + ATTACK_S * frac);
          }
          gain.gain.setValueAtTime(1, Math.max(t0 + ATTACK_S, t1 - RELEASE_S));
          for (let k = 1; k <= steps; k++) {
            const frac = k / steps;
            const y = 1 - (0.5 - 0.5 * Math.cos(Math.min(1, frac) * Math.PI));
            gain.gain.linearRampToValueAtTime(
              y,
              t1 - RELEASE_S + RELEASE_S * frac
            );
          }
          return t1;
        }

        async function transmit(ctx, plainText, wpm, freqHz, volume) {
          const UNIT_MS = 1200 / wpm;
          const osc = ctx.createOscillator();
          osc.type = "sine";
          osc.frequency.value = freqHz;

          const gain = ctx.createGain();
          gain.gain.value = 0.0;

          const volNode = ctx.createGain();
          volNode.gain.value = volume;

          osc.connect(gain).connect(volNode).connect(ctx.destination);
          osc.start();

          // Build the on/off schedule as [isOn, durationMs]
          const seq = [];
          const upper = plainText.toUpperCase();

          for (let i = 0; i < upper.length; i++) {
            const ch = upper[i];
            if (ch === " ") {
              seq.push([0, 7 * UNIT_MS]);
              continue;
            }
            const code = MORSE[ch];
            if (!code) continue;
            for (let j = 0; j < code.length; j++) {
              const dur = code[j] === "." ? 1 * UNIT_MS : 3 * UNIT_MS;
              seq.push([1, dur]);
              seq.push([0, 1 * UNIT_MS]);
            }
            // replace last intra-element gap (1u) with letter gap (3u)
            if (seq.length && seq[seq.length - 1][0] === 0)
              seq[seq.length - 1][1] += 2 * UNIT_MS;
          }

          // Schedule on WebAudio clock
          let when = ctx.currentTime + 0.05;
          for (const [isOn, durMs] of seq) {
            if (isOn) when = scheduleRaisedCosine(gain, when, durMs);
            else when += durMs / 1000;
          }
          const stopAt = when + 0.05;
          osc.stop(stopAt);
          await new Promise((res) =>
            setTimeout(res, (stopAt - ctx.currentTime) * 1000 + 50)
          );
        }

        // ---------- Receive (AudioWorklet + Goertzel) ----------
        // Worklet code as a string to keep single-file
        const workletCode = `
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
      this.aEnv = Math.exp(-1 / (0.010 * this.sr)); // ~10ms LP
      this.noise = 1e-6;
      this.peak  = 1e-5;
      this.aNoise = Math.exp(-1 / (0.200 * this.sr));
      this.aPeak  = Math.exp(-1 / (0.200 * this.sr));
      this.stateOn = false;
      this.samplesSinceEdge = 0;

      // Telemetry pacing
      this.teleSamples = 0;
      this.teleEvery = Math.floor(0.1 * this.sr); // 100ms
      this._enter = 0; this._exit = 0;

      this.port.onmessage = (e) => {
        const d = e.data || {};
        if (d.cmd === 'setFreq') { this.f0 = d.f0; this.resetBins(); }
        if (d.cmd === 'track') { this.track = !!d.on; }
      };
    }

    makeBin(f) {
      const w = 2 * Math.PI * f / this.sr;
      return { f, cos: 2 * Math.cos(w), s1: 0, s2: 0 };
    }
    resetBins() {
      this.binC = this.makeBin(this.f0);
      this.binL = this.makeBin(this.f0 - this.delta);
      this.binR = this.makeBin(this.f0 + this.delta);
    }
    stepBin(bin, x) {
      const s0 = x + bin.cos * bin.s1 - bin.s2;
      bin.s2 = bin.s1; bin.s1 = s0;
    }
    mag2(bin) {
      return bin.s1*bin.s1 + bin.s2*bin.s2 - bin.cos*bin.s1*bin.s2;
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

      for (let i=0;i<N;i++) {
        const x = ch[i];
        this.stepBin(this.binC, x);
        this.stepBin(this.binL, x);
        this.stepBin(this.binR, x);
        this.samplesSinceEdge++;
        this.teleSamples++;

        if (((i+1) % this.M) === 0) {
          const pC = this.mag2(this.binC);
          const pL = this.mag2(this.binL);
          const pR = this.mag2(this.binR);
          let p = pC, which = 0;
          if (this.track) {
            if (pL > p) { p = pL; which = -1; }
            if (pR > p) { p = pR; which = +1; }
            // nudge f0 slowly
            if (which !== 0) this.f0 += 0.4 * which;
            if ((i % (this.M*8)) === 0) this.resetBins();
          }
          this.clearBins();

          // Envelope on sqrt power
          const amp = Math.sqrt(Math.max(0, p));
          this.env = this.env * this.aEnv + amp * (1 - this.aEnv);

          // Track noise/peak
          if (!this.stateOn) this.noise = this.aNoise * this.noise + (1 - this.aNoise) * this.env;
          else               this.peak  = this.aPeak  * this.peak  + (1 - this.aPeak)  * this.env;
          const span = Math.max(1e-6, this.peak - this.noise);
          const enter = this.noise + 0.60 * span;
          const exit  = this.noise + 0.35 * span;
          this._enter = enter; this._exit = exit;

          // Gate
          const wantOn = this.env >= (this.stateOn ? exit : enter);
          if (wantOn !== this.stateOn) {
            // Emit edge with duration spent in the PREVIOUS state
            this.port.postMessage({ type:'EDGE', on: wantOn, span: this.samplesSinceEdge });
            this.samplesSinceEdge = 0;
            this.stateOn = wantOn;
            if (this.stateOn) this.peak = this.env; else this.noise = this.env;
          }

          // Telemetry every ~100 ms
          if (this.teleSamples >= this.teleEvery) {
            const snr = span > 0 ? (span / Math.max(1e-6, this.noise)) : 0;
            this.port.postMessage({ type:'TEL', f0: this.f0, snr, enter, exit, env: this.env });
            this.teleSamples = 0;
          }
        }
      }
      return true;
    }
  }
  registerProcessor('goertzel-detector', GoertzelDetector);
  `;

        let mediaStream = null;
        let workletNode = null;
        let rxRunning = false;
        let unitSamples = 0;
        let symbolBuf = "";
        let rxSampleRate = 0;

        listenBtn.addEventListener("click", () =>
          startListening().catch((err) => {
            console.error(err);
            rxStatus.textContent = "Mic error (see console).";
          })
        );
        stopBtn.addEventListener("click", stopListening);
        clearBtn.addEventListener("click", () => {
          rxOutput.value = "";
        });
        trackFreq.addEventListener("change", () => {
          if (workletNode)
            workletNode.port.postMessage({
              cmd: "track",
              on: trackFreq.checked,
            });
        });

        async function startListening() {
          if (rxRunning) return;
          const ctx = getAudioCtx();
          rxSampleRate = ctx.sampleRate;
          const blob = new Blob([workletCode], {
            type: "application/javascript",
          });
          await ctx.audioWorklet.addModule(URL.createObjectURL(blob));
          mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const src = ctx.createMediaStreamSource(mediaStream);
          workletNode = new AudioWorkletNode(ctx, "goertzel-detector", {
            processorOptions: { f0: DEFAULT_TONE, track: trackFreq.checked },
          });
          workletNode.port.onmessage = (e) => {
            const d = e.data || {};
            if (d.type === "EDGE") handleEdge(d.on, d.span);
            if (d.type === "TEL") handleTel(d);
          };
          const sink = ctx.createGain();
          sink.gain.value = 0;
          src.connect(workletNode).connect(sink).connect(ctx.destination);
          rxRunning = true;
          listenBtn.disabled = true;
          stopBtn.disabled = false;
          rxStatus.textContent = "Listening…";
          unitSamples = 0;
          symbolBuf = "";
          updateUnitDisplay();
        }

        function stopListening() {
          if (!rxRunning) return;
          rxRunning = false;
          if (workletNode) {
            workletNode.disconnect();
            workletNode = null;
          }
          if (mediaStream) {
            mediaStream.getTracks().forEach((t) => t.stop());
            mediaStream = null;
          }
          listenBtn.disabled = false;
          stopBtn.disabled = true;
          rxStatus.textContent = "Idle";
        }

        function handleEdge(on, span) {
          if (on) processGap(span);
          else processTone(span);
        }

        function processTone(span) {
          if (unitSamples === 0) unitSamples = span;
          else if (!lockSpeed.checked && span < 2.5 * unitSamples)
            unitSamples = 0.8 * unitSamples + 0.2 * span;
          const sym = span > 2 * unitSamples ? "-" : ".";
          symbolBuf += sym;
          updateUnitDisplay();
        }

        function processGap(span) {
          if (unitSamples === 0) return;
          if (span >= 6 * unitSamples) {
            flushSymbol();
            rxOutput.value += " ";
          } else if (span >= 2.5 * unitSamples) {
            flushSymbol();
          }
        }

        function flushSymbol() {
          if (!symbolBuf) return;
          const ch = REV.get(symbolBuf) || "?";
          rxOutput.value += ch;
          rxOutput.scrollTop = rxOutput.scrollHeight;
          symbolBuf = "";
        }

        function handleTel(d) {
          f0El.textContent = d.f0.toFixed(1);
          snrEl.textContent = d.snr.toFixed(1);
        }

        function updateUnitDisplay() {
          if (!unitSamples) {
            estWpmEl.textContent = "–";
            unitMsEl.textContent = "–";
            return;
          }
          const unitMs = (unitSamples * 1000) / rxSampleRate;
          unitMsEl.textContent = unitMs.toFixed(1);
          estWpmEl.textContent = (1200 / unitMs).toFixed(1);
        }
      })();
