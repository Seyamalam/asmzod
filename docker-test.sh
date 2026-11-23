#!/usr/bin/env bash
# Rebuild the Linux ARM64 image and run the test suite inside Docker (colima).
set -e
docker build --platform linux/arm64 -t asmzod-linux .
docker run --rm --platform linux/arm64 -v "$PWD:/src" asmzod-linux
