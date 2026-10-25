# Android APK builds

The **Android APK** GitHub Actions workflow builds the React Native app from
`packages/mobile`. It runs automatically when mobile source, dependency files,
or the workflow change on `main` or in a pull request. You can also run it from
**Actions → Android APK → Run workflow**.

Each run installs the locked dependencies, runs mobile Jest tests and TypeScript,
builds a release APK for **ARM64**, and verifies its signature. The version includes
a UTC timestamp, run number and attempt so builds can be distinguished in Settings.

Download the `android-apk-<run>-<attempt>` artifact from the run summary and unzip
it. It contains the versioned `.apk`, its SHA-256 checksum and Android build
metadata. GitHub retains these downloads for 30 days. These builds use the same
existing development signing key as the APKs shared through Funnel, allowing
installation over them. This workflow does not publish to Google Play or Funnel.
No repository secrets are required.

## Local build

From the repository root, install dependencies:

```sh
bun install --frozen-lockfile
```

With JDK 17 and `ANDROID_HOME` pointing to your SDK, run:

```sh
cd packages/mobile/android
./gradlew assembleRelease \
  -PreactNativeArchitectures=arm64-v8a \
  -PbuildStamp="$(date -u +%Y%m%d.%H%M)"
```

The APK is generated at
`packages/mobile/android/app/build/outputs/apk/release/app-release.apk`.
The workflow installs the SDK, build tools, NDK and CMake versions matching the
native project. Keep these in sync when upgrading Android or React Native.
