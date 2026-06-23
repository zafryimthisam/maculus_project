module.exports = {
  preset: 'react-native',
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!(react-native|@react-native|react-native-background-timer|react-native-tts|react-native-fast-tflite)/)',
  ],
  moduleNameMapper: {
    '\\.(tflite)$': '<rootDir>/__mocks__/fileMock.js',
  },
};
