#!/bin/sh
# 组装一份“开箱即用”的服务器发行包（不含 ROM）
# 用法：sh scripts/package.sh [输出目录] [模拟器仓库路径]
#   模拟器仓库需要先编译出 build/melonDS（Linux）
set -e
OUT=${1:-dist}
EMU_SRC=${2:-../melonDS_CHN}

mkdir -p "$OUT/MM3-Server/platform"
cp -r src public package.json package-lock.json "$OUT/MM3-Server/platform/" 2>/dev/null || true
[ -d node_modules ] && cp -r node_modules "$OUT/MM3-Server/platform/"
cp config.ini.example "$OUT/MM3-Server/config.ini"
mkdir -p "$OUT/MM3-Server/roms" "$OUT/MM3-Server/emulator" "$OUT/MM3-Server/source"
cp roms/README.md "$OUT/MM3-Server/roms/"

if [ -x "$EMU_SRC/build/melonDS" ]; then
    arch=$(uname -m)
    case "$arch" in
        aarch64|arm64) d=linux-arm64 ;;
        x86_64|amd64)  d=linux-x86_64 ;;
        *) d=linux-$arch ;;
    esac
    mkdir -p "$OUT/MM3-Server/emulator/$d"
    cp "$EMU_SRC/build/melonDS" "$OUT/MM3-Server/emulator/$d/melonDS"
fi

if [ -d "$EMU_SRC" ]; then
    tar -czf "$OUT/MM3-Server/source/melonDS-src.tar.gz" \
        --exclude=build --exclude=.git -C "$(dirname "$EMU_SRC")" "$(basename "$EMU_SRC")"
fi

echo "打包完成：$OUT/MM3-Server"
echo "把 ROM 放进 $OUT/MM3-Server/roms/ 后即可 ./start.sh"
