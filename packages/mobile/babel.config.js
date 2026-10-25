module.exports = {
  presets: ['module:@react-native/babel-preset', 'nativewind/babel'],
  // Debe ir siempre al final de la lista de plugins.
  plugins: ['react-native-worklets/plugin'],
};
