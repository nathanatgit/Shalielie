#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

xcodebuild -project StylePort.xcodeproj -scheme StylePort \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build

xcodebuild -project StylePort.xcodeproj -scheme StylePort \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

xcodebuild -project StylePort.xcodeproj -scheme StylePort \
  -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO test

swift test
