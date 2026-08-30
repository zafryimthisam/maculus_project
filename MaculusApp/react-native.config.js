module.exports = {
  dependencies: {
    // iOS uses Apple's native FastVLM Core ML + MLX framework. Keep llama.rn
    // linked on Android only so the iOS binary does not carry two VLM engines.
    'llama.rn': {
      platforms: {
        ios: null,
      },
    },
  },
};
