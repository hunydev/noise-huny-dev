# Endpoint-Constrained White Noise (React + Vite + TS)

Audio 묵음 구간을 0이 아닌, 들리지 않는 화이트 노이즈로 대체하기 위한 **정확한 샘플수**와 **무클릭(clickless) 시작/종료**를 보장하는 웹앱입니다.

- 정확한 샘플수(N) 그대로 생성
- 시작/끝 샘플을 0으로 고정(선형 성분 제거) → 별도의 윈도우/페이드 불필요
- 목표 RMS dBFS로 정규화 (기본 -80 dBFS, 거의 들리지 않음)
- Gaussian / Uniform 분포 선택, DC 제거 옵션, 시드 고정 지원
- WAV(16-bit PCM) 다운로드 지원

## Demo

🎧 **[Live Demo](https://noise.huny.dev)**

웹 브라우저에서 바로 사용해볼 수 있습니다.

## 실행

```bash
# 1) 의존성 설치
npm install

# 2) 개발 서버 실행
npm run dev
```

브라우저에서 http://localhost:5173 접속.

## 빌드

```bash
npm run build
npm run preview
```

## 구현 요점

- `src/lib/noise.ts`: 랜덤 노이즈 생성 후, 첫/마지막 샘플을 그대로 0이 되도록 선형 성분을 제거(detrend)합니다. 그 후 DC 제거와 RMS 스케일링을 수행합니다.
- `src/lib/wav.ts`: 16-bit PCM WAV 인코딩 및 다운로드 유틸리티.
- `src/App.tsx`: UI + 재생/정지/다운로드 로직. 정확한 N 샘플의 버퍼를 생성해 Web Audio API로 재생합니다.

## 주의

- -80 dBFS는 매우 낮은 레벨입니다. 테스트 목적으로 들릴 정도의 레벨을 확인하려면 -40 dBFS 등으로 설정해 비교해 보세요.
- 엔드포인트 제약은 전체 구간에 매우 얕은 선형 성분만 제거하므로, 스펙트럼 왜곡은 실사용에서 무시 가능한 수준입니다.
