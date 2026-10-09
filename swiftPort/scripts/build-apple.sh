#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

swift test

xcodebuild -project StylePort.xcodeproj -scheme StylePort \
  -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build

xcodebuild -project StylePort.xcodeproj -scheme StylePort \
  -destination 'generic/platform=iOS' CODE_SIGNING_ALLOWED=NO build
