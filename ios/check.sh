#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
if ! xcodebuild -version >/dev/null 2>&1; then
  echo "请安装完整 Xcode，并在 Xcode > Settings > Locations 选择 Command Line Tools。" >&2
  exit 1
fi
plutil -lint PocketLink/Info.plist PocketLink.xcodeproj/project.pbxproj
xcodebuild -resolvePackageDependencies -project PocketLink.xcodeproj -scheme PocketLink
device_id="$(xcrun simctl list devices available -j | python3 -c '
import json, sys
devices = json.load(sys.stdin)["devices"]
phones = [d["udid"] for runtime, group in devices.items() if "iOS" in runtime for d in group if d.get("isAvailable") and "iPhone" in d["name"]]
if not phones:
    sys.exit("请先在 Xcode Settings > Components 下载 iOS Simulator。")
print(phones[0])
')"
xcodebuild test -project PocketLink.xcodeproj -scheme PocketLink \
  -destination "platform=iOS Simulator,id=$device_id" \
  -derivedDataPath build/DerivedData CODE_SIGNING_ALLOWED=NO
