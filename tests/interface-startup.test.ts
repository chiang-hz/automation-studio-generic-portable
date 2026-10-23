import assert from 'node:assert/strict';
import test from 'node:test';
import {interfaceOpenCommand,openInterfaceOnStartup} from '../src/ui/startup.ts';

test('啟動服務後固定開啟介面，呼叫不接受可取消的設定',async()=>{
  const calls:Array<{command:string;args:string[]}>=[];
  const launch=async(command:string,args:string[])=>{calls.push({command,args});};
  assert.equal(await openInterfaceOnStartup(4173,launch),true);
  assert.equal(calls.length,1);
  assert.ok(calls[0].args.includes('http://127.0.0.1:4173/'));
});

test('啟動使用系統網址開啟方式，Windows 不依賴 PowerShell，且拒絕不合法連接埠',()=>{
  assert.deepEqual(interfaceOpenCommand(4173,'win32'),{command:'cmd.exe',args:['/d','/c','start','','http://127.0.0.1:4173/']});
  assert.equal(interfaceOpenCommand(4173,'darwin').command,'open');
  assert.equal(interfaceOpenCommand(4173,'linux').command,'xdg-open');
  assert.throws(()=>interfaceOpenCommand(NaN),/連接埠/);
  assert.throws(()=>interfaceOpenCommand(70000),/連接埠/);
});
