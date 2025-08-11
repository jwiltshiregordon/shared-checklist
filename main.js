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
        const trackFreq = document.getElementById("trackFreq");

        const rxOutput = document.getElementById("rxOutput");
        const estWpmEl = document.getElementById("estWpm");
        const unitMsEl = document.getElementById("unitMs");
        const f0El = document.getElementById("f0");
        const snrEl = document.getElementById("snr");
        const rxStatus = document.getElementById("rxStatus");
        const toneIndicator = document.getElementById("toneIndicator");

        wpm.addEventListener("input", () => {
          wpmVal.textContent = wpm.value;
          updateUnitDisplay();
          updateUnitSamples();
        });
        tone.addEventListener("input", () => {
          toneVal.textContent = tone.value;
          if (workletNode)
            workletNode.port.postMessage({
              cmd: "setFreq",
              f0: Number(tone.value),
            });
        });
        vol.addEventListener(
          "input",
          () => (volVal.textContent = Number(vol.value).toFixed(2))
        );
        wpmVal.textContent = wpm.value;
        toneVal.textContent = tone.value;
        volVal.textContent = Number(vol.value).toFixed(2);
        updateUnitDisplay();

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
          await ctx.audioWorklet.addModule(
            new URL("./goertzel-detector.js", import.meta.url)
          );
          mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
          });
          const src = ctx.createMediaStreamSource(mediaStream);
          workletNode = new AudioWorkletNode(ctx, "goertzel-detector", {
            processorOptions: {
              f0: Number(tone.value),
              track: trackFreq.checked,
            },
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
          symbolBuf = "";
          toneIndicator.classList.remove("on");
          updateUnitSamples();
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
          toneIndicator.classList.remove("on");
        }

        function handleEdge(on, span) {
          if (on) {
            processGap(span);
            toneIndicator.classList.add("on");
          } else {
            processTone(span);
            toneIndicator.classList.remove("on");
          }
        }

        function processTone(span) {
          const sym = span > 2 * unitSamples ? "-" : ".";
          symbolBuf += sym;
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

        function updateUnitSamples() {
          if (!rxSampleRate) return;
          unitSamples = (rxSampleRate * 1.2) / Number(wpm.value);
        }

        function updateUnitDisplay() {
          const w = Number(wpm.value);
          const unitMs = 1200 / w;
          estWpmEl.textContent = w.toFixed(1);
          unitMsEl.textContent = unitMs.toFixed(1);
        }
      })();
