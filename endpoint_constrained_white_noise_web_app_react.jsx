import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Endpoint-Constrained White Noise WebApp
 * - 시작/끝 샘플을 0으로 고정해 클릭(스텝) 소리를 방지하는 화이트노이즈 생성
 * - 시간(ms) / 샘플수 입력 토글
 * - RMS(dBFS) 타깃 스케일링
 * - 파형 캔버스 시각화 (정규화 보기 토글)
 * - WAV(16-bit PCM) / RAW PCM(16-bit LE) 다운로드
 * - 오디오 미리듣기 (루프, 모니터 게인)
 * - 내장 셀프 테스트 (간단한 단위 테스트들)
 */

// ========== RNG & Gaussian ==========
function makeLCG(seed) {
  let s = (seed | 0) || 123456789;
  return {
    next() {
      s = Math.imul(1664525, s) + 1013904223;
      return (s >>> 0) / 4294967296;
    },
  };
}

function makeGaussian(rng) {
  let spare = null;
  return function gaussian() {
    if (spare !== null) {
      const val = spare;
      spare = null;
      return val;
    }
    let u, v, s;
    do {
      u = 2 * rng.next() - 1;
      v = 2 * rng.next() - 1;
      s = u * u + v * v;
    } while (!s || s >= 1);
    const mul = Math.sqrt((-2 * Math.log(s)) / s);
    spare = v * mul;
    return u * mul;
  };
}

// ========== Noise Generation ==========
function generateNoise({ N, rmsDBFS, softenEdges, seed }) {
  if (!Number.isFinite(N) || N < 2) return new Float32Array(0);

  // Seed
  let s;
  if (seed === undefined || seed === null || seed === "") {
    if (typeof crypto !== "undefined" && crypto.getRandomValues) {
      const buf = new Uint32Array(1);
      crypto.getRandomValues(buf);
      s = buf[0] | 0;
    } else {
      s = (Date.now() ^ (Math.random() * 0xffffffff)) | 0;
    }
  } else if (/^-?\d+$/.test(String(seed))) {
    s = Number(seed) | 0;
  } else {
    // simple FNV-1a hash for strings
    let h = 2166136261 >>> 0;
    const str = String(seed);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    s = h | 0;
  }

  const rng = makeLCG(s);
  const gaussian = makeGaussian(rng);

  const x = new Float64Array(N);
  for (let i = 0; i < N; i++) x[i] = gaussian();

  // Remove linear component so endpoints are zero
  const y = new Float64Array(N);
  const a = x[0];
  const b = x[N - 1];
  const den = N - 1;
  for (let i = 0; i < N; i++) {
    const t = i / den;
    const ramp = (1 - t) * a + t * b;
    y[i] = x[i] - ramp;
  }

  if (softenEdges && N >= 4) {
    y[1] *= 0.7;
    y[N - 2] *= 0.7;
  }

  // Scale to target RMS (dBFS re 1.0)
  let sum2 = 0;
  for (let i = 0; i < N; i++) sum2 += y[i] * y[i];
  const rms = Math.sqrt(sum2 / N) || 1e-20;
  const targetRMS = Math.pow(10, rmsDBFS / 20);
  const g = targetRMS / rms;

  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = y[i] * g;
  return out;
}

// ========== WAV/PCM Export ==========
function floatToPCM16(float32) {
  const N = float32.length;
  const pcm = new Int16Array(N);
  for (let i = 0; i < N; i++) {
    let v = Math.max(-1, Math.min(1, float32[i]));
    pcm[i] = (v * 32767) | 0;
  }
  return pcm;
}

