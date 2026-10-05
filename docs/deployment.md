# 手动运行与服务器部署

[返回 README](../README.md)

### 手动开发与公网部署

已有 Node.js 22+ 时可以 `npm.cmd install` 后 `npm.cmd start`，默认是 HTTP。电脑 localhost 可调试，iPhone 录音需要可信 HTTPS；手动模式需自行配置 `.env.example` 中的 `TLS_CERT` 与 `TLS_KEY`。

公开部署时，使用受信任的域名证书和 HTTPS 反向代理即可，无需安装开发 CA。本地启动脚本用于当前电脑的局域网服务；公网部署使用本页的 Node 启动方式。

### 服务器部署

服务器运行相同的 `server/index.mjs`。反向代理必须将 `/signal` 的 WebSocket Upgrade 请求转发给 Node，并转发普通 HTTP 请求。使用进程管理器保持服务运行；有多台实例时需要粘性路由，目前配对房间保存在单进程内存中。

可用环境变量见 [.env.example](../.env.example)。本项目不会自动读取 `.env`；请通过 PowerShell 环境变量、进程管理器，或 `node --env-file=.env server/index.mjs` 加载。

```powershell
$env:PUBLIC_ORIGIN='https://audio.example.com'
$env:ALLOWED_ORIGINS='https://your-frontend.example.com'
$env:TURN_URL='turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349?transport=tcp'
$env:TURN_SECRET='替换为与TURN服务器一致的强随机共享密钥'
npm.cmd start
```

`TURN_SECRET` 用于生成有效期一小时的临时 TURN 凭据，须与 TURN 服务的 REST 认证配置一致。也可通过 `ICE_SERVERS_JSON` 提供标准 ICE 数组；其中的用户名和凭据会发给浏览器，因此不应填入其他服务的私钥。服务端未配置 TURN 时，「服务器」模式会明确拒绝连接。

服务器模式在手机端右上角设置中输入完整的服务源地址，如 `https://audio.example.com`；电脑接收端填写同一地址。若前端和服务分开部署，需要将前端精确 origin 加入 `ALLOWED_ORIGINS`。静态网页托管只提供界面，不会代替 Node 配对服务或 TURN 服务。

公网服务当前是无账号的原型：有配对码隔离、请求来源检查、连接数和消息频率限制，但公开 TURN 凭据接口仍可能被外部调用。面向多用户长期运营前，应增加登录、访问令牌、配额与运维监控。
