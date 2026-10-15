// Optional real-browser UI smoke test. Uses local React modules and a mock control channel;
// it never starts a replacement server or writes a user's MCP declarations.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.research', 'ui-smoke');
fs.mkdirSync(out, { recursive: true });
const production = (name, file) => fs.readFileSync(path.join(path.dirname(require.resolve(name)), 'cjs', file), 'utf8');
const scheduler = createRequire(require.resolve('react-dom/client')).resolve('scheduler');
const modules = {
  react: production('react', 'react.production.js'),
  'react-dom': production('react-dom', 'react-dom.production.js'),
  scheduler: fs.readFileSync(path.join(path.dirname(scheduler), 'cjs', 'scheduler.production.js'), 'utf8'),
  'react-dom/client': production('react-dom/client', 'react-dom-client.production.js'),
};
const script = code => `<script>${code.replace(/<\/script/gi, '<\\/script')}</script>`;
let html = `<!doctype html><meta charset="utf-8"><title>MCP UI smoke</title><style>
:root{color-scheme:dark;--dsw-radius-sm:6px;--dsw-radius-lg:14px;--dsw-alias-bg-layer-1:#242527;--dsw-alias-bg-layer-2:#2b2c2f;--dsw-alias-bg-layer-3:#323438;--dsw-alias-bg-overlay:#323336;--dsw-alias-label-primary:#f1f1f3;--dsw-alias-label-secondary:#c1c2c5;--dsw-alias-label-tertiary:#92949a;--dsw-alias-label-dimmed:#74767b;--dsw-alias-label-primary-foreground:#fff;--dsw-alias-border-l1:#505258;--dsw-alias-border-l2:#414349;--dsw-alias-border-l3:#55575d;--dsw-alias-interactive-bg-hover:#414349;--dsw-alias-state-business-primary:#669cff;--dsw-alias-state-success-primary:#4ac47e;--dsw-alias-state-error-primary:#ff8d8d;--dsw-alias-state-warn-primary:#e0b562;--dsw-alias-button-primary-fill:#477fdb;--dsw-alias-button-primary-hover:#548fed;--dsw-menu-surface-fill:#303135}
body{margin:0;background:#191a1c;color:#eee;font:14px 'Segoe UI',sans-serif}#app{position:fixed;bottom:24px;left:32px}#smoke-result{display:none}
</style><div id="app"></div><pre id="smoke-result">running</pre>`;
html += script(`const modules={},cache={};function require(id){if(cache[id])return cache[id].exports;const module={exports:{}};cache[id]=module;modules[id](require,module,module.exports);return module.exports;}`);
for (const [id, code] of Object.entries(modules)) html += script(`modules[${JSON.stringify(id)}]=function(require,module,exports){${code}\n};`);
html += script(`window.__ModuleLoader__={load(entry){window.plugin=entry.factory(require)}};window.__WORKSPACE_MCP_TOKEN__='fixture';`);
html += script(fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8'));
html += script(`
const writes=[];
const fields=[{name:'url',kind:'text'},{name:'transport',kind:'choice',options:['stdio','http']},{name:'command',kind:'text'},{name:'args',kind:'list'},{name:'env',kind:'map'},{name:'cwd',kind:'text'},{name:'headers',kind:'map'}];
const presets=[{id:'root',format:'jsonc',files:['.mcp.json'],editable:true,exists:true,fields},{id:'codex',format:'toml',files:['.codex/config.toml'],editable:true,exists:true,lossy:true,fields:fields.filter(x=>x.name!=='transport')}];
const targets=[{serverId:'unityMCP',preset:'root',file:'.mcp.json',format:'jsonc',editable:true,version:'v1',fields:fields.map(x=>({...x,value:x.name==='transport'?'stdio':x.name==='command'?'node':undefined}))}];
const status={workspace:'D:\\Example\\UnityProject',trusted:false,counts:{connected:1,declarations:1,selected:1},servers:[{id:'unityMCP',state:'connected',tools:Array.from({length:48},(_,i)=>'mcp__unityMCP__tool'+i),source:{preset:'root',file:'.mcp.json',server:'unityMCP'}}]};
window.fetch=async (url,init={})=>{if(url.includes('/wait?'))return new Promise((resolve,reject)=>init.signal?.addEventListener('abort',()=>reject(new DOMException('aborted','AbortError'))));let body={};let code=200;
if(url.includes('/status'))body=status;else if(url.endsWith('/config'))body={editable:true,config:{trustMode:'manual',trustedWorkspaces:[],workspaceAllowances:[]}};
else if(url.endsWith('/declaration')){const request=JSON.parse(init.body);if(request.action==='list')body={writable:true,presets,targets};else{writes.push(request);code=400;body={error:'浏览器测试：模拟拒绝写入，草稿应完整保留。',code:'DECLARATION_INVALID'};}}
return {ok:code<400,status:code,text:async()=>JSON.stringify(body),json:async()=>body};};
require('react-dom/client').createRoot(document.getElementById('app')).render(require('react').createElement(plugin.__internals.Chip,{sessionId:'fixture'}));
const pause=()=>new Promise(r=>setTimeout(r,50));
const assert=(value,message)=>{if(!value)throw Error(message)};
const findButton=text=>[...document.querySelectorAll('button')].find(x=>x.textContent===text);
const click=async element=>{assert(element,'missing button');element.click();await pause()};
const input=async(element,value)=>{assert(element,'missing input');Object.getOwnPropertyDescriptor(element.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(element,value);element.dispatchEvent(new Event('input',{bubbles:true}));element.dispatchEvent(new Event('change',{bubbles:true}));await pause()};
(async()=>{try{
await pause();await click(document.querySelector('.wmcp-chip'));await pause();
const tools=document.querySelector('.wmcp-tools-trigger');assert(tools.textContent.includes('48'),'tools count missing');const box=tools.getBoundingClientRect();assert(box.width>=80&&box.height>=32,'tools hit target too small');await click(tools);assert(document.querySelectorAll('.wmcp-tool').length===48,'tools did not expand');
await click(findButton('＋ 新建'));assert(document.querySelector('.wmcp-backdrop'),'new did not open independent modal');assert(!document.querySelector('.wmcp-panel'),'popover remained underneath');assert(document.querySelector('[aria-label="配置位置"]'),'location still requires separate step');
await input(document.querySelector('input[placeholder="例如 demo"]'),'remote-demo');await click(document.querySelector('[data-value="http"]'));await input(document.querySelector('input[aria-label="url"]'),'https://example.test/mcp');assert(!document.querySelector('input[aria-label="command"]'),'HTTP shows command');
await click(findButton('＋ 添加请求头'));await input(document.querySelector('input[aria-label="headers 第 1 行键名"]'),'Authorization');await input(document.querySelector('input[aria-label="headers 第 1 行值"]'),'Bearer sample');
const select=document.querySelector('[aria-label="配置位置"]');select.value='codex';select.dispatchEvent(new Event('change',{bubbles:true}));await pause();assert(document.querySelector('input[aria-label="url"]').value==='https://example.test/mcp','changing location lost URL');
await click(findButton('创建'));assert(writes.length===0,'TOML wrote before consent');assert(document.querySelector('[role="alertdialog"]'),'TOML confirmation missing');assert(document.body.textContent.includes('注释和排版可能丢失'),'TOML warning missing');await click(findButton('确认重写并继续'));await pause();
assert(writes.length===1&&writes[0].allowLossy===true,'consent not on request');assert(!writes[0].fields.some(x=>x.name==='transport'||x.name==='command'),'Codex wrote unsupported or hidden fields');assert(writes[0].fields.find(x=>x.name==='headers').value.Authorization==='Bearer sample','map row data lost');
await click(document.querySelector('[aria-label="关闭 MCP 管理"]'));assert(document.body.textContent.includes('放弃未保存的修改'),'closing discarded draft without warning');await click(findButton('取消'));assert(document.querySelector('input[placeholder="例如 demo"]').value==='remote-demo','cancel discarded name');
assert(document.querySelector('input[aria-label="headers 第 1 行值"]').type==='password','header value not masked');
const modal=document.querySelector('.wmcp-overlay');assert(modal.getBoundingClientRect().width>700,'manager still narrow');
const result=document.getElementById('smoke-result');result.textContent='PASS: quick new, tools hit area, transport filtering, key/value editing, preset preservation, TOML consent, failure draft retention, dirty close';result.dataset.status='passed';
}catch(error){const result=document.getElementById('smoke-result');result.dataset.status='failed';result.textContent=error.stack;document.title='FAIL: '+error.message;}})();
`);
const page = path.join(out, 'fixture.html');
fs.writeFileSync(page, html);
const edge = process.argv[2] ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const dom = path.join(out, 'result.html');
const fd = fs.openSync(dom, 'w');
const child = spawnSync(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  `--user-data-dir=${path.join(out, 'edge-profile')}`, '--window-size=1360,960', '--virtual-time-budget=12000',
  `--screenshot=${path.join(out, 'manager.png')}`, '--dump-dom', pathToFileURL(page).href], { stdio: ['ignore', fd, 'inherit'], timeout: 30000 });
fs.closeSync(fd);
if (child.error) throw child.error;
if (child.status !== 0) process.exit(child.status ?? 1);
const rendered = fs.readFileSync(dom, 'utf8');
if (!rendered.includes('data-status="passed"')) {
  const message = rendered.match(/<pre id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/)?.[1] ?? 'browser did not complete';
  console.error(message); process.exit(1);
}
console.log('Browser UI smoke passed. Screenshot: .research/ui-smoke/manager.png');
