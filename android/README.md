# Docket for Android

A native Android app for your Docket server. It shows the full Docket app and adds the things a phone needs:

- **Exact-time reminder alarms on the phone.** The app downloads your upcoming reminders and schedules them as Android alarms. They go off on time even with no internet or with the app closed, survive restarts, and resync about every 15 minutes, whenever you open the app, and right after you change something.
- **No stale reminders.** Before showing a reminder, the app quickly checks with the server, so something you cancelled or rescheduled on another device doesn't ring. If the phone is offline at that moment, it shows the reminder anyway.
- **System notifications** with *Snooze 10 min* and *Dismiss* buttons. Tapping a notification opens that activity.
- **Uploads and downloads.** Attach files from your phone; exports and attachments download to your Downloads folder.
- **Links open in the right app.** Meeting, map, email and phone links open in the matching app (Meet/Zoom, Maps, Gmail, Dialer).
- **Sign in once.** Data stays on your server, so the phone shows the same activities as your other devices.

Requirements: Android 7.0 or newer, and a Docket server reachable from your phone. Use **HTTPS** for a server on the internet; `http://` works only for testing on your own Wi-Fi.

## Get the APK (no Android Studio needed)

1. Create a GitHub repository (private is fine) and upload the whole `docket` folder to it. The `.github` folder must be at the top level of the repo.
2. Open the repo's **Actions** tab. The *Build Android APK* run starts automatically; if it doesn't, click it and press **Run workflow**. It takes about 3–5 minutes.
3. Open the finished run and download **docket-android-apk** under *Artifacts*. Unzip it to get `docket.apk`.
4. Copy `docket.apk` to your phone, open it, and allow "Install unknown apps" for your browser or file manager when asked.
5. Open Docket, enter your server address (for example `https://docket.example.com`), sign in, and tap **Allow** when asked about notifications.

### Installing updates over the old version (optional)

Without a signing key, each GitHub build is signed with a new temporary key. To update, Android then asks you to uninstall the old version first. That's harmless, because your data lives on the server; you only sign in again.

To install updates directly instead, create one permanent key and add it as repository secrets:

```bash
keytool -genkeypair -v -keystore docket.jks -alias docket -keyalg RSA -keysize 2048 -validity 10000
base64 -w0 docket.jks > docket.jks.b64      # macOS: base64 -i docket.jks -o docket.jks.b64
```

In GitHub, go to **Settings › Secrets and variables › Actions** and add `DOCKET_KEYSTORE_BASE64` (the contents of `docket.jks.b64`) and `DOCKET_KEYSTORE_PASSWORD`. Keep `docket.jks` safe and never commit it.

## Build it yourself instead

Open the `android` folder in Android Studio and press Run, or run `./gradlew assembleRelease` with JDK 17 and the Android SDK installed. The app uses only the Android framework, with no third-party libraries.

## Notification settings on the phone

In Docket's **Settings › Reminders & notifications**, the "Android app notifications" panel shows:

- whether notifications are allowed;
- how many reminders are scheduled on this phone;
- when it last synced.

It also has *Sync now*, *Android settings* and *Change server…* buttons.

Some phone makers (Xiaomi, Oppo, Vivo, Huawei, some Samsung modes) aggressively stop background apps. If reminders arrive late, set Docket's battery usage to **Unrestricted** in Android settings. No phone setting can guarantee an alarm-clock-level wake-up, so Docket can't promise that either.

## Limitations

- **Web push isn't used inside the app.** The app's own alarms replace it. Email reminders from the server still work as configured.
- **Some changes made while the app is closed arrive late.** When you edit or cancel something on another device and the phone's app is closed, the phone picks it up within about 15 minutes. The just-in-time server check covers most cases, but only while the phone is online.
- **Snoozing from a notification is local to the phone.** It isn't recorded in the server's notification history.
- **Not on Google Play.** It isn't set up for the Play Store; publishing would need your own signing key and a Play developer account.
