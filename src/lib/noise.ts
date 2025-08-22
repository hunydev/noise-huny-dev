export type NoiseOptions = {
  sampleRate: number;
  sampleCount: number; // exact number of samples to output
  distribution?: 'gaussian' | 'uniform';
  targetRmsDbfs?: number; // e.g., -80 dBFS
  zeroEndpoints?: boolean; // force first & last samples to 0 without extra windowing
  dcRemoval?: boolean; // subtract mean after detrending
  seed?: number; // deterministic generation if provided
};

function createRng(seed?: number): () => number {
  if (seed === undefined) return Math.random;
  // mulberry32
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomGaussian(rng: () => number): number {
  // Box-Muller transform
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function detrendLinearInPlace(data: Float32Array): void {
  const n = data.length;
  if (n < 2) {
    if (n === 1) data[0] = 0;
    return;
  }
  const a = data[0];
  const b = data[n - 1];
  const denom = n - 1;
  for (let i = 0; i < n; i++) {
    const li = a + ((b - a) * i) / denom;
    data[i] = data[i] - li;
  }
  // endpoints now exactly 0
  data[0] = 0;
  data[n - 1] = 0;
}

function removeMeanInPlace(data: Float32Array): void {
  const n = data.length;
  if (n === 0) return;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += data[i];
  const mean = sum / n;
  for (let i = 0; i < n; i++) data[i] -= mean;
}

function rms(data: Float32Array): number {
  const n = data.length;
  if (n === 0) return 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const x = data[i];
    acc += x * x;
  }
  return Math.sqrt(acc / n);
}

export function generateEndpointConstrainedWhiteNoise(opts: NoiseOptions): Float32Array {
  const {
    sampleRate,
    sampleCount,
    distribution = 'gaussian',
    targetRmsDbfs = -80,
    zeroEndpoints = true,
    dcRemoval = true,
    seed,
  } = opts;

  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error('sampleRate must be a positive number');
  }
  const n = Math.max(0, Math.floor(sampleCount));
  const out = new Float32Array(n);
  const rng = createRng(seed);

  // 1) Fill with white noise
  if (distribution === 'gaussian') {
    for (let i = 0; i < n; i++) out[i] = randomGaussian(rng);
  } else {
    for (let i = 0; i < n; i++) out[i] = (rng() * 2 - 1); // uniform [-1, 1]
  }

  // 2) Force endpoints to zero by removing the linear ramp defined by endpoints
  if (zeroEndpoints) {
    detrendLinearInPlace(out);
  }

  // 3) Optional DC removal
  if (dcRemoval) {
    removeMeanInPlace(out);
  }

  // 4) Normalize to target RMS in dBFS (relative to full-scale 1.0)
  const targetRms = Math.pow(10, targetRmsDbfs / 20);
  const currentRms = rms(out);
  if (currentRms > 0 && Number.isFinite(currentRms)) {
    const s = targetRms / currentRms;
    for (let i = 0; i < n; i++) out[i] *= s;
  } else {
    // Pathological case: silence; set to zeros
    out.fill(0);
  }

  // 5) Safety: ensure no clip
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const ax = Math.abs(out[i]);
    if (ax > peak) peak = ax;
  }
  if (peak > 1) {
    const k = 1 / peak;
    for (let i = 0; i < n; i++) out[i] *= k;
  }

  // endpoints remain 0 if zeroEndpoints was used
  if (zeroEndpoints && n >= 1) {
    out[0] = 0;
    if (n > 1) out[n - 1] = 0;
  }

  return out;
}
