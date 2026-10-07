#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"

# Build for real iPhone hardware. Signing is performed by the recipient.
xcodebuild build -project PocketLink.xcodeproj -scheme PocketLink \
  -configuration Release -sdk iphoneos -destination 'generic/platform=iOS' \
  -derivedDataPath build/UnsignedDerivedData \
  CODE_SIGNING_ALLOWED=NO CODE_SIGNING_REQUIRED=NO CODE_SIGN_IDENTITY=""

app="build/UnsignedDerivedData/Build/Products/Release-iphoneos/PocketLink.app"
test -f "$app/PocketLink"
platform=$(/usr/libexec/PlistBuddy -c 'Print :DTPlatformName' "$app/Info.plist")
test "$platform" = "iphoneos"
lipo "$app/PocketLink" -verify_arch arm64
version=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$app/Info.plist")
build=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$app/Info.plist")

mkdir -p build/ipa
staging=$(mktemp -d "$(pwd)/build/ipa-staging.XXXXXX")
trap 'rm -rf "$staging"' EXIT
mkdir "$staging/Payload"
ditto "$app" "$staging/Payload/PocketLink.app"

# Prebuilt dependencies can retain vendor signatures even in an unsigned build.
# Strip those as well so the recipient signs every embedded framework afresh.
while IFS= read -r -d '' framework; do
  if codesign -d "$framework" >/dev/null 2>&1; then
    codesign --remove-signature "$framework"
  fi
done < <(find "$staging/Payload/PocketLink.app" -type d -name '*.framework' -print0)
if codesign -d "$staging/Payload/PocketLink.app" >/dev/null 2>&1; then
  codesign --remove-signature "$staging/Payload/PocketLink.app"
fi

output="$(pwd)/build/ipa/PocketLink-${version}-Build${build}-unsigned.ipa"
(cd "$staging" && zip -qry "$output" Payload)
unzip -t "$output"
shasum -a 256 "$output"
