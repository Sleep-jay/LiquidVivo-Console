// Temporary connectivity probe: no account creation, grants, or signing keys.
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const UPSTREAM = 'https://drboqyxccvvsxcbusvrv.supabase.co';
const PUBLIC_KEY = 'sb_publishable_B1wNxFsun9jNIP8LB_BX-w_3e1eIPuT';

function createProbeServer(fetchImpl = fetch) {
  return http.createServer(async (req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, {'Content-Type':'application/json; charset=utf-8',
        'Cache-Control':'no-store', 'X-Content-Type-Options':'nosniff'});
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'GET') { req.resume(); reply(405, {error:'method'}); return; }
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/' || path === '/health') { reply(200, {ok:true, service:'liquidvivo-connectivity'}); return; }
    if (path !== '/upstream' && path !== '/health/upstream') { reply(404, {error:'route'}); return; }
    // Fixed destinations only. Never accept URLs, credentials or device codes.
    let stage = 'auth_settings';
    try {
      const settings = await fetchImpl(UPSTREAM + '/auth/v1/settings', {
        headers:{apikey:PUBLIC_KEY}, redirect:'manual', signal:AbortSignal.timeout(8000)
      });
      await settings.body?.cancel();
      if (settings.status !== 200) { reply(502, {ok:false,stage,http:settings.status}); return; }
      stage = 'signed_health';
      const health = await fetchImpl(UPSTREAM + '/functions/v1/cloud-sync', {
        method:'POST', headers:{'Content-Type':'application/json',apikey:PUBLIC_KEY},
        body:JSON.stringify({operation:'health',nonce:randomBytes(16).toString('hex')}),
        redirect:'manual',signal:AbortSignal.timeout(8000)
      });
      const status = health.status;
      await health.body?.cancel();
      // HTTP 200 alone does NOT establish signature validity or authorization.
      reply(status === 200 ? 200 : 502, {ok:status === 200,stage,http:status,
        authSettingsHttp:200,signatureVerified:false});
    } catch {
      reply(502, {ok:false,stage,error:'upstream_connection_failed'});
    }
  });
}
module.exports = {createProbeServer};
if (require.main === module) {
  // Port 9000 is the observed CloudBase HTTP template contract, not a local singleton.
  const port = Number(process.env.PORT || 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');
  createProbeServer().listen(port, '0.0.0.0');
}
