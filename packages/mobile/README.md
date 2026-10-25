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