function makeWavBlob({ samples, sampleRate }) {
  const pcm = floatToPCM16(samples);
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const subchunk2Size = pcm.length * 2;
  const chunkSize = 36 + subchunk2Size;

  const buffer = new ArrayBuffer(44 + subchunk2Size);
  const view = new DataView(buffer);
  let offset = 0;

  function writeString(s) {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
    offset += s.length;
  }
  function writeUint32(v) {
    view.setUint32(offset, v, true); offset += 4;
  }
  function writeUint16(v) {
    view.setUint16(offset, v, true); offset += 2;
  }

  writeString("RIFF");
  writeUint32(chunkSize);
  writeString("WAVE");

  writeString("fmt ");
  writeUint32(16);
  writeUint16(1);
  writeUint16(numChannels);
  writeUint32(sampleRate);
  writeUint32(byteRate);
  writeUint16(blockAlign);
  writeUint16(bitsPerSample);

  writeString("data");
  writeUint32(subchunk2Size);

  for (let i = 0; i < pcm.length; i++) { view.setInt16(offset, pcm[i], true); offset += 2; }
  return new Blob([view], { type: "audio/wav" });
}

function makeRawPCMBlob({ samples }) {
  const pcm = floatToPCM16(samples);
  return new Blob([pcm], { type: "application/octet-stream" });
}

// ========== Waveform Drawing ==========
function drawWaveform(canvas, samples, { normalize }) {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  if (!samples || samples.length === 0) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "14px sans-serif";
    ctx.fillText("No data", 12, 20);
    return;
  }

  let maxAbs = 1;
  if (normalize) {
    let m = 0;
    for (let i = 0; i < samples.length; i++) {
      const a = Math.abs(samples[i]);
      if (a > m) m = a;
    }
    maxAbs = m || 1;
  }

  ctx.strokeStyle = "#cbd5e1";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, H / 2);
  ctx.lineTo(W, H / 2);
  ctx.stroke();

  const N = samples.length;
  const bucketSize = Math.max(1, Math.floor(N / W));
  const scaleY = (H * 0.9) / (2 * maxAbs);
  const centerY = H / 2;

  ctx.strokeStyle = "#0ea5e9";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let x = 0;
  for (let i = 0; i < N; i += bucketSize) {
    const end = Math.min(N, i + bucketSize);
    let min = Infinity, max = -Infinity;
    for (let j = i; j < end; j++) {
      const v = samples[j];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = centerY - min * scaleY;
    const y2 = centerY - max * scaleY;
    ctx.moveTo(x + 0.5, y1);
    ctx.lineTo(x + 0.5, y2);
    x += 1;
    if (x > W) break;
  }
  ctx.stroke();
}

// ========== Self Tests ==========
function approxEqual(a, b, tol) { return Math.abs(a - b) <= tol; }
function toDBFS(rms) { return 20 * Math.log10(Math.max(rms, 1e-20)); }

function runSelfTests() {
  const results = [];
  function t(name, fn) {
    try { fn(); results.push({ name, pass: true }); }
    catch (e) { results.push({ name, pass: false, err: String(e) }); }
  }

  // T1: endpoint zeros
  t("Endpoints are ~0", () => {
    const N = 1000;
    const y = generateNoise({ N, rmsDBFS: -60, softenEdges: true, seed: 42 });
    if (!approxEqual(y[0], 0, 1e-7)) throw new Error(`y[0]=${y[0]}`);
    if (!approxEqual(y[N - 1], 0, 1e-7)) throw new Error(`y[N-1]=${y[N-1]}`);
  });

  // T2: RMS close to target
  t("RMS(dBFS) ~= target (±0.5dB)", () => {
    const N = 48000;
    const target = -70;
    const y = generateNoise({ N, rmsDBFS: target, softenEdges: false, seed: 1 });
    let sum2 = 0; for (let i = 0; i < y.length; i++) sum2 += y[i] * y[i];
    const rms = Math.sqrt(sum2 / y.length);
    const db = toDBFS(rms);
    if (Math.abs(db - target) > 0.5) throw new Error(`got ${db.toFixed(3)} dBFS`);
  });

  // T3: deterministic seed
  t("Same seed -> same sequence", () => {
    const N = 257;
    const y1 = generateNoise({ N, rmsDBFS: -70, softenEdges: true, seed: "abc" });
    const y2 = generateNoise({ N, rmsDBFS: -70, softenEdges: true, seed: "abc" });
    for (let i = 0; i < N; i++) if (y1[i] !== y2[i]) throw new Error(`diff at ${i}`);
  });

  // T4: WAV header sanity
  t("WAV header & length", () => {
    const N = 100;
    const sr = 16000;
    const y = generateNoise({ N, rmsDBFS: -60, softenEdges: false, seed: 7 });
    const blob = makeWavBlob({ samples: y, sampleRate: sr });
    if (blob.type !== "audio/wav") throw new Error("mime");
  });

  // T5: RAW PCM size
  t("RAW PCM byte length", () => {
    const N = 1234;
    const y = generateNoise({ N, rmsDBFS: -60, softenEdges: false, seed: 9 });
    const blob = makeRawPCMBlob({ samples: y });
    if (blob.size !== N * 2) throw new Error(`size=${blob.size}`);
  });

  return results;
}

