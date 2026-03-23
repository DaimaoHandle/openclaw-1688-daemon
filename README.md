# kf1688-daemon

1688 客服接待守护进程。运行在 OpenClaw 所在服务器上，监控 1688 接待页未读消息，识别客户问题，结合知识库与 AI 生成回复，并在真实浏览器环境中完成会话处理。

## 当前能力

- 监控 1688 接待页左侧未读会话
- 自动打开目标客户会话
- 识别打招呼、商品问题、确认/收尾语
- 基于本地知识库自动回复高频问题
- 识别商品链接 / 商品卡片 / 会话级商品上下文
- 向 AI 发送独立、短上下文任务，让 AI 在真实浏览器中打开商品页并提取结构化商品知识
- 根据客户当前问题，从商品知识中选择相关字段生成回复
- 对“好的 / 谢谢 / 嗯 / 哦 / 知道了 / 行”等确认语统一收尾回复
- 单实例运行（daemon.lock）
- 本地日志与状态记录

## 目录结构

- `daemon.js`：主守护进程
- `kb.json`：本地规则知识库
- `package.json`：Node 包定义
- `worker.sh`：辅助启动脚本（保留）
- `state.json`：运行态缓存（不建议提交）
- `daemon.log`：运行日志（不建议提交）

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
- 如果没有真实登录态，容易遇到 1688 风控、验证码或跳转异常

## 安装

```bash
cd /path/to/kf1688
npm install
```

说明：当前代码直接复用 OpenClaw 环境中的 `playwright-core`，通常不需要额外安装完整 Playwright 浏览器。

## 启动

```bash
cd /path/to/kf1688
node daemon.js
```

或：

```bash
npm start
```

## 运行文件说明

运行时会产生：

- `daemon.lock`：单实例锁
- `daemon.log`：日志
- `state.json`：会话状态、去重信息、商品上下文缓存

这些文件属于运行态，不建议提交到 GitHub。

## 环境变量

可选环境变量：

- `KF1688_RELAY_URL`
- `KF1688_RELAY_PORT`
- `KF1688_GATEWAY_URL`
- `KF1688_TOOLS_INVOKE_URL`
- `KF1688_AGENT_ID`
- `KF1688_POLL_MS`
- `KF1688_MAX_CONTEXT_MESSAGES`
- `KF1688_NOTIFY_TARGET`

如果不传，会使用程序内默认值。

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

## 重要设计原则

- 程序发送给 AI 的任务应保持 **stateless**（独立、短上下文）
- 商品识别任务应明确要求 AI：
  - 在服务器真实浏览器中打开商品链接
  - 优先看详情页图片 / SKU / 参数区 / 主图
  - 识别完成后关闭临时打开的标签页
- 客户确认语不乱答，统一礼貌收尾

## 已知限制

- 强依赖真实浏览器与 1688 登录态
- 受 1688 风控影响较大
- 若 AI 未真正拿到商品页或详情图，商品字段可能缺失
- 当前更适合单店 / 单流程复用

## 给 OpenClaw 的安装指令（可直接发给另一台服务器上的 OpenClaw）

把下面这段原样发给另一台服务器上的 OpenClaw：

```text
请在当前服务器上安装并运行 kf1688-daemon，要求如下：

1. 从 GitHub 拉取仓库到工作目录，例如：
   /home/admin/openclaw/workspace/kf1688

2. 进入项目目录后安装依赖：
   npm install

3. 检查服务器是否具备以下条件：
   - OpenClaw Gateway 正常运行
   - 服务器已安装 Google Chrome / Chromium
   - 已存在可用的 1688 登录态
   - 已配置可供 OpenClaw 使用的真实浏览器接管能力（如 Browser Relay / Chrome Relay）

4. 启动守护进程：
   node daemon.js

5. 启动后检查：
   - 是否生成 daemon.lock
   - 是否生成 daemon.log
   - 日志中是否出现 `kf1688 daemon start`
   - 是否能正常扫描 1688 未读会话

6. 不要提交或覆盖以下运行态文件：
   - state.json
   - daemon.lock
   - daemon.log
   - daemon.log.*

7. 如果需要长期运行，请按当前服务器的习惯配置为 systemd / pm2 / supervisor / cron 保活，但不要改动核心业务逻辑。
```

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
