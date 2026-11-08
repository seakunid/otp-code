import {Store} from '../src/store.js';import {Gmail} from '../src/browser.js';import {Retrieval} from '../src/service.js';import {createApp} from '../src/app.js';import {Executor} from '../src/executor.js';
if(process.env.OTP_REAL_GMAIL_E2E!=='true')throw Error('Explicit playground E2E opt-in required');
const store=new Store(process.env.OTP_STATE_DB||'runtime/state.sqlite',Buffer.from(process.env.OTP_RETRIEVAL_KEY||'','base64'));
const service=new Retrieval(store,new Gmail(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'),new Executor(),2000,true,true);
const server=createApp(service,process.env.OTP_RETRIEVAL_TOKEN||'',{allowSyntheticVerification:true}).listen(3011,'127.0.0.1');
server.maxConnections=100;server.headersTimeout=10000;server.requestTimeout=15000;
const stop=async()=>{server.close();await service.shutdown();store.close();};
process.on('SIGINT',()=>void stop());process.on('SIGTERM',()=>void stop());
console.log('Playground Gmail REST host on loopback 3011; synthetic activation allowed for tests only.');
