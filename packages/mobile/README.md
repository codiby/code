# @codiby/mobile

Codiby Code for iOS and Android, built with React Native. The native clients
connect to the same Codiby hosts as the desktop and web clients. This directory
contains the complete app, native projects, Jest tests and Fastlane configuration.

## Install

Use Bun 1.4.4 or newer and install from the repository root:

```sh
bun install --frozen-lockfile
```

The root `bun.lock` covers every workspace. `installConfig.hoistingLimits` keeps
this app's dependency tree inside `packages/mobile/node_modules`, so its React
Native, React and Tailwind versions resolve independently of Electron and the
web UI. Do not add a separate mobile lockfile or install dependencies with npm.

## iOS

Install full Xcode, open it once to finish component setup, and use Ruby 3.3.
From this directory:

```sh
bundle install
cd ios
bundle exec pod install --deployment
```

From the repository root, start Metro with `bun run mobile:start`, then run
`bun run mobile:ios` in another terminal. The Xcode workspace is
`packages/mobile/ios/CodibyCode.xcworkspace`.

## Android

Install Android Studio, the Android SDK and JDK 17. Start an emulator or connect
a device, start Metro with `bun run mobile:start`, then run
`bun run mobile:android` from the repository root. Configure the local SDK in
`android/local.properties` or through `ANDROID_HOME`; local paths stay untracked.

## Tests

```sh
# From the repository root
bun run mobile:test --runInBand
```

Jest supplies the React Native mocks. The root Bun test runner excludes this
directory and continues to run the bridge and web tests separately.

## TestFlight

The [TestFlight workflow](../../.github/workflows/testflight.yml) compiles this
workspace on GitHub's macOS runner. See [Apple setup and repository secrets](../../docs/testflight.md).

The app was imported from `codiby/android-app`, including the current uncommitted
source changes. Mobile development now lives here alongside desktop in
`codiby/code`; the original checkout was retained as a migration backup.

## Share images from other apps

Select 1–4 images in another app, choose **Share → Codiby Code**, select a session,
and confirm the message. Both platforms show the same React Native session rows
and chat composer used in the app. Android receives native share intents; iOS
embeds that React Native screen in its Share Extension. Open Codiby Code once after installing so the share picker can
use your configured hosts. See [image sharing and iOS signing setup](../../docs/image-sharing.md).

## Push notifications

The **Agent** tab shows the agent host's status and pending approvals, and the
app receives its approvals and messages as push notifications through Firebase
Cloud Messaging (Android directly, iOS through APNs). Approvals carry
**Approve** / **Deny** buttons that answer the host without opening the app.
The bridge side and the setup checklist live in Codiby Code → Agent → Devices.

Until the Firebase files below exist, both platforms build exactly as before
and the Agent tab says push isn't set up in this build.

1. In the [Firebase console](https://console.firebase.google.com), add Firebase
   to the Google Cloud project the agent already uses, then add two apps:
   Android `com.codiby.code` and iOS `com.codiby.code`.
2. **Android:** save `google-services.json` as `android/app/google-services.json`.
   `android/app/build.gradle` applies the Google services plugin only when that
   file exists. Rebuild with `bun run mobile:android`.
3. **iOS:** save `GoogleService-Info.plist` as `ios/CodibyCode/GoogleService-Info.plist`.
   A build phase copies it into the app, and `react-native.config.js` and
   `ios/Podfile` then link React Native Firebase and the notification module,
   with the dynamic frameworks Firebase's Swift packages require. Run
   `bun run mobile:pods` and commit the updated `ios/Podfile.lock`.
4. **APNs:** in the Apple Developer portal, enable **Push Notifications** for the
   `com.codiby.code` App ID, regenerate the App Store provisioning profile and
   update `IOS_PROVISIONING_PROFILE_BASE64`. Until then the TestFlight lane removes
   `aps-environment` and ships a build without push instead of failing to sign it.
   Create an APNs authentication key (`.p8`) and upload it in Firebase → Project
   settings → Cloud Messaging → Apple app configuration.
5. In Firebase → Project settings → Service accounts, generate a private key and
   upload the JSON in Codiby Code → Agent → Devices on the agent host.

Open the Agent tab once on the phone: it asks for notification permission and
registers the phone with every host whose agent is on. **Send test push** checks
the whole path.
