import React, { useMemo, useRef, useState } from 'react';
import { generateEndpointConstrainedWhiteNoise } from './lib/noise';
import { encodeWav16bitPCM, downloadWav } from './lib/wav';

function clamp(v: number, min: number, max: number) { return Math.min(max, Math.max(min, v)); }

export default function App() {
  const [sampleRate, setSampleRate] = useState<number>(24000);
  const [mode, setMode] = useState<'duration' | 'samples'>('duration');
  const [durationMs, setDurationMs] = useState<number>(300);
  const [sampleCountInput, setSampleCountInput] = useState<number>(Math.round(24000 * 0.3));
  const [distribution, setDistribution] = useState<'gaussian' | 'uniform'>('gaussian');
  const [targetRmsDbfs, setTargetRmsDbfs] = useState<number>(-80);
  const [zeroEndpoints, setZeroEndpoints] = useState<boolean>(true);
  const [dcRemoval, setDcRemoval] = useState<boolean>(true);
  const [seedEnabled, setSeedEnabled] = useState<boolean>(false);
  const [seed, setSeed] = useState<number>(1234);

  const [generated, setGenerated] = useState<Float32Array | null>(null);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);

  const audioCtxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);

  const sampleCount = useMemo(() => {
    if (mode === 'duration') return Math.max(1, Math.round(sampleRate * (durationMs / 1000)));
    return Math.max(1, Math.floor(sampleCountInput));
  }, [mode, sampleRate, durationMs, sampleCountInput]);

  const effectiveDurationMs = useMemo(() => (sampleCount / sampleRate) * 1000, [sampleCount, sampleRate]);

  function ensureCtx() {
    if (!audioCtxRef.current) {
      audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    return audioCtxRef.current!;
  }

  function doGenerate(): Float32Array {
    const arr = generateEndpointConstrainedWhiteNoise({
      sampleRate,
      sampleCount,
      distribution,
      targetRmsDbfs,
      zeroEndpoints,
      dcRemoval,
      seed: seedEnabled ? seed : undefined,
    });
    setGenerated(arr);
    return arr;
  }

  function handlePlay() {
    const ctx = ensureCtx();
    const data = generated ?? doGenerate();

    // Stop any previous
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    const buf = ctx.createBuffer(1, data.length, sampleRate);
    buf.copyToChannel(data, 0);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    src.onended = () => setIsPlaying(false);

    // Resume context if suspended (autoplay policy)
    if (ctx.state === 'suspended') ctx.resume();

    src.start();
    sourceRef.current = src;
    setIsPlaying(true);
  }

  function handleStop() {
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }
    setIsPlaying(false);
  }

  function handleDownload() {
    const data = generated ?? doGenerate();
    const bytes = encodeWav16bitPCM(data, sampleRate);
    const fname = `noise_${distribution}_${targetRmsDbfs}dBFS_${sampleRate}Hz_${data.length}smp.wav`;
    downloadWav(bytes, fname);
  }

  return (
    <div className="container">
      <h1>Endpoint-Constrained White Noise</h1>
      <p className="small">TTS 묵음 구간 대체용, 정확한 샘플수와 무클릭(clickless) 시작/종료를 위한 화이트 노이즈 생성기</p>

      <section>
        <div className="grid-3">
          <div>
            <label>Sample Rate (Hz)</label>
            <input type="number" min={8000} step={1} value={sampleRate}
              onChange={e => setSampleRate(clamp(+e.target.value || 0, 8000, 384000))} />
          </div>

          <div>
            <label>길이 입력 방식</label>
            <select value={mode} onChange={e => setMode(e.target.value as any)}>
              <option value="duration">Duration (ms)</option>
              <option value="samples">Sample Count</option>
            </select>
          </div>

          <div>
            {mode === 'duration' ? (
              <>
                <label>Duration (ms)</label>
                <input type="number" min={1} step={1} value={durationMs}
                  onChange={e => setDurationMs(clamp(+e.target.value || 0, 1, 60_000))} />
              </>
            ) : (
              <>
                <label>Sample Count</label>
                <input type="number" min={1} step={1} value={sampleCountInput}
                  onChange={e => setSampleCountInput(Math.max(1, Math.floor(+e.target.value || 1)))} />
              </>
            )}
          </div>
        </div>

        <div className="grid">
          <div>
            <label>Distribution</label>
            <select value={distribution} onChange={e => setDistribution(e.target.value as any)}>
              <option value="gaussian">Gaussian (Box–Muller)</option>
              <option value="uniform">Uniform [-1, 1]</option>
            </select>
          </div>
          <div>
            <label>Target RMS (dBFS)</label>
            <input type="number" step={1} value={targetRmsDbfs}
              onChange={e => setTargetRmsDbfs(clamp(+e.target.value || -80, -150, 0))} />
            <div className="small">예: -80 dBFS ≈ 매우 작은(거의 안 들리는) 레벨</div>
          </div>
        </div>

        <div className="grid">
          <label className="row">
            <input type="checkbox" checked={zeroEndpoints} onChange={e => setZeroEndpoints(e.target.checked)} />
            시작/끝 샘플 0 고정 (선형 성분 제거)
          </label>
          <label className="row">
            <input type="checkbox" checked={dcRemoval} onChange={e => setDcRemoval(e.target.checked)} />
            DC 제거 (평균 0)
          </label>
        </div>

        <div className="grid">
          <label className="row">
            <input type="checkbox" checked={seedEnabled} onChange={e => setSeedEnabled(e.target.checked)} />
            고정 시드 사용 (재현 가능)
          </label>
          <div className="row">
            <input type="number" value={seed} onChange={e => setSeed(Math.floor(+e.target.value || 0))} />
            <button className="ghost" onClick={() => setSeed((Math.random() * 1e9) | 0)}>랜덤 시드</button>
          </div>
        </div>

        <div className="row" style={{ marginTop: '.5rem', gap: '.75rem' }}>
          <button className="primary" onClick={() => { doGenerate(); handlePlay(); }} disabled={isPlaying}>생성 & 재생</button>
          <button className="secondary" onClick={handleStop} disabled={!isPlaying}>정지</button>
          <button onClick={handleDownload}>WAV 다운로드</button>
        </div>

        <hr />

        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="badge">샘플수: {sampleCount.toLocaleString()} samples</div>
          <div className="badge">길이: {effectiveDurationMs.toFixed(2)} ms</div>
        </div>
      </section>

      <section>
        <b>설명</b>
        <ul>
          <li>엔드포인트 제약: 내부적으로 첫/마지막 샘플을 0으로 만들기 위해 랜덤 노이즈의 선형 성분을 제거합니다. 별도의 페이드/윈도우를 추가하지 않아도 클릭이 억제됩니다.</li>
          <li>RMS 정규화: 목표 dBFS(RMS)에 맞추어 전체 레벨을 스케일합니다. 너무 큰 값일 경우 자동으로 클리핑을 방지합니다.</li>
          <li>정확한 샘플수: 원하는 샘플수를 그대로 출력하므로 TTS 프레임 경계에 정확히 맞출 수 있습니다.</li>
        </ul>
      </section>

      <div className="footer">© {new Date().getFullYear()} Endpoint-Constrained White Noise</div>
    </div>
  );
}
