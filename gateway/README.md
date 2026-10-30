# 自有 API 域名网关（准备代码，尚未部署）

worker.js 只转发到本项目固定 Supabase 上游，支持现有 App 的认证/同步和网页 lv_* 读取/RPC；不持有签发私钥或 service_role，不执行授权判断，不缓存带设备或会话信息的响应，不记录正文，不作为通用 URL 代理。保留上游签名原文，由 App 按原固定根继续验签。

所有者已选择免费方案，不购买域名或升级套餐。可部署到 Cloudflare 提供的 workers.dev 地址，不要求自有域名；WEBSITE_ORIGIN 默认为现有 GitHub Pages origin。如添加 REQUEST_LIMITER 绑定则应用入口限流；账户配额、上游 Auth/RLS、后台限流仍需独立检查。

先用手机实际网络验证 HTTPS、匿名注册/刷新、签名 health、真实策略请求及网页登录，再修改 App/API 配置和 CSP。不能根据本地单元测试宣称手机可达，也不能把买域名当成网络问题必然已解决。Cloudflare 自有域名国际网络需实际验证，免费计划不等于中国大陆线路承诺。

2026-10-30：所有者截图确认已创建 liquidvivo-gateway.3103830475.workers.dev，但尚未确认部署本目录的网关代码。连接手机的独立只读 HTTPS 探针访问该主机 /auth/v1/settings，DNS 返回 2a03:2880:f11c:8183:face:b00c:0:25de 和 108.160.169.171，TCP/HTTPS 连接均超时，未获得 HTTP 响应；电脑 curl 则 TLS 握手失败（SEC_E_ILLEGAL_MESSAGE）。这些结果证明当前测试路径不可达，不能单凭本次结果断言具体拦截方或所有网络均不可达。测试临时 jar 已移除，未更改手机网络配置、安装 App 或重启宿主。App 正式入口保持原配置，待实际可达及签名 health 验证后再接入。

api.example.com 仅在本地 fixture 中使用；不会写入 App 正式配置。
