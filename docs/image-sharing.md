# Share images with a Codiby session

Select **1–4 images → Share → Codiby Code**, choose a conversation, optionally
add a message, then tap **Enviar**. Nothing is sent before confirmation.

The share UI is **React Native on both platforms**. `src/ShareApp.tsx` reuses the
actual `SessionRow` and separator from Home and `Composer` from the conversation.
There is no separate Android widget layout or SwiftUI copy of those components.
Host colors, avatars, timestamps, pinned order, previews, selected rows, attachment
thumbnails and the send button follow the app's existing components.

Open Home once after installing to synchronize configured hosts and recent chats.
The private native mirror stores host configuration and chat-list metadata, not
images. ShareApp paints that saved list, refreshes hosts independently and races
LAN/internet GETs. A slow host retains its cached chats. Reads validate the selected
chat and current route before a single POST; a failed POST is never retried
automatically. The existing Composer restores the caption and attachments on error.

## Native image ingress

Android's `ShareImageActivity` is a `ReactActivity` mounting `CodibyShare`. It only
reads `ACTION_SEND`/`ACTION_SEND_MULTIPLE` temporary content URI grants and prepares
images off the UI thread. No broad media-library permission is requested.

On iOS, `CodibyShare` is a Share Extension hosting the same `CodibyShare` React Native
component. `NSItemProvider` supplies images; ImageIO downsamples and corrects
orientation. The extension has its own `share.index.js` bundle and links React
Native, SVG and Safe Area dependencies. App-only animation/gallery modules are
loaded lazily and are not needed by the extension.

Both bridges return the prepared images and shared configuration to JavaScript;
list refresh and message submission use the app's existing TypeScript API client.
Native image processing retains the 1920-pixel size limit, JPEG compression and
white background for transparent images. Native completion dismisses the share
activity or extension after a successful send.

## iOS signing setup

Both targets use the App Group **`group.com.codiby.code`** to share the host
configuration. To sign and distribute on a physical iPhone:

1. Register the extension App ID **`com.codiby.code.share`** with the same Apple
   team as **`com.codiby.code`**.
2. Enable App Groups for both App IDs and associate **`group.com.codiby.code`**.
3. Regenerate the main app's provisioning profile with that group and create a
   separate profile for the extension. Select the corresponding team and profiles
   for `CodibyCode` and `CodibyShare` in Xcode.
4. For Fastlane/TestFlight, keep the updated main profile in
   `IOS_PROVISIONING_PROFILE_BASE64` and provide the extension profile in
   **`IOS_SHARE_PROVISIONING_PROFILE_BASE64`**. The lane validates the team, bundle
   ID, expiry and App Group of both profiles and exports both signed targets.
   A GitHub workflow invoking this lane must map the new secret into its environment.

See Apple's [App Groups setup](https://developer.apple.com/documentation/xcode/configuring-app-groups).
The simulator extension and full app can be compiled without distribution credentials.

## Verification

```sh
# Repository root
bun run mobile:test --runInBand

# Android: compile the actual React Native release, then native unit tests
cd packages/mobile
JAVA_HOME=/opt/homebrew/opt/openjdk@17 android/gradlew -p android \
  assembleRelease :app:testDebugUnitTest -PreactNativeArchitectures=arm64-v8a

# macOS: install the app and extension Pods, then build both simulator targets
bundle exec pod install --project-directory=ios
xcodebuild -workspace ios/CodibyCode.xcworkspace -scheme CodibyCode \
  -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build
```

`ShareScreen.test.tsx` mounts the real SessionRow and Composer with an incoming
image and a pending network request. It checks selection, explicit send, error
restoration and successful completion. `incomingShare.test.ts` checks cross-host
identities, pinned order, accent-insensitive search, a stalled LAN, one POST and
archived-session rejection. These replace the former duplicated Swift REST tests.

The Android integration fixture is a separate app with its own content provider;
it exercises real cross-app URI grants, cold React Native startup without Metro,
single/multiple images, correct session/auth/payload, failure and manual retry,
cancellation, search, the keyboard and receiving a share while the main app is open.
