/* eslint-env jest */
/**
 * Native push modules have no JS fallback; tests get inert stand-ins so any
 * import path that reaches them loads. src/push/native.ts only requires them
 * when their TurboModule is linked, which it never is under Jest — tests that
 * exercise push mock src/push/native directly (see __tests__/push*.test.ts).
 */

jest.mock('@react-native-firebase/app', () => ({
  getApps: jest.fn(() => []),
  getApp: jest.fn(),
}));

jest.mock('@react-native-firebase/messaging', () => ({
  getMessaging: jest.fn(() => ({})),
  getToken: jest.fn(async () => 'test-fcm-token'),
  onMessage: jest.fn(() => () => undefined),
  onTokenRefresh: jest.fn(() => () => undefined),
  onNotificationOpenedApp: jest.fn(() => () => undefined),
  getInitialNotification: jest.fn(async () => null),
  setBackgroundMessageHandler: jest.fn(),
}));

jest.mock('react-native-notify-kit', () => require('./jest/notifyKitMock'));
