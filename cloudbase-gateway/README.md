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
