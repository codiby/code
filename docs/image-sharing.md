# Share images with a Codiby session

From Photos, Files, a gallery or another app, select **1–4 images → Share →
Codiby Code**. Pick an active session, optionally add a message, and tap **Enviar**.
The picker shows the session name, host and project folder and supports search.
It sends directly from the share screen; opening the React Native chat first is
not required. Nothing is sent until the user selects a destination and confirms.

Open Codiby Code once after installing this version so it can synchronize the
configured hosts with the native share receiver. Changes or removals in Settings
also update that native configuration. Images and their URI grants stay within
the share operation; the native mirror contains host configuration, not images.

## Android

`ShareImageActivity` handles `ACTION_SEND` and `ACTION_SEND_MULTIPLE` with the
`image/*` MIME type. It reads `EXTRA_STREAM` or `ClipData` content URIs while the
sender's temporary permission remains valid. No broad media-library permission
is requested. Images are decoded off the UI thread, downsampled, corrected for
EXIF orientation and encoded with a 1920-pixel size limit.

The native picker works on cold start and does not require Metro. It uses the
existing configured hosts and respects forced local/remote route modes. A failed
GET can try the configured fallback URL. POSTs are not retried automatically;
a lost response may follow a successful send. Errors keep the selected images
and message available for the user to inspect and retry.

## iOS signing setup

The `CodibyShare` target is an embedded, native Share Extension. It uses
`NSItemProvider` to load images, ImageIO to downsample and orient them, and the
same authenticated session/message API as Android. It does not open its
containing app through private APIs.

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

# On macOS: real Swift client + isolated HTTP fixture, no account or real host needed
python3 packages/mobile/scripts/test-ios-share.py

# Compile the extension alone, without React Native dependencies or signing
cd packages/mobile
xcodebuild -project ios/CodibyCode.xcodeproj -target CodibyShare \
  -configuration Debug -sdk iphonesimulator CODE_SIGNING_ALLOWED=NO build
```

The Android integration check uses a separate fixture app with its own content
provider to exercise real cross-app URI grants. It covers single/multiple images,
no send on receipt, the selected session and authorization header, a failed POST,
manual retry with retained attachments, and cancellation without a POST.
