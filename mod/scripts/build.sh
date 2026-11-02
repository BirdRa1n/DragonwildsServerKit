#!/bin/sh
# Builds mod/build/libdwkit.so for the Linux server, from Windows or Linux, using the Zig in .tools/zig.
# exports.map exports only the EOS session calls in eos_address.cpp: an LD_PRELOAD library must not
# interpose anything else on the game.
set -e
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
MOD=$ROOT/mod
mkdir -p "$MOD/build"
cd "$MOD"
if command -v cygpath >/dev/null 2>&1; then ZIGPATH=$(cygpath -w "$ROOT/.tools/zig"); else ZIGPATH=$ROOT/.tools/zig; fi
PYTHONPATH=$ZIGPATH python -m ziglang c++ \
  -target x86_64-linux-gnu.2.28 -shared -fPIC -O2 -g0 -std=c++20 \
  -fvisibility=hidden -fno-exceptions -fno-rtti -Wall -Wextra -Wno-unused-parameter -Wno-nullability-completeness \
  -Wl,--version-script=exports.map -s \
  src/*.cpp -ldl -o build/libdwkit.so
ls -la build/libdwkit.so
