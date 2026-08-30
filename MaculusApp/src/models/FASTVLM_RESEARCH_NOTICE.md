# Apple FastVLM research model

The iOS research build uses **Apple FastVLM-1.5B INT8** from
[`apple/ml-fastvlm`](https://github.com/apple/ml-fastvlm), pinned to source
commit `592b4add3c1c8a518e77d95dc6248e76c1dd591f`.

The model is downloaded from Apple's official model CDN by
`scripts/build-ios-unsigned.sh` and embedded in the iOS application. The model
weights are not stored in this Git repository. The build also embeds exact
copies of Apple's software license, model license, and acknowledgements in
`FastVLM.framework`.

The pinned 1.5B INT8 archive is 2,053,787,552 bytes. Apple's CDN does not
publish a SHA-256 for this archive; the build enforces the official HTTPS host,
exact filename, expected size, expected model structure, and pinned source
implementation.

FastVLM's weights are licensed exclusively for non-commercial scientific
research and academic development. They are not licensed for commercial
exploitation, product development, or use in a commercial product or service.
Read the complete terms before building or redistributing the application:

> Apple Machine Learning Research Model is licensed under the Apple Machine
> Learning Research Model License Agreement.

- [Apple FastVLM model license](https://github.com/apple/ml-fastvlm/blob/main/LICENSE_MODEL)
- [Apple FastVLM software license](https://github.com/apple/ml-fastvlm/blob/main/LICENSE)
- [Apple FastVLM acknowledgements](https://github.com/apple/ml-fastvlm/blob/main/ACKNOWLEDGEMENTS)

Maculus does not modify or fine-tune the Apple model weights. The Maculus bridge
adds cancellable inference and a React Native interface around Apple's reference
Core ML + MLX implementation.
