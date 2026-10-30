// CloudBase terminates public TLS; this HTTP server is the function container entry.
const http = require('node:http');
const MAX_RESPONSE = 2 * 1024 * 1024;
function createGatewayServer(env = {}) {
  return http.createServer({requestTimeout:45000,headersTimeout:15000}, async (req,res) => {
    const error = (status,code) => {
      if(res.headersSent) { res.destroy(); return; }
      res.writeHead(status, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:code}));
    };
    try {
      if(!req.url.startsWith('/')) {req.resume();error(400,'request_target');return;}
      const url=new URL(req.url,'https://gateway.invalid');
      if(req.method==='GET' && ['/', '/health'].includes(url.pathname)) {
        res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
        res.end(JSON.stringify({ok:true,service:'liquidvivo-fixed-upstream-gateway',version:1}));return;
      }
      // Validate routes before reading bodies or contacting the fixed upstream.
      if(req.method!=='OPTIONS' && !allowed(url.pathname,req.method)) {req.resume();error(404,'route_denied');return;}
      if(Number(req.headers['content-length']||0)>MAX_BODY) {req.resume();error(413,'request_too_large');return;}
      const parts=[];let size=0;let oversized=false;
      // Do not destroy the socket before returning a bounded error response.
      for await (const chunk of req) {
        size+=chunk.length;
        if(size>MAX_BODY) {oversized=true;error(413,'request_too_large');break;}
        parts.push(chunk);
      }
      if(oversized)return;
      const headers=new Headers();
      for(const [name,value] of Object.entries(req.headers)) {
        if(value!==undefined)headers.set(name,Array.isArray(value)?value.join(','):value);
      }
      const request=new Request(url,{method:req.method,headers,
        body:['GET','HEAD'].includes(req.method)||size===0?undefined:Buffer.concat(parts)});
      const response=await gateway.fetch(request,env);
      // Bound memory before forwarding; signed response bytes remain unchanged.
      const reader=response.body?.getReader();const output=[];let length=0;
      if(reader)while(true){
        const {done,value}=await reader.read();if(done)break;
        length+=value.length;
        if(length>MAX_RESPONSE){await reader.cancel();error(502,'upstream_response_too_large');return;}
        output.push(Buffer.from(value));
      }
      const outgoing=Object.fromEntries(response.headers.entries());
      res.writeHead(response.status,outgoing);
      res.end(req.method==='HEAD'?undefined:Buffer.concat(output));
    }catch{error(502,'gateway_unavailable');}
  });
}
module.exports={createGatewayServer};
if(require.main===module){
  // 9000 is the observed CloudBase HTTP runtime contract. Local tests bind port 0.
  const port=Number(process.env.PORT||9000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid PORT');
  createGatewayServer({WEBSITE_ORIGIN:process.env.WEBSITE_ORIGIN}).listen(port,'0.0.0.0');
}
