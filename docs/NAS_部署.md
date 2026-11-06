# NAS 部署（飞牛 NAS / Debian 12 arm64）

目标机器：`wangpengfei@192.168.1.77`，系统 Debian 12 bookworm，aarch64，4 核 / 3.9G 内存。
规划目录：

```
/vol1/MM3/
  melonDS_CHN/        模拟器源码 + build/melonDS（本机编译）
  platform/           本仓库 server/ 的内容（Node 服务 + 网页）
  roms/mm3cn.nds      游戏 ROM（汉化二分 p2）
  roms/mm3cn.sav      1P 存档
  roms/mm3cn.sav.2    2P 存档
```

服务端口 `18090`（HTTP + WebSocket），局域网访问 `http://192.168.1.77:18090/`。
> NAS 上 8090 已被 UpSnap 占用，所以平台改用 18090。

---

## 1. 编译 melonDS（aarch64 无 GPU）

依赖（需要 sudo）：

```sh
build-essential cmake ninja-build pkg-config git \
qt6-base-dev qt6-multimedia-dev qt6-svg-dev \
libegl-dev libgl-dev extra-cmake-modules
```

### 1.1 SDL2 开发包

Debian 12 上 `libsdl2-dev` 会因为 `libdrm-amdgpu1` 版本冲突装不上，用下载 + 解包绕过：

```sh
cd /tmp && apt-get download libsdl2-dev
dpkg-deb -x libsdl2-dev_*.deb /tmp/sdl2dev
cp -r /tmp/sdl2dev/usr/include/SDL2 /usr/include/
cp -P /tmp/sdl2dev/usr/lib/aarch64-linux-gnu/libSDL2* /usr/lib/aarch64-linux-gnu/
# CMake 里 SDL2 的配置头必须一起放进去
cp /tmp/sdl2dev/usr/lib/aarch64-linux-gnu/cmake/SDL2/../../include/SDL2/_real_SDL_config.h /usr/include/SDL2/
```

### 1.2 glad 头文件路径（Linux 必改）

`src/PlatformOGL.h` 上游写的是：

```c
#define MELONDS_GL_HEADER "\"frontend/glad/glad.h\""
```

这依赖预处理阶段处理转义引号，MSYS2/MinGW 能过，**Linux gcc 不行**，会报
`fatal error: "frontend/glad/glad.h": No such file or directory`。改成尖括号形式：

```c
#define MELONDS_GL_HEADER <frontend/glad/glad.h>
```

### 1.3 配置与编译

```sh
cd /vol1/MM3/melonDS_CHN
cmake -S . -B build -G Ninja \
  -DCMAKE_BUILD_TYPE=Release \
  -DENABLE_OGLRENDERER=ON
ninja -C build -j2
```

- **必须 `-DENABLE_OGLRENDERER=ON`**（默认值）：`EmuThread.cpp/VideoSettingsDialog.cpp` 里
  `renderer3D_OpenGL` 没有被 `#ifdef` 包住，关掉 OpenGL 渲染器会编译失败。
  运行时靠配置 `[3D] Renderer = 0` + `[Screen] UseGL = false` 走软件渲染，不需要 GPU。
- 用 `-j2`，`-j4` 在 3.9G 内存的机器上做 LTO 链接容易把内存打满（实测会把整机搞重启）。
- 只需要 glad 头文件能解析，`libegl-dev libgl-dev` 装上即可。

### 1.4 两个运行期坑（已在源码里改好）

1. `Config::Load()` 失败会弹 `QMessageBox`，无头环境下会**永久卡住**。
   现在宿主模式（`--host`）只打印警告继续跑。
2. 配置目录不可写也会让 `Config::Load()` 失败：`chmod u+rwx /vol1/MM3/melonDS_CHN/build`
   （飞牛的文件系统权限位显示成 `----------`，要手动加权限，否则写不了 `melonDS.toml`）。

产物：`build/melonDS`。验证：

