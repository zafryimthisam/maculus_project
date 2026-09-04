module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-background-timer|react-native-tts|react-native-fast-tflite)/)',
  ],
  moduleNameMapper: {
    '\\.(wav)$': '<rootDir>/__mocks__/fileMock.js',
    '\\.(tflite)$': '<rootDir>/__mocks__/fileMock.js',
  },
};
