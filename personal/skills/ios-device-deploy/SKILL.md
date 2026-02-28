---
name: ios-device-deploy
description: Build, install, and launch iOS/iPadOS apps on physical hardware devices from the CLI using xcodebuild and devicectl. Use when deploying to a real iPhone or iPad without the Xcode GUI.
---

# iOS Device Deploy (CLI)

Build, install, and launch an iOS app on a physical device entirely from the terminal.

## Prerequisites

Before first use on a fresh Xcode install, two one-time steps may be required (both need an interactive terminal with `sudo`):

```bash
# Accept the Xcode license
sudo xcodebuild -license accept

# Install first-launch packages (simulators, platform support)
sudo xcodebuild -runFirstLaunch
```

If these haven't been run, `xcodebuild` will fail with license or plug-in errors.

## Step 1 — Discover Connected Devices

List available destinations for a scheme to find the device identifier:

```bash
xcodebuild -scheme <SCHEME> -showdestinations 2>&1 | grep "platform:iOS,"
```

Look for lines like:

```
{ platform:iOS, arch:arm64, id:00008103-001238223407001E, name:Jose's iPad }
```

The `id` value is the device UDID you need for subsequent steps.

Alternatively, list all connected devices directly:

```bash
xcrun devicectl list devices
```

## Step 2 — Build for Device

Build the app targeting the physical device by UDID:

```bash
cd /path/to/project
xcodebuild -scheme <SCHEME> \
  -destination "platform=iOS,id=<DEVICE_UDID>" \
  build
```

The signed `.app` bundle lands in `Build/Debug-iphoneos/<APP>.app` (or the project's `BUILT_PRODUCTS_DIR`).

### Common build flags

| Flag | Purpose |
|------|---------|
| `-configuration Release` | Release build instead of Debug |
| `-allowProvisioningUpdates` | Auto-resolve signing issues |
| `ONLY_ACTIVE_ARCH=YES` | Speed up debug builds (arm64 only) |

## Step 3 — Install on Device

```bash
xcrun devicectl device install app \
  --device <DEVICE_UDID> \
  Build/Debug-iphoneos/<APP>.app
```

On success this prints the `bundleID` and `installationURL`.

## Step 4 — Launch on Device

```bash
xcrun devicectl device process launch \
  --device <DEVICE_UDID> \
  <BUNDLE_ID>
```

Example:

```bash
xcrun devicectl device process launch \
  --device 00008103-001238223407001E \
  com.jpalvarezl.lattice
```

## Full Example (end-to-end)

```bash
cd ~/Code/swift/lattice

# Build
xcodebuild -scheme lattice \
  -destination "platform=iOS,id=00008103-001238223407001E" \
  build

# Install
xcrun devicectl device install app \
  --device 00008103-001238223407001E \
  Build/Debug-iphoneos/lattice.app

# Launch
xcrun devicectl device process launch \
  --device 00008103-001238223407001E \
  com.jpalvarezl.lattice
```

## Troubleshooting

| Error | Fix |
|-------|-----|
| "You have not agreed to the Xcode license" | `sudo xcodebuild -license accept` |
| "xcodebuild failed to load a required plug-in" | `sudo xcodebuild -runFirstLaunch` |
| "Authorization is required to install the packages" | Needs interactive `sudo` — run in a real terminal |
| "Unable to find a device matching the provided destination" | Check UDID with `xcrun devicectl list devices`; ensure device is unlocked and trusted |
| Signing errors | Ensure a valid provisioning profile; add `-allowProvisioningUpdates` |
| "This device is not registered in your developer account" | Register the UDID in the Apple Developer portal or use automatic signing in Xcode first |

## Notes

- The device must be **unlocked** and **trusted** (paired) with the Mac.
- `devicectl` (via `xcrun`) replaced the older `ios-deploy` and `ideviceinstaller` tools as of Xcode 15+.
- For simulator deployment, use `xcrun simctl` instead of `devicectl`.
