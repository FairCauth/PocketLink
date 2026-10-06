# Third-party audio components

PocketLink uses [@sapphi-red/web-noise-suppressor 0.4.1](https://github.com/sapphi-red/web-noise-suppressor) (MIT) for its RNNoise AudioWorklet, built with [@shiguredo/rnnoise-wasm 2022.2.0](https://github.com/shiguredo/rnnoise-wasm/tree/2022.2.0) (Apache-2.0) and [Xiph RNNoise](https://github.com/xiph/rnnoise) (BSD-3-Clause).

The local distribution in `html/dist/vendor/rnnoise/` contains the original license texts. The worklet and non-SIMD WASM binary are generated from the pinned npm package by `npm run build:static`. These assets are checked in so existing one-click launchers and offline LAN sessions do not need another build or external CDN.

PocketLink modifies the worklet to start its message port and report initialization success/failure. This lets the microphone keep passing audio until the denoiser is ready, fall back if loading fails, and release the processor when disabled. The build checks exact patch locations and fails if an upstream update requires review. RNNoise's DSP and model are unchanged.
