# GameCast 项目背景资料

## 一、项目基本信息

- **项目名称**: GameCast — 屏幕共享与实时协作软件
- **版本**: 0.3.7（官方） / 0.3.8-voice.x（语音功能开发中）
- **技术栈**: TypeScript + Electron + Node.js + WebRTC
- **官方仓库**: https://github.com/8z2wz746tv-png/GameCast
- **本地仓库路径**: `C:\Users\sleeeep\AppData\Roaming\TRAE SOLO CN\ModularData\ai-agent\work-mode-projects\6abd2c62608724c4ac5884a5\GameCast`

## 二、项目结构

```
GameCast/
├── apps/
│   ├── desktop/          # Electron 桌面客户端
│   │   ├── electron/     # 主进程代码（屏幕采集、原生媒体等）
│   │   ├── native/       # 原生 DLL（ffmpeg、WinDivert、EasyTier 等）
│   │   ├── src/
│   │   │   ├── p2p/      # WebRTC 核心逻辑
│   │   │   │   ├── p2p-media-manager.ts    # 屏幕共享媒体管理器
│   │   │   │   ├── p2p-voice-manager.ts    # 独立 P2P 语音管理器（新增）
│   │   │   │   ├── sfu-fallback.ts         # SFU 回退集成
│   │   │   │   ├── signaling-client.ts     # 信令客户端
│   │   │   │   └── ...
│   │   │   ├── use-room-media.ts  # 房间媒体 Hook（核心 UI 状态管理）
│   │   │   ├── App.tsx            # 主界面
│   │   │   └── ...
│   │   ├── package.json
│   │   └── vite.config.ts
│   └── server/           # 控制服务器（信令 + 房间管理）
│       ├── src/
│       │   ├── services/
│       │   │   ├── signal-hub.ts     # 信令转发核心
│       │   │   ├── room-service.ts   # 房间管理
│       │   │   ├── signal-protocol.ts # 信令协议定义
│       │   │   └── ...
│       │   ├── routes/
│       │   ├── domain/
│       │   └── ...
│       └── package.json
├── packages/
│   └── contracts/        # 共享类型定义
├── infra/                # Docker 部署配置
│   ├── docker-compose.yml
│   ├── docker-compose.override.yml  # 本地覆盖（修复了两个官方bug）
│   ├── server.Dockerfile
│   ├── server.local.Dockerfile      # 修复版 Dockerfile
│   └── livekit.yaml
└── ...
```

## 三、服务器信息

### 阿里云服务器
- **IP**: `8.148.204.169`
- **系统**: Linux
- **SSH 用户**: `root`
- **SSH 密码**: `1qasdfghjkl;'`
- **部署目录**: `/root/gamecast-src/`（源码） + `/root/gamecast/`（编译后 dist）
- **部署方式**: Docker Compose

### Docker 服务
| 容器名 | 镜像 | 说明 |
|--------|------|------|
| `infra-control-server-1` | 自建 `infra-control-server` | 信令服务器 + 房间管理 |
| `infra-livekit-1` | `livekit/livekit-server:v1.8` | SFU 多人转发 |
| `infra-coturn-1` | `coturn/coturn:4.6.3` | STUN/TURN 中继 |

### 端口开放情况（阿里云安全组）
- **TCP**: 80, 443, 3478, 7880, 8787
- **UDP**: 3478, 49160-49200, 50000-50100, 7880

### 服务器配置（.env 关键项）
```
DEPLOYMENT_MODE=internet
CONTROL_SERVER_PORT=8787
STUN_URLS=stun:8.148.204.169:3478,stun:stun.cloudflare.com:3478
TURN_URLS=stun:8.148.204.169:3478,turn:8.148.204.169:3478?transport=udp,turn:8.148.204.169:3478?transport=tcp
TURN_SHARED_SECRET=151161bc8127ac795a898cc629814da50551075c01031fb409d63af04a5e47a3
TURN_EXTERNAL_IP=8.148.204.169
SFU_ENABLED=true
SFU_VIEWER_THRESHOLD=2
LIVEKIT_API_KEY=API584E14643F1FF08E
LIVEKIT_API_SECRET=piW0CnlFi9NwOFXSjdAawqNgsaGxjZQBGQrVEoaP
LIVEKIT_WS_URL=ws://8.148.204.169:7880
LIVEKIT_API_URL=http://livekit:7880
```

### Docker 常用命令
```bash
# 进入部署目录
cd /root/gamecast-src

# 查看容器状态
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.override.yml ps

# 重启服务器
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.override.yml restart control-server

# 查看日志
docker logs infra-control-server-1 --tail 50 -f

# 快速更新（复制文件进容器）
docker cp /path/to/file.js infra-control-server-1:/app/dist/services/
docker restart infra-control-server-1
```