```sh
QT_QPA_PLATFORM=offscreen SDL_AUDIODRIVER=dummy ./build/melonDS --host \
  --rom /vol1/MM3/roms/mm3cn.nds --instances 2 --port 7100
```

---

## 2. 部署网页平台

```sh
mkdir -p /vol1/MM3/platform
tar -xzf platform.tar.gz -C /vol1/MM3/platform   # 内容是 server/ 下的 src public roms deploy package.json 等
cp /vol1/MM3/server-saves/*.sav /vol1/MM3/platform/roms/
node -v   # 需要 >= 18
```

启动脚本 `deploy/nas/start.sh`：

```sh
export PORT=18090
export MELONDS_EXE=/vol1/MM3/melonDS_CHN/build/melonDS
export GAME_ROM=/vol1/MM3/roms/mm3cn.nds
export QT_QPA_PLATFORM=offscreen
export SDL_AUDIODRIVER=dummy
cd /vol1/MM3/platform
exec node src/index.js
```

> 必须 `QT_QPA_PLATFORM=offscreen`（无显示器）和 `SDL_AUDIODRIVER=dummy`（无音频设备）。
> SDL 的 dummy 驱动只允许打开一个音频设备，2P 实例的音频改为直接从 SPU 取（代码已处理）。

### 开机自启（systemd）

```ini
# /etc/systemd/system/mm3.service
[Unit]
Description=MM3 web versus platform
After=network.target

[Service]
Type=simple
User=wangpengfei
WorkingDirectory=/vol1/MM3/platform
Environment=PORT=18090
Environment=MELONDS_EXE=/vol1/MM3/melonDS_CHN/build/melonDS
Environment=GAME_ROM=/vol1/MM3/roms/mm3cn.nds
Environment=QT_QPA_PLATFORM=offscreen
Environment=SDL_AUDIODRIVER=dummy
ExecStart=/usr/bin/node src/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

```sh
sudo systemctl daemon-reload && sudo systemctl enable --now mm3
```

---

## 3. 端口与公网

- 局域网：`http://192.168.1.77:18090/`
- 公网：路由器把 TCP `18090` 映射到 `192.168.1.77:18090`；也可用 frp / cloudflared tunnel
- 只在 NAS 本机监听时，Node 默认 `0.0.0.0`，无需改代码

---

## 4. 实测性能（2026-11-06，本机 4 核 aarch64 / 3.9G）

一个房间 = 2 个实例同时运行（LocalMP 同进程），实测：

| 项目 | 实测 |
| --- | --- |
| 画面帧率 | 28~29 fps（推流上限 30fps） |
| 音频 | 27~28 包/秒，RMS 700~1300（正常音乐，2P 也有声音） |
| 宿主进程 CPU | 约 285%（4 核的 71%） |
| 打开 JIT | 无提升（28.8 fps），瓶颈在软件 3D + JPEG 编码 |

结论：这台 NAS 只够跑 **1 个房间**，且约 29fps，对战会略慢。
要继续压：JPEG 质量（`RemoteHost.cpp` 里 `img.save(..., 55)`）、推流帧率（`timer->start(33)`），
或者换更强 CPU 的机器。带宽：音频约 192KB/s，画面 30fps JPEG 约 1~3Mbps，单房间 5Mbps 以内。

---

## 5. 排错

| 现象 | 检查 |
| --- | --- |
| 页面打不开 | `ss -lntp \| grep 18090`；`journalctl -u mm3 -n 50` |
| 房间卡在“连接中” | melonDS 是否被 `--host` 启动；`QT_QPA_PLATFORM` 是否 offscreen |
| 2P 没声音 | 用 `tools/audio-probe.js` 抓 slot1 的 PCM（修复后应有 RMS>500） |
| 画面黑屏 | 看 `RemoteHost tick: inst=2 nds=2 fb=2` 日志 |
| 编译报 glad.h | 见 1.2 |
| 编译报 SDL2 | 见 1.1，注意 `_real_SDL_config.h` |
