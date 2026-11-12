module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['./jest.setup.js'],
  transformIgnorePatterns: [
    'node_modules/(?!((@)?react-native|react-native-css-interop|nativewind)/)',
  ],
};
