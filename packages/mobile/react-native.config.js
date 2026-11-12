const fs = require('fs');
const path = require('path');

/**
 * Push notifications on iOS need Firebase, and Firebase needs both
 * GoogleService-Info.plist and dynamic frameworks (see ios/Podfile). Until the
 * plist is in place, the push modules are left out of iOS autolinking, so
 * `pod install` and TestFlight builds keep the exact pods they had. Android
 * always links them: without google-services.json Firebase just stays off.
 */
const firebaseIos = fs.existsSync(
  path.join(__dirname, 'ios', 'CodibyCode', 'GoogleService-Info.plist'),
);
const iosOnlyWithFirebase = firebaseIos ? {} : { platforms: { ios: null } };

module.exports = {
  dependencies: {
    '@react-native-firebase/app': iosOnlyWithFirebase,
    '@react-native-firebase/messaging': iosOnlyWithFirebase,
    'react-native-notify-kit': iosOnlyWithFirebase,
  },
};