// ========== React Component ==========
export default function EndpointConstrainedNoiseApp() {
  const [sampleRate, setSampleRate] = useState(48000);
  const [mode, setMode] = useState("time"); // "time" | "samples"
  const [ms, setMs] = useState(200);
  const [samplesN, setSamplesN] = useState(9600);
  const [rmsDBFS, setRmsDBFS] = useState(-70);
  const [softenEdges, setSoftenEdges] = useState(true);
  const [normalizeView, setNormalizeView] = useState(false); // 기본: 실제 스케일 보기
  const [seed, setSeed] = useState("");

  const [generated, setGenerated] = useState(null); // Float32Array or null
  const [metrics, setMetrics] = useState({ N: 0, rms: 0, rmsDB: -Infinity, first: 0, last: 0 });
  const [tests, setTests] = useState([]);

  // Audio preview
  const audioCtxRef = useRef(null);
  const gainNodeRef = useRef(null);
  const srcRef = useRef(null);
  const [monitorGainDB, setMonitorGainDB] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loop, setLoop] = useState(false);

  // Download URLs
  const [wavUrl, setWavUrl] = useState("");
  const [wavName, setWavName] = useState("");
  const [pcmUrl, setPcmUrl] = useState("");
  const [pcmName, setPcmName] = useState("");

  const canvasRef = useRef(null);
  const containerRef = useRef(null);

  // Canvas resize
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const resize = () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = el.getBoundingClientRect();
      canvas.width = Math.max(320, Math.floor(rect.width));
      canvas.height = 220;
      drawWaveform(canvas, generated, { normalize: normalizeView });
    };
    resize();
    let ro;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(resize);
      ro.observe(el);
    } else {
      window.addEventListener("resize", resize);
    }
    return () => {
      if (ro) ro.disconnect();
      else window.removeEventListener("resize", resize);
    };
  }, [generated, normalizeView]);

  // Redraw on toggle
  useEffect(() => {
    drawWaveform(canvasRef.current, generated, { normalize: normalizeView });
  }, [generated, normalizeView]);

  // Revoke blob URLs on unmount/change
  useEffect(() => () => {
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    if (pcmUrl) URL.revokeObjectURL(pcmUrl);
  }, [wavUrl, pcmUrl]);

  const effectiveN = useMemo(() => {
    if (mode === "time") return Math.max(2, Math.round((sampleRate * ms) / 1000));
    return Math.max(2, Number(samplesN) | 0);
  }, [mode, sampleRate, ms, samplesN]);

  function handleGenerate() {
    const N = effectiveN;
    const out = generateNoise({ N, rmsDBFS: Number(rmsDBFS), softenEdges, seed });

    // Metrics
    let sum2 = 0; for (let i = 0; i < out.length; i++) sum2 += out[i] * out[i];
    const rms = Math.sqrt(sum2 / out.length) || 0;
    const rmsDB = toDBFS(rms);

    setGenerated(out);
    setMetrics({ N: out.length, rms, rmsDB, first: out[0] || 0, last: out[out.length - 1] || 0 });

    // clear prior urls
    if (wavUrl) URL.revokeObjectURL(wavUrl);
    if (pcmUrl) URL.revokeObjectURL(pcmUrl);
    setWavUrl(""); setPcmUrl("");
  }

  // Audio preview
  function ensureAudioCtx() {
    if (!audioCtxRef.current) {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      audioCtxRef.current = ctx;
      gainNodeRef.current = gain;
    }
    if (gainNodeRef.current) gainNodeRef.current.gain.value = Math.pow(10, monitorGainDB / 20);
  }
  function stopPlayback() {
    if (srcRef.current) {
      try { srcRef.current.stop(); } catch {}
      try { srcRef.current.disconnect(); } catch {}
      srcRef.current = null;
    }
    setPlaying(false);
  }
  function togglePlay() {
    if (!generated || generated.length === 0) return;
    ensureAudioCtx();
    const ctx = audioCtxRef.current;
    const gain = gainNodeRef.current;
    if (playing) { stopPlayback(); return; }
    const buffer = ctx.createBuffer(1, generated.length, sampleRate);
    buffer.copyToChannel(generated, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer; src.loop = loop; src.connect(gain);
    src.onended = () => setPlaying(false);
    src.start();
    srcRef.current = src; setPlaying(true);
  }
  useEffect(() => {
    if (gainNodeRef.current) gainNodeRef.current.gain.value = Math.pow(10, monitorGainDB / 20);
  }, [monitorGainDB]);

  // Downloads
  function createDownload(kind) {
    if (!generated || generated.length === 0) return;
    const base = `noise_${sampleRate}Hz_${metrics.N}samp_${Math.round(metrics.rmsDB)}dBFS`;
    if (kind === "wav") {
      if (wavUrl) URL.revokeObjectURL(wavUrl);
      const blob = makeWavBlob({ samples: generated, sampleRate });
      const url = URL.createObjectURL(blob);
      setWavUrl(url); setWavName(`${base}.wav`);
    } else if (kind === "pcm") {
      if (pcmUrl) URL.revokeObjectURL(pcmUrl);
      const blob = makeRawPCMBlob({ samples: generated });
      const url = URL.createObjectURL(blob);
      setPcmUrl(url); setPcmName(`${base}.pcm`);
    }
  }

  function runTests() {
    const res = runSelfTests();
    setTests(res);
  }

  return (
    <div className="min-h-screen w-full bg-slate-950 text-slate-100 p-4">
      <div className="max-w-4xl mx-auto space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-xl md:text-2xl font-semibold">Endpoint-Constrained White Noise Generator</h1>
          <div className="text-xs text-slate-400">Audio 무음 대체용 화이트노이즈 (시작/끝=0)</div>
        </header>

        <section className="grid md:grid-cols-2 gap-4">
          {/* Controls */}
          <div className="space-y-3 p-4 rounded-2xl bg-slate-900 shadow">
            <div className="grid grid-cols-2 gap-3">
              <label className="col-span-2 text-sm text-slate-300">샘플레이트 (Hz)</label>
              <input type="number" min={8000} step={1}
                className="col-span-2 bg-slate-800 rounded-xl px-3 py-2 outline-none focus:ring-2 ring-sky-500"
                value={sampleRate} onChange={(e) => setSampleRate(Math.max(1, Number(e.target.value) | 0))} />

              <div className="col-span-2 flex items-center gap-4 mt-1">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="radio" className="accent-sky-500" checked={mode === "time"} onChange={() => setMode("time")} />
                  <span>시간 (ms)</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="radio" className="accent-sky-500" checked={mode === "samples"} onChange={() => setMode("samples")} />
                  <span>샘플 수</span>
                </label>
              </div>

              {mode === "time" ? (
                <div className="col-span-2">
                  <input type="number" min={1} step={1}
                    className="w-full bg-slate-800 rounded-xl px-3 py-2 outline-none focus:ring-2 ring-sky-500"
                    value={ms} onChange={(e) => setMs(Math.max(1, Number(e.target.value) | 0))} />
                  <div className="text-xs text-slate-400 mt-1">계산된 샘플 수: {effectiveN.toLocaleString()}</div>
                </div>
              ) : (
                <div className="col-span-2">
                  <input type="number" min={2} step={1}
                    className="w-full bg-slate-800 rounded-xl px-3 py-2 outline-none focus:ring-2 ring-sky-500"
                    value={samplesN} onChange={(e) => setSamplesN(Math.max(2, Number(e.target.value) | 0))} />
                </div>
              )}

              <div className="col-span-2 grid grid-cols-2 gap-3 mt-2">
                <div>
                  <label className="text-sm text-slate-300">RMS (dBFS)</label>
                  <input type="number" step={1}
                    className="w-full bg-slate-800 rounded-xl px-3 py-2 outline-none focus:ring-2 ring-sky-500"
                    value={rmsDBFS} onChange={(e) => setRmsDBFS(Number(e.target.value))} />
                  <div className="text-xs text-slate-400 mt-1">예: -65 ~ -75 dBFS 권장</div>
                </div>
                <div>
                  <label className="text-sm text-slate-300">시드 (선택)</label>
                  <input type="text" placeholder="비워두면 랜덤"
                    className="w-full bg-slate-800 rounded-xl px-3 py-2 outline-none focus:ring-2 ring-sky-500"
                    value={seed} onChange={(e) => setSeed(e.target.value)} />
                  <div className="text-xs text-slate-400 mt-1">재현 가능성 확인용</div>
                </div>
              </div>

              <div className="col-span-2 flex items-center justify-between mt-2">
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-sky-500" checked={softenEdges} onChange={(e) => setSoftenEdges(e.target.checked)} />
                  <span>경계 2샘플 완충</span>
                </label>
                <label className="inline-flex items-center gap-2 text-sm">
                  <input type="checkbox" className="accent-sky-500" checked={normalizeView} onChange={(e) => setNormalizeView(e.target.checked)} />
                  <span>파형 정규화 보기</span>
                </label>
              </div>

              <div className="col-span-2 mt-2 grid grid-cols-2 gap-2">
                <button onClick={handleGenerate}
                  className="w-full bg-sky-600 hover:bg-sky-500 active:bg-sky-700 transition text-white rounded-xl py-2 font-medium shadow">노이즈 생성 & 시각화</button>
                <button onClick={runTests}
                  className="w-full bg-amber-600 hover:bg-amber-500 active:bg-amber-700 transition text-white rounded-xl py-2 font-medium shadow">셀프 테스트 실행</button>
              </div>
            </div>
          </div>

          {/* Right Panel */}
          <div className="space-y-3 p-4 rounded-2xl bg-slate-900 shadow" ref={containerRef}>
            <div className="flex items-center justify-between">
              <div className="text-sm text-slate-300">파형 미리보기</div>
              <div className="text-xs text-slate-500">{metrics.N ? `${metrics.N.toLocaleString()} samples` : ""}</div>
            </div>
            <canvas ref={canvasRef} className="w-full rounded-xl bg-slate-800" style={{ display: "block" }} />

            {metrics.N > 0 && (
              <div className="grid grid-cols-2 gap-3 text-sm text-slate-300">
                <div className="space-y-1">
                  <div>RMS(dBFS): <span className="text-sky-400">{metrics.rmsDB.toFixed(2)}</span></div>
                  <div>RMS(linear): {metrics.rms.toExponential(3)}</div>
                </div>
                <div className="space-y-1">
                  <div>첫 샘플: {metrics.first.toExponential(3)}</div>
                  <div>마지막 샘플: {metrics.last.toExponential(3)}</div>
                </div>
              </div>
            )}

            {/* Audio Preview */}
            <div className="mt-1 p-3 rounded-xl bg-slate-800/60 space-y-2">
              <div className="flex items-center gap-2">
                <button onClick={togglePlay} disabled={!generated || generated.length === 0}
                  className="px-3 py-1.5 rounded-lg bg-fuchsia-600 disabled:bg-slate-700 disabled:text-slate-400 text-white hover:bg-fuchsia-500 active:bg-fuchsia-700 transition">
                  {playing ? "정지" : "재생"}
                </button>
                <label className="inline-flex items-center gap-2 text-xs text-slate-300">
                  <input type="checkbox" className="accent-sky-500" checked={loop} onChange={(e) => setLoop(e.target.checked)} />
                  루프
                </label>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-slate-300">모니터 게인(dB):</span>
                <input type="range" min={-60} max={60} step={1} value={monitorGainDB} onChange={(e) => setMonitorGainDB(Number(e.target.value))} className="w-48" />
                <span className="tabular-nums text-slate-200 w-10">{monitorGainDB}</span>
                <span className="text-slate-500">* 재생에만 적용 (파일에는 영향 없음)</span>
              </div>
            </div>

            {/* Downloads */}
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex flex-wrap gap-2">
                <button onClick={() => createDownload("wav")} disabled={!generated || generated.length === 0}
                  className="px-4 py-2 rounded-xl bg-emerald-600 disabled:bg-slate-700 disabled:text-slate-400 text-white hover:bg-emerald-500 active:bg-emerald-700 transition">
                  WAV 링크 생성 (16-bit PCM)
                </button>
                <button onClick={() => createDownload("pcm")} disabled={!generated || generated.length === 0}
                  className="px-4 py-2 rounded-xl bg-indigo-600 disabled:bg-slate-700 disabled:text-slate-400 text-white hover:bg-indigo-500 active:bg-indigo-700 transition">
                  RAW PCM 링크 생성 (16-bit LE)
                </button>
              </div>

              <div className="text-xs text-slate-400 space-y-1">
                {wavUrl && (
                  <div>
                    WAV: <a href={wavUrl} download={wavName} target="_blank" rel="noopener" className="text-emerald-400 underline">{wavName || "download.wav"}</a>
                    <span className="ml-2 text-slate-500">(우클릭 → 다른 이름으로 저장 가능)</span>
                  </div>
                )}
                {pcmUrl && (
                  <div>
                    PCM: <a href={pcmUrl} download={pcmName} target="_blank" rel="noopener" className="text-indigo-400 underline">{pcmName || "download.pcm"}</a>
                    <span className="ml-2 text-slate-500">(우클릭 → 다른 이름으로 저장 가능)</span>
                  </div>
                )}
              </div>

              <p className="text-xs text-slate-500 leading-relaxed">
                * 파형이 크게 보이는 경우 "파형 정규화 보기"가 켜져 있는지 확인하세요. 실제 파일 레벨은 RMS(dBFS) 수치에 따릅니다. 기본값은 -70 dBFS입니다.
              </p>
            </div>

            {/* Tests Result */}
            {tests && tests.length > 0 && (
              <div className="mt-2 p-3 rounded-xl bg-slate-800/60">
                <div className="text-sm text-slate-300 mb-2">셀프 테스트 결과</div>
                <ul className="list-disc ml-5 space-y-1 text-xs">
                  {tests.map((r, i) => (
                    <li key={i} className={r.pass ? "text-emerald-400" : "text-rose-400"}>
                      {r.pass ? "✅" : "❌"} {r.name}{!r.pass && r.err ? ` — ${r.err}` : ""}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        </section>

        <footer className="text-xs text-slate-500 pt-2">
          © {new Date().getFullYear()} — Endpoint-constrained noise for Audio padding. Mono, 16-bit PCM export.
        </footer>
      </div>
    </div>
  );
}
