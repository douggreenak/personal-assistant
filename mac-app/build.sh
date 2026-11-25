#!/bin/bash
# Builds a universal (Apple silicon + Intel) Assistant.app and zips it to mac-app/dist/Assistant-Mac.zip.
#   ./mac-app/build.sh [version]        e.g. ./mac-app/build.sh 1.2.0
# Needs Xcode and XcodeGen (brew install xcodegen). Ad-hoc signed: no Apple developer account required.
set -euo pipefail
cd "$(dirname "$0")"
VERSION="${1:-0.1.0}"; BUILD="${2:-$(date +%Y%m%d%H%M)}"
xcodegen generate >/dev/null
rm -rf build dist; mkdir -p dist
xcodebuild -project Assistant.xcodeproj -scheme Assistant -configuration Release -derivedDataPath build \
  ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" clean build | tail -n 3
APP="build/Build/Products/Release/Assistant.app"
codesign --verify --deep --strict "$APP"
ditto -c -k --sequesterRsrc --keepParent "$APP" dist/Assistant-Mac.zip
echo "Built $(lipo -archs "$APP/Contents/MacOS/Assistant") v$VERSION -> mac-app/dist/Assistant-Mac.zip"
