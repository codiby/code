# iOS → TestFlight

`.github/workflows/testflight.yml` runs on pushes to `main` that change the mobile
app, root dependency manifests, or this workflow, or manually through
**Actions → iOS TestFlight → Run workflow**. It runs Jest, installs the locked
dependencies from the root `bun.lock`, archives `packages/mobile/ios` in Release
on `macos-26`, signs it, and uploads it
with Fastlane. No local Xcode installation or interactive Apple login is needed on CI.

## One-time Apple setup

1. Use an active paid Apple Developer team. Register the explicit bundle ID
   `com.codiby.code`, and create its iOS app record in App Store Connect.
2. Create an **Apple Distribution** certificate, including its private key, and
   export it from Keychain Access as a password-protected `.p12`.
3. Create an **App Store Connect** distribution provisioning profile for that
   bundle ID, selecting the same distribution certificate. Download the
   `.mobileprovision` file.
4. Create a **team API key** in **App Store Connect → Users and Access →
   Integrations → App Store Connect API**, with **App Manager** access. Keep its
   key ID, issuer ID and downloaded `.p8` private key.

The Mac login password is not a CI credential. CI uses the API key and signing
assets below. Rotate the signing secrets when the certificate or profile expires.

## GitHub repository secrets

Add these to **codiby/code** under **Settings → Secrets and variables → Actions → Repository secrets**:

| Secret | Value |
| --- | --- |
| `APPLE_TEAM_ID` | The Apple Developer team ID. |
| `APP_STORE_CONNECT_KEY_ID` | API key ID. |
| `APP_STORE_CONNECT_ISSUER_ID` | API issuer UUID. |
| `APP_STORE_CONNECT_PRIVATE_KEY` | Full `.p8` contents, including PEM header, footer and newlines. |
| `IOS_DISTRIBUTION_P12_BASE64` | Base64 of the `.p12`, on one line. |
| `IOS_DISTRIBUTION_P12_PASSWORD` | Password used when exporting the `.p12`. |
| `IOS_PROVISIONING_PROFILE_BASE64` | Base64 of the `.mobileprovision`, on one line. |

For example, from an authenticated GitHub CLI on macOS:

```sh
gh secret set APPLE_TEAM_ID
gh secret set APP_STORE_CONNECT_KEY_ID
gh secret set APP_STORE_CONNECT_ISSUER_ID
gh secret set APP_STORE_CONNECT_PRIVATE_KEY < /path/to/AuthKey_KEYID.p8
base64 -i /path/to/distribution.p12 | tr -d '\n' | gh secret set IOS_DISTRIBUTION_P12_BASE64
gh secret set IOS_DISTRIBUTION_P12_PASSWORD
base64 -i /path/to/profile.mobileprovision | tr -d '\n' | gh secret set IOS_PROVISIONING_PROFILE_BASE64
```

Never commit these files or passwords. The job fails before starting a macOS
runner if any required secret is missing. It imports signing assets into a
temporary keychain and removes them after the lane, including on failure.

## Builds and distribution

Fastlane reads the marketing version from the Xcode project and uses the next
TestFlight build number for that version. Uploads are serialized and the job
waits up to 20 minutes for Apple to process the build. A processing timeout can
mean the upload succeeded: check App Store Connect before rerunning.

Configure automatic distribution for your internal tester group in App Store
Connect. The workflow does not submit a public App Store release or request
external beta review. External testing and any export compliance questions must
be completed in App Store Connect.

IPA files, symbols and build logs under `packages/mobile/build/ios` are retained
as workflow artifacts for 14 days. For a local upload with the same environment
variables, run `bun install --frozen-lockfile` at the repository root, run
`bundle install` in `packages/mobile`, then run `bun run mobile:pods` and
`bun run mobile:testflight` from the repository root.
