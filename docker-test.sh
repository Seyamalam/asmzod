#!/usr/bin/env bash
# Rebuild the Linux ARM64 image and run the test suite inside Docker (colima).
# The worktree is mounted read-only and copied inside so the Linux object
# files can't clobber the host's Mach-O build artifacts.
set -e
docker build --platform linux/arm64 -t asmzod-linux .
docker run --rm --platform linux/arm64 -v "$PWD:/src:ro" asmzod-linux \
  bash -c "cp -r /src /tmp/azwork && cd /tmp/azwork && make -C asm clean && make -C asm && bun test"
