# MM3 Online · 重装机兵3 网页联机对战平台

用浏览器和远方的朋友打《重装机兵3》对战模式。

模拟器跑在服务器上：一个房间 = 一个 melonDS 进程 + 两个实例，两个实例之间走
melonDS 的 **LocalMP**（同进程共享内存，延迟≈0），所以联机质量和本地双开一样；
玩家浏览器只负责「看画面 + 听声音 + 发按键」，对网络要求很低。

```
浏览器 A ──WebSocket──┐
                      ├── Node 服务 ──TCP── melonDS --host（实例0 + 实例1，LocalMP 互连）
浏览器 B ──WebSocket──┘
```

## 特性

- 房间大厅：昵称登录、创建/加入房间、1P/2P 自动分配、战绩统计
- 画面：256×384（上下屏拼接）JPEG 推流，帧率可配 10–60
- 声音：48kHz 立体声 PCM 推流，浏览器 WebAudio 播放，1P/2P 都有声音
- 操作：键盘、手柄（Gamepad API）、手机虚拟按键、触摸下屏，支持自定义按键映射
- 布局：桌面 / 手机竖屏 / 手机横屏三套布局，一键全屏
- 生命周期：离开房间立即销毁房间与模拟器进程；关页面 20 秒回收；进程不响应则强杀
- 换机器：`config.ini` 调端口、画质、帧率；Windows / Linux ARM64 / Linux x86_64 都有脚本

## 快速开始

```sh
# 1) Node 18+
node -v

# 2) 依赖
npm install --omit=dev

# 3) 放 ROM（不随仓库分发）
mkdir -p roms && cp /path/to/your.nds roms/mm3cn.nds

# 4) 配置
cp config.ini.example config.ini   # 改端口 / 画质 / 模拟器路径

# 5) 启动
node src/index.js
```

浏览器打开 `http://<服务器IP>:<port>/`，一个人「创建并进入」，另一个人「加入」。

### 需要模拟器

服务端不包含模拟器本体，请使用带 **host mode**（`--host/--quality/--fps`）的 melonDS 分支：

- 源码 / 预编译（Windows、Linux ARM64、Linux x86_64）：
  <https://github.com/lvmaozilinke/melonDS_CHN/releases>
- 仓库：<https://github.com/lvmaozilinke/melonDS_CHN>

`config.ini` 里 `exe` 留空时会按架构自动找 `emulator/linux-<arch>/melonDS`
（发行包布局），也可以直接写绝对路径。

## 配置（config.ini）

```ini
[server]
port = 18090

[game]
rom = roms/mm3cn.nds
exe =                      ; 留空=自动按架构找 emulator/linux-<arch>/melonDS
instances = 2

[quality]
jpeg_quality = 55          ; 低配 40~55 / 中配 60~75 / 高配 80~95
fps = 30                   ; 低配 20~30 / 中配 40~50 / 高配 60
audio = 1
```

实测参考：

| 机器 | 配置 | 结果 |
| --- | --- | --- |
| 20 核 x86_64（Ubuntu 22.04） | 75 / 60fps | 56 fps，宿主 CPU 59% |
| 4 核 ARM（飞牛 NAS，aarch64） | 55 / 30fps | 29 fps，宿主 CPU 285% |

## 发行包（Release）

`Releases` 里的 `MM3-Server-多架构.zip` 是开箱即用的服务器包（**不含 ROM**）：

```
MM3-Server/
  config.ini
  start.sh / start.bat        一键启动（自动选架构、自动 offscreen/dummy 音频）
  platform/                   Node 服务 + 网页 + 依赖
  emulator/linux-arm64|linux-x86_64/melonDS
  source/                     模拟器源码
```

解压后把 ROM 放进 `roms/`，改 `config.ini`，`./start.sh` 即可。

## 目录

```
src/          服务端（HTTP + WebSocket + 房间调度 + 模拟器宿主协议）
public/       网页（大厅 / 游戏画面 / 虚拟按键 / 按键映射）
tools/        调试脚本（音频/画面探针、无头浏览器测试）
docs/         部署与运维文档
roms/         放 ROM 和存档（内容不进仓库）
```

## 文档

- [服务器使用说明](docs/服务器使用说明.txt)
- [服务器部署记录](docs/服务器部署记录.md)（两台实机、依赖清单、实测数据）
- [NAS 部署（aarch64）](docs/NAS_部署.md)
- [公网联机方案](docs/WAN_联机方案.md)
- [网络访问与 IPv6 直连](docs/网络访问.md)（IPv6、DDNS、防火墙、Tailscale/frp/Cloudflare）

## 协议速查

浏览器 ↔ 服务端（WebSocket `/ws?room=&slot=&token=`）

```
二进制帧: [slot u8][type u8][payload]
  type 1 = JPEG 画面 256x384
  type 2 = PCM 音频 s16le/48k/立体声/~30ms
文本: {"t":"input","keys":<bitmask>,"touch":{"x","y","p"}}
按键位: A=1 B=2 Select=4 Start=8 Right=16 Left=32 Up=64 Down=128 R=256 L=512 X=1024 Y=2048
```

服务端 ↔ 模拟器宿主（TCP 127.0.0.1:7100+，详见 melonDS_CHN 仓库 `docs/HOST_MODE.md`）

## 声明

本项目不包含任何游戏 ROM 或 BIOS 文件，请使用你自己合法拥有的游戏。

melonDS 部分基于 [melonDS](https://github.com/melonDS-emu/melonDS) 与
[Wokann/melonDS_CHN](https://github.com/Wokann/melonDS_CHN) 修改，遵循 GPL-3.0。
