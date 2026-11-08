import {join,resolve} from 'node:path';
export const statePath=()=>process.env.OTP_STATE_DB|| (process.platform==='win32'?join(process.env.LOCALAPPDATA||join(process.env.USERPROFILE||'','AppData','Local'),'OTP-Retrieval','state.sqlite'):resolve('runtime/state.sqlite'));