### 已知官方 Bug 及修复
1. **Dockerfile 构建失败** — 官方 `server.Dockerfile` 尝试复制不存在的 `apps/server/node_modules`（npm workspace 会提升依赖到根目录）。修复：`server.local.Dockerfile` 去掉了那一行。
2. **coturn 内网 IP 问题** — coturn 在 Docker bridge 网络下会广播容器内网 IP 作为 relay 地址。修复：`docker-compose.override.yml` 中添加 `--external-ip` 参数。

## 四、核心架构

### 屏幕共享流程
1. **创建房间** → 客户端连接信令服务器，获取房间号
2. **加入房间** → 其他客户端通过房间号加入
3. **发起观看** → 观看者发送 `watch.requested` → 共享端创建 P2P 连接 → 交换 offer/answer/ICE
4. **连接模式**:
   - **P2P**: 直连，延迟最低，画质最好
   - **TURN**: 中继，穿透失败时使用，走 coturn
   - **SFU**: 多人转发，观看人数超过阈值（默认2人）时自动切换，走 LiveKit

### 信令协议（WebSocket）
主要消息类型：
- `auth` / `auth.ok` — 认证
- `participant.joined` / `participant.left` — 参与者进出
- `share.updated` / `share.stopped` — 屏幕共享状态
- `watch.requested` / `watch.committed` / `watch.released` — 观看请求
- `rtc.offer` / `rtc.answer` / `rtc.ice` — WebRTC 信令
- `p2p.failed` — P2P 失败，请求 SFU 回退
- `sfu.*` — SFU 相关

**注意**: `rtc.offer/answer/ice` 的转发需要 `connectionId` 对应的"观看关系"存在。语音消息使用 `voice-` 前缀的 `connectionId`，需要在服务器端绕过观看关系验证（已修改 `signal-hub.ts`）。

## 五、当前开发状态

### 已完成
- ✅ 服务器部署（Docker + TURN + SFU）
- ✅ 端口配置和验证
- ✅ 从官方 v0.3.7 fork 并升级
- ✅ 独立 P2P 语音功能（客户端代码完成）

### 进行中
- 🔄 语音功能的服务器端修复（`signal-hub.ts` 已改，但还没部署到服务器）
- 🔄 语音功能测试验证

### 语音功能说明
新增文件：`apps/desktop/src/p2p/p2p-voice-manager.ts`
- 独立的 P2P 语音连接管理器，不依赖屏幕共享
- 进房间就能开麦，双向语音
- 走 TURN 中继保证连通性
- 多人 mesh 拓扑（每人一条 P2P 连接）
- connectionId 以 `voice-` 前缀标识语音消息

### 当前分支
- `main` — 官方 v0.3.7 基线
- `feature/voice-p2p` — 语音功能开发分支（已创建并提交）

## 六、客户端构建

```bash
# 进入客户端目录
cd apps/desktop

# 开发模式
npm run dev

# 打包（Windows）
npx electron-builder --win --x64 -p never

# 输出目录
release-friends/
  ├── GameCast-x.x.x-setup-x64.exe     # 安装版
  ├── GameCast-x.x.x-portable-x64.exe  # 便携版
  └── win-unpacked/                    # 未打包的可执行文件
```

## 七、房间持久化功能建议（新功能方向）

当前房间是**纯内存**的，服务器重启后房间消失。持久化可以考虑：

1. **数据模型**: 房间信息（roomId、创建者、创建时间、密码哈希等）
2. **存储方案**: SQLite（轻量、部署简单）或 Redis（如果需要过期管理）
3. **关键功能**:
   - 房间创建时写入数据库
   - 服务器启动时从数据库恢复活跃房间
   - 房间过期/清理机制
   - 房间密码哈希存储（已有 `password-service.ts`）
4. **现有相关文件**:
   - `apps/server/src/services/room-service.ts` — 房间管理核心
   - `apps/server/src/domain/room.ts` — 房间领域模型
   - `apps/server/src/services/password-service.ts` — 密码服务
   - `apps/server/src/routes/rooms.ts` — HTTP 路由

## 八、诊断与调试

- 客户端内置诊断导出功能（设置 → 导出诊断包）
- 诊断日志是 JSONL 格式，每个事件一行
- 关键字段: `timestamp`、`level`、`scope`、`event`、`data`
- 常用 scope: `signaling`、`voice-p2p`、`media`、`viewer`、`publisher`、`sfu-voice`
