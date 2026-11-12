/* eslint-env jest */
/**
 * Minimal react-native-notify-kit (notifee API) for Jest: the calls src/push
 * makes, recorded, and the enums it reads. The package's own jest-mock.js is
 * untranspiled ESM, which this preset doesn't transform under node_modules.
 */

const notifee = {
  createChannels: jest.fn(async () => undefined),
  setNotificationCategories: jest.fn(async () => undefined),
  displayNotification: jest.fn(
    async notification => notification.id ?? 'generated-id',
  ),
  cancelNotification: jest.fn(async () => undefined),
  getNotificationSettings: jest.fn(async () => ({ authorizationStatus: -1 })),
  requestPermission: jest.fn(async () => ({ authorizationStatus: 1 })),
  openNotificationSettings: jest.fn(async () => undefined),
  onForegroundEvent: jest.fn(() => () => undefined),
  onBackgroundEvent: jest.fn(),
  getInitialNotification: jest.fn(async () => null),
};

module.exports = {
  __esModule: true,
  default: notifee,
  EventType: {
    UNKNOWN: -1,
    DISMISSED: 0,
    PRESS: 1,
    ACTION_PRESS: 2,
    DELIVERED: 3,
  },
  AuthorizationStatus: {
    NOT_DETERMINED: -1,
    DENIED: 0,
    AUTHORIZED: 1,
    PROVISIONAL: 2,
  },
  AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2, MIN: 1, NONE: 0 },
  AndroidVisibility: { PRIVATE: 0, PUBLIC: 1, SECRET: -1 },
  AndroidStyle: { BIGPICTURE: 0, BIGTEXT: 1, INBOX: 2, MESSAGING: 3 },
  AndroidCategory: { REMINDER: 'reminder', MESSAGE: 'msg' },
};
