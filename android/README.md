# Daddy-Do for Android (Trusted Web Activity)

A thin Android wrapper that opens https://daddy-do.pages.dev full-screen through Chrome. Web changes reach the app instantly, so you only rebuild this to change the app's name, icon, version or package settings.

- Package: `dev.pages.daddy_do.twa` · minSdk 24 (Android 7+) · notifications delegated to Chrome.
- Generated with Bubblewrap from `twa-manifest.json`, then edited:
  - `minSdkVersion 24`, which androidbrowserhelper requires;
  - Google's Maven Central mirror added to `build.gradle`.
- The site proves it owns the app through `public/.well-known/assetlinks.json`, which holds the SHA-256 of the signing key. Without that file the app shows a browser address bar.

## Build

Requires JDK 17 and the Android SDK (`local.properties` → `sdk.dir=...`). The signing keystore is **not** in git.

```bash
cd android
./gradlew assembleRelease bundleRelease
BT=$ANDROID_HOME/build-tools/<version>
$BT/zipalign -f -p 4 app/build/outputs/apk/release/app-release-unsigned.apk aligned.apk
$BT/apksigner sign --ks daddy-do-release.keystore --ks-key-alias daddydo --out daddy-do.apk aligned.apk
```

For each new release, bump `versionCode` in `app/build.gradle` and sign with the **same keystore**. Android refuses to update an app signed with a different key, so the keystore is needed for every future update.
