export const WAKE_WORD_MODEL = 'hey_livekit.onnx';
export const WAKE_WORD_LABEL = 'Hey LiveKit';
export const WAKE_WORD_THRESHOLD = 0.5;
export const COMMAND_TIMEOUT_MS = 8000;

// Single source of truth for the wake-word token the JS-side grammar parser
// strips from the transcript. Must stay in sync with the asset the wake
// engine was trained on. The user is told to say the WAKE_WORD_LABEL phrase,
// and either form (with or without the leading "Hey") routes through the
// same parser.
export const WAKE_WORD_PARSER_TOKEN = 'livekit';
