// One request at a time; hidden/offline tabs make no polling requests.
export function createAutoRefresh({refresh,canRefresh,document,window,interval=30000,
  setTimer=setTimeout,clearTimer=clearTimeout}) {
  let timer=null,running=false,stopped=true,failures=0;
  function schedule(){
    clearTimer(timer);
    if(!stopped)timer=setTimer(tick,Math.min(interval*2**failures,300000));
  }
  async function tick(){
    if(stopped||running)return;
    clearTimer(timer);
    running=true;
    try{
      if(document.visibilityState==='visible'&&window.navigator.onLine!==false&&canRefresh()){
        await refresh();failures=0;
      }
    }catch{failures=Math.min(failures+1,4);} // Keep the last successful view on transient failures.
    finally{running=false;schedule();}
  }
  const resume=()=>{void tick();};
  return {
    start(){if(!stopped)return;stopped=false;document.addEventListener('visibilitychange',resume);window.addEventListener('online',resume);window.addEventListener('focus',resume);schedule();},
    stop(){stopped=true;clearTimer(timer);document.removeEventListener('visibilitychange',resume);window.removeEventListener('online',resume);window.removeEventListener('focus',resume);},
  };
}
