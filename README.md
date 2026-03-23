# openclaw-1688-daemon

1688 客服接待守护进程。运行在 OpenClaw 所在服务器上，监控 1688 接待页未读消息，识别客户问题，结合知识库与 AI 生成回复，并在真实浏览器环境中完成会话处理。

## 快速开始

```bash
git clone git@github.com:DaimaoHandle/openclaw-1688-daemon.git
cd openclaw-1688-daemon
npm install
node daemon.js
```

启动后检查：

```bash
ls -l daemon.lock daemon.log
```

并确认日志里有：

```text
kf1688 daemon start
```

---

## 当前能力

- 监控 1688 接待页左侧未读会话
- 自动打开目标客户会话
- 识别打招呼、商品问题、确认/收尾语
- 基于本地知识库自动回复高频问题
- 识别商品链接 / 商品卡片 / 会话级商品上下文
- 向 AI 发送独立、短上下文任务，让 AI 在真实浏览器中打开商品页并提取结构化商品知识
- 根据商品知识和客户当前问题生成回复
- 对“好的 / 谢谢 / 嗯 / 哦 / 知道了 / 行”等确认语统一礼貌收尾
- 单实例运行（`daemon.lock`）
- 本地日志与状态记录

---

## 目录结构

- `daemon.js`：主守护进程
- `kb.json`：本地规则知识库
- `package.json`：Node 包定义
- `worker.sh`：辅助启动脚本（保留）
- `state.json`：运行态缓存（不建议提交）
- `daemon.log`：运行日志（不建议提交）

---

## 部署前检查清单

在部署前，请确认：

- [ ] OpenClaw Gateway 正常运行
- [ ] 服务器已安装 Google Chrome / Chromium
- [ ] 1688 已存在真实登录态
- [ ] OpenClaw 可接管真实浏览器环境（如 Browser Relay / Chrome Relay）
- [ ] 有可附着的 1688 接待页标签
- [ ] 服务器可访问 GitHub、1688、OpenClaw 接口

---

## 运行依赖

### 1. 服务器环境

- Linux 服务器
- Node.js 18+（建议与 OpenClaw 当前运行版本保持一致）
- 已安装并运行 OpenClaw Gateway
- 已安装 Google Chrome / Chromium

### 2. OpenClaw 能力

本程序依赖 OpenClaw 提供：

- chat completions 接口
- tools/invoke 工具调用接口
- browser 工具 / 真实浏览器能力
- message 工具（如需通知）

### 3. 浏览器与登录态

- 服务器上必须有真实 Chrome
- 必须存在 1688 登录态
- 推荐通过 OpenClaw Browser Relay / Chrome Relay 方式接管已登录标签页
- 需要通过 `KF1688_SHOP_NAMES` 配置店铺自身标识，避免把店铺名误识别成客户
- 如果没有真实登录态，容易遇到 1688 风控、验证码或跳转异常

---

## 安装

```bash
cd /path/to/openclaw-1688-daemon
npm install
```

说明：程序会优先使用普通 `require('playwright-core')`。如果目标服务器上的 Node/依赖路径特殊，可通过 `KF1688_PLAYWRIGHT_CORE_PATH` 或 `PLAYWRIGHT_CORE_PATH` 指定 fallback 路径。

---

## 启动

```bash
cd /path/to/openclaw-1688-daemon
node daemon.js
```

或：

```bash
npm start
```

---

## 运行文件说明

运行时会产生：

- `daemon.lock`：单实例锁
- `daemon.log`：日志
- `state.json`：会话状态、去重信息、商品上下文缓存

这些文件属于运行态，不建议提交到 GitHub。

---

## 环境变量

可选/建议环境变量：

- `KF1688_OPENCLAW_CONFIG_PATH`：OpenClaw 配置文件路径
- `OPENCLAW_CONFIG_PATH`：OpenClaw 配置文件路径（通用别名）
- `KF1688_PLAYWRIGHT_CORE_PATH`：`playwright-core` fallback 路径
- `PLAYWRIGHT_CORE_PATH`：`playwright-core` fallback 路径（通用别名）
- `KF1688_RELAY_URL`
- `KF1688_RELAY_PORT`
- `KF1688_GATEWAY_URL`
- `KF1688_TOOLS_INVOKE_URL`
- `KF1688_AGENT_ID`
- `KF1688_POLL_MS`
- `KF1688_MAX_CONTEXT_MESSAGES`
- `KF1688_SHOP_NAMES`：店铺名，支持逗号分隔或 JSON 数组字符串
- `KF1688_NOTIFY_TARGET`：飞书通知目标；不配置则跳过通知

