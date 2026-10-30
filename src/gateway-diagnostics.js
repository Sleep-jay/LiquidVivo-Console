// Public endpoint only. No session, email, OTP, device identifier or body is logged.
export async function diagnoseGateway(config, fetchImpl=fetch) {
  try {
    const response=await fetchImpl(config.url+'/auth/v1/settings',{
      method:'GET',headers:{apikey:config.publishableKey},
      cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(8000)
    });
    await response.body?.cancel();
    return `腾讯云接口 HTTP ${response.status}`;
  } catch {
    return '当前浏览器无法连接腾讯云接口（网络、TLS或跨域），尚未确认邮件请求成功';
  }
}
