# 腾讯云固定上游网关

状态：2026-10-30，用户已部署本目录网关并启用 `/api`。电脑独立检查经此路径的设置、根/子密钥签名、随机 nonce、浏览器预检/外来源拒绝、一个匿名会话创建/刷新/非管理员/登出全部通过。只新增了一个匿名测试账号，未登记测试设备或修改用户权益；登出后令牌不保存。检查脚本为 `security-tests/check_cloud_gateway.py --session-check`，只读公钥，不读取签发私钥。App 真机同步尚未验收。

## 部署

1. 在现有 HTTP Node.js 20 云函数中，用本目录 index.js、package.json 替换同名文件。保留平台模板的 scf_bootstrap，监听端口保持 9000。
2. 部署函数，保留原 `/health` 路由；新增 `/api` 路由，绑定同一函数。路由启用，路径透传关闭，由函数接收去掉 `/api` 前缀后的路径。
3. 网关层身份认证关闭；真正的身份验证由固定 Supabase Auth、RPC/RLS 和签名服务执行。浏览器 Origin 由代码限定为 https://sleep-jay.github.io，平台跨域覆盖关闭，不设置通配来源。
4. 部署后验证 `/api/auth/v1/settings`（携带原公开 apikey）、匿名会话与刷新、签名 health、带有效身份的同步；验签必须使用既有固定根，检查 nonce。全部完成前，不修改正式 App 和网页入口，不迁移数据库或密钥。

## 安全与范围

仅转发固定原 Supabase 项目的显式路径，不接受目标 URL，不持有任何私钥、管理令牌或 service_role。限制请求大小 128 KiB、响应大小 2 MiB，上游超时 30 秒、不跟随重定向、不记录请求正文或令牌、不缓存授权响应。签名响应正文保持原字节，客户端继续独立验签和校验设备绑定。

生成文件勿单独编辑：修改 ../gateway/worker.js 或 ../gateway/cloudbase-adapter.cjs，再执行 `node console/gateway/build-cloudbase.mjs`。回归执行 `node --test console/test/cloudbase-gateway.test.js console/test/gateway.test.js console/test/cloudbase-probe.test.js`。

当前没有网关级持久分布式限流；仍需检查云平台配额和上游 Auth 限流。浏览器 Origin 限制不是身份验证，也不能阻止非浏览器请求。免费体验期、资源点、默认域名的开发测试限制仍适用；网关不减少 Supabase 函数调用配额。

## 网页 PostgREST 请求头兼容

2026-10-30 邮箱发送修复：实际在线 `/api/auth/v1/otp` 的 POST 预检返回403 route_denied，初版漏了 signInWithOtp 使用的路径。现仅允许该路径 POST 和对应 OPTIONS；未扩大到任意 Auth 路径。需重新部署本目录 index.js 才生效。网页仅在发信请求成功后保存 sent 时间，失败不展示成功发送倒计时。不用修改 SMTP 密码或密钥，不通过直连原不可达地址绕过网关。49项本地测试通过，真实邮件投递仍待部署后核验。

首次部署的白名单遗漏 SDK 默认的 `Content-Profile: public` / `Accept-Profile: public`，浏览器数据库请求会在预检被拦截，出现 Failed to fetch。修订版网关补充两个头并仅接受 public schema。网页 `src/gateway-fetch.js` 同时移除语义冗余的 public profile 头（PostgREST 缺省即 public），兼容尚未重部署的初版网关；不改变认证头、请求体、方法、取消信号，也不转回旧地址。其他 schema 不会被偷偷改成 public。测试使用真实 Supabase SDK 发出 Auth/RPC/表查询，并将最终头与初版白名单逐项比对；HTTP 成功或 OPTIONS 返回204本身不能证明浏览器预检通过。