项目根目录已提供 `.env.example` 作为参考。

---

## 工作原理（简版）

1. 守护进程连接 OpenClaw / 浏览器环境
2. 扫描 1688 接待页左侧未读会话
3. 打开目标客户会话并读取消息
4. 命中知识库则直接回复
5. 如客户涉及商品问题：
   - 提取商品链接 / 卡片上下文
   - 向 AI 发起独立任务
   - 要求 AI 在真实浏览器中打开商品页识别
   - 返回结构化商品知识
6. 再由 AI 基于当前问题生成适合发送的客服回复
7. 在聊天输入框中发送消息

---

## 重要设计原则

- 程序发送给 AI 的任务应保持 **stateless**（独立、短上下文）
- 商品识别任务应明确要求 AI：
  - 在服务器真实浏览器中打开商品链接
  - 优先看详情页图片 / SKU / 参数区 / 主图
  - 识别完成后关闭临时打开的标签页
- 客户确认语不乱答，统一礼貌收尾
- 商品识别以 AI 执行为主，程序本身尽量只做调度和状态管理

---

## 当前行为规则

- 左侧未读列表是主判据
- 商品问题优先走 AI 商品知识提取
- 程序发给 AI 的任务必须是 stateless
- AI 识别后应关闭临时打开的标签页
- 确认/收尾语统一回复：
  - `好的亲，您有问题可以再联系我`

---

## 常见报错与处理

### `no attached tab found`
说明：
- 没有附着到真实 1688 标签页

处理：
- 打开 1688 接待页
- 确保浏览器扩展开启
- 确保标签页处于可接管状态

### `Extension not connected`
说明：
- Browser Relay / 扩展连接掉了

处理：
- 检查扩展 badge
- 重新附着
- 必要时重启 gateway / 浏览器

### `PortInUseError`
说明：
- 浏览器调试端口被占用

处理：
- 杀掉旧实例
- 检查残留浏览器会话
- 重启 gateway/browser 通道

### AI 回复说“未识别到尺寸”
说明：
- AI 没从真实浏览器识别出详情页关键信息

处理：
- 检查是否真的打开了真实商品页
- 检查登录态/风控
- 检查 AI 是否在真实浏览器里执行任务

---

## 当前限制

- 强依赖真实浏览器与 1688 登录态
- 强依赖 OpenClaw 浏览器能力
- 受 1688 风控影响
- 若 AI 未真正拿到商品页或详情图，商品字段可能缺失
- 当前更适合单店铺/单流程复用
- 运行状态依赖本地 JSON，不适合高并发多实例

---

## 建议运行方式

- 开发/调试：直接 `node daemon.js`
- 长期运行：推荐 `systemd`、`pm2`、`supervisor`
- 查看日志：

```bash
tail -f daemon.log
```

---

## 给另一台 OpenClaw 的安装指令（可直接发送）

把下面这段原样发给另一台服务器上的 OpenClaw：

```text
请在当前服务器上部署并运行这个项目：
https://github.com/DaimaoHandle/openclaw-1688-daemon

要求：

1. 把仓库 clone 到工作目录，例如：
   /path/to/openclaw/workspace/openclaw-1688-daemon

2. 进入项目目录后检查文件：
   - daemon.js
   - kb.json
   - package.json
   - README.md
   - worker.sh

3. 安装依赖：
   npm install

4. 检查运行环境是否满足：
   - OpenClaw Gateway 正常运行
   - 服务器已安装 Google Chrome / Chromium
   - 存在真实可用的 1688 登录态
   - 已配置 OpenClaw 可接管真实浏览器环境（如 Browser Relay / Chrome Relay）

5. 启动守护进程：
   node daemon.js

6. 启动后检查：
   - 是否生成 daemon.lock
   - 是否生成 daemon.log
   - 日志中是否出现 `kf1688 daemon start`
   - 是否能扫描 1688 未读会话

7. 不要提交或覆盖这些运行态文件：
   - state.json
   - daemon.lock
   - daemon.log
   - daemon.log.*

8. 如果需要长期运行，请按该服务器习惯配置守护方式（systemd / pm2 / supervisor），但不要修改核心业务逻辑。

9. 如果部署失败，请输出：
   - 失败步骤
   - 错误日志
   - 当前缺失的依赖
   - 下一步修复建议
```

---

## 发布建议

推到 GitHub 时，建议只提交：

- `daemon.js`
- `kb.json`
- `package.json`
- `worker.sh`
- `README.md`
- `.gitignore`

不要提交：

- `state.json`
- `daemon.lock`
- `daemon.log*`
