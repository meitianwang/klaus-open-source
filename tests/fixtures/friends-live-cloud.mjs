import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.KLAUS_FRIENDS_E2E_ROOT;
if (!root || !process.env.DATABASE_URL || !process.env.KLAUS_FRIENDS_E2E_CONTROL_TOKEN) throw new Error('Explicit isolated E2E root, database and control token are required');
const repo = resolve(import.meta.dirname, '../../../..');
const moduleAt = file => import(pathToFileURL(resolve(repo, file)).href);
const [{ UserStore }, { getPool, withUserScope, closeDb }, { MobileDevicesRepoPg }, devices, { MobileRelayBroker }, { handleFriendsRequest }] = await Promise.all([
  moduleAt('src/user-store.ts'), moduleAt('src/db/connection.ts'), moduleAt('src/db/repos/mobile-devices.pg.ts'), moduleAt('src/channels/mobile-devices.ts'), moduleAt('src/channels/mobile-relay.ts'), moduleAt('src/channels/web-friends.ts'),
]);
mkdirSync(root, { recursive: true });
const progress = (phase, value) => appendFileSync(resolve(root, 'cloud-progress.jsonl'), JSON.stringify({ at: Date.now(), phase, value }) + '\n');
const users = new UserStore();
const accounts = {};
for (const role of ['sender', 'receiver']) {
  const user = await users.register(`${role}@friends-e2e.example.test`, randomBytes(32).toString('hex'), `Friends E2E ${role}`, '');
  const issued = await users.issueDesktopToken(user.id, 'Isolated friends E2E fixture');
  if (!issued) throw new Error('The actual UserStore did not issue an isolated desktop token');
  accounts[role] = issued;
}
const authorize = (deviceId, userId, token, bridgeId) => withUserScope(userId, tx => new MobileDevicesRepoPg(tx).authorizesDevice(deviceId, userId, token, bridgeId));
const broker = new MobileRelayBroker({
  authenticateMobile: async token => { const user = await users.validateDesktopToken(token); return user ? { userId: user.id } : null; },
  authorizeDeviceForUser: authorize,
  authorizeBridgeForUser: (bridgeId, userId) => withUserScope(userId, async tx => Boolean((await new MobileDevicesRepoPg(tx).findByRelayId(bridgeId))?.user_id === userId)),
});
const inference = { sender: [], receiver: [] };
const senderToolCalls = [];
const naturalMarker = 'FRIENDS_E2E_NATURAL_COLLABORATION';
const receiverAnswer = 'The isolated task finished with its explicitly authorized resource scope.';
let holdReceiver = false;
const pendingReplies = new Set();
const controlToken = process.env.KLAUS_FRIENDS_E2E_CONTROL_TOKEN;
const body = async req => { const chunks = []; for await (const chunk of req) chunks.push(chunk); return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); };
const json = (res, status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
function toolFor(request) {
  const candidates = (request.tools || []).map(tool => tool.function || tool);
  return candidates.find(tool => /^(?:Bash|bash|shell|exec_command|execute_command|run_shell_command)$/.test(tool.name || '')) || candidates.find(tool => tool.name === 'exec');
}
function toolArguments(tool, command) {
  const properties = tool.parameters?.properties || tool.input_schema?.properties || {};
  if (tool.name === 'exec') return { source: `const selected = ALL_TOOLS.find(tool => tool.name === 'bash'); if (!selected) throw new Error('The actual scoped bash tool is unavailable'); const result = await tools[selected.name]({ command: ${JSON.stringify(command)} }); text(result);` };
  if ('command' in properties) return { command };
  if ('cmd' in properties) return { cmd: command };
  if ('script' in properties) return { script: command };
  throw new Error(`Unsupported actual shell tool schema: ${tool.name}`);
}
function textOf(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('\n');
  if (!value || typeof value !== 'object') return '';
  return ['text', 'content', 'output'].map(key => textOf(value[key])).filter(Boolean).join('\n');
}
function requestRows(request) {
  return Array.isArray(request.messages) ? request.messages : Array.isArray(request.input) ? request.input : [{ role: 'user', content: request.input || '' }];
}
function toolResults(request) {
  const names = new Map(), results = [];
  for (const row of requestRows(request)) {
    for (const call of row.tool_calls || []) names.set(call.id, call.function?.name);
    if (row.type === 'function_call') names.set(row.call_id, row.name);
    if (row.role === 'tool' || row.type === 'function_call_output') results.push({ name: row.name || names.get(row.tool_call_id || row.call_id), text: textOf(row) });
  }
  return results;
}
function parseFriendList(text) {
  for (const candidate of [text, ...text.split('\n')]) {
    try { const value = JSON.parse(candidate); if (Array.isArray(value.friends)) return value.friends; } catch {}
  }
  throw new Error('The actual list_friends output did not contain a friend list');
}
function functionOutput(role, sequence, api, name, args) {
  const argumentsJson = JSON.stringify(args);
  if (api === 'responses') return { id: `resp_${role}_${sequence}`, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model: 'friends-e2e',
    output: [{ type: 'function_call', id: `fc_${role}_${sequence}`, call_id: `call_${role}_${sequence}`, name, arguments: argumentsJson }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } };
  return { id: `chatcmpl_${role}_${sequence}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'friends-e2e', choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${role}_${sequence}`, type: 'function', function: { name, arguments: argumentsJson } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
}
function modelOutput(role, request, api) {
  const sequence = inference[role].length;
  const hasToolResult = (Array.isArray(request.messages) ? request.messages : []).some(row => row.role === 'tool') || (Array.isArray(request.input) ? request.input : []).some(row => row.type === 'function_call_output');
  const compaction = requestRows(request).some(row => row.role === 'system' && textOf(row).includes('compacting a long software-engineering conversation'));
  if (compaction) { const answer = 'The user requested the current friend collaboration. Retain the explicit local resource grant and original reply routing. No tool operation has been performed.'; if (api === 'responses') return { id:`summary_${role}_${sequence}`,object:'response',status:'completed',model:'friends-e2e',output:[{type:'message',id:`summary_msg_${sequence}`,role:'assistant',content:[{type:'output_text',text:answer}]}],usage:{input_tokens:20,output_tokens:20,total_tokens:40}}; return {id:`summary_${role}_${sequence}`,object:'chat.completion',model:'friends-e2e',choices:[{index:0,message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:20,completion_tokens:20,total_tokens:40}}; }
  const tool = toolFor(request), marker = resolve(root, 'grant', 'approved-marker.txt');
  const deniedMarker = resolve(root, 'unauthorized-marker.txt');
  // The receiver's global bypass preference must not escape its task scope.
  // Both attempted destinations are owned test artifacts, never user files.
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const markerCommand = `if printf 'unexpected global permission escape' > ${quote(deniedMarker)}; then exit 29; fi; printf 'approved by actual Rust tool execution' > ${quote(marker)}`;
  if (role === 'receiver' && !hasToolResult) {
    if (!tool) throw new Error('The real engine did not offer an identifiable shell tool; the E2E test cannot fake execution');
    return functionOutput(role, sequence, api, tool.name, toolArguments(tool, markerCommand));
  }
  const latestUserText = textOf(requestRows(request).filter(row => row.role === 'user').at(-1));
  const externalReply = latestUserText.includes('Result from a friend for the collaboration requested in this conversation.');
  const natural = role === 'sender' && !externalReply && latestUserText.includes(naturalMarker);
  if (natural) {
    const results = toolResults(request), sent = results.findLast(row => row.name === 'send_message_to_friend');
    if (!sent) {
      const listed = results.findLast(row => row.name === 'list_friends');
      const name = listed ? 'send_message_to_friend' : 'list_friends';
      if (!(request.tools || []).some(tool => (tool.function || tool).name === name)) throw new Error(`The real sender engine did not advertise ${name}`);
      let args = {};
      if (listed) {
        const friend = parseFriendList(listed.text).find(row => row.status === 'accepted' && row.peerAllowsAgentTasks === true);
        if (!friend?.id) throw new Error('The actual list_friends output did not authorize a target');
        args = { friendId: friend.id, prompt: 'FRIENDS_E2E_NATURAL_TASK: Write the isolated approval marker in your explicitly authorized directory and return the final result.' };
      }
      senderToolCalls.push({ sequence, name, args });progress('sender_tool_call', { sequence, name });
      return functionOutput(role, sequence, api, name, args);
    }
  }
  const answer = role === 'receiver' ? receiverAnswer : externalReply ? 'The isolated friend result was received in this original conversation.' : 'The isolated friend task request has been sent.';
  if (api === 'responses') return { id: `resp_${role}_${sequence}`, object: 'response', created_at: Math.floor(Date.now()/1000), status: 'completed', model: 'friends-e2e', output: [{ type: 'message', id: `msg_${sequence}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: answer, annotations: [] }] }], usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 } };
  return { id: `chatcmpl_${role}_${sequence}`, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: 'friends-e2e', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } };
}
async function model(req, res, role, api) {
  const request = await body(req);
  inference[role].push({ at: Date.now(), api, request }); progress('model_request', { role, count: inference[role].length });
  writeFileSync(resolve(root, `model-${role}-${inference[role].length}.json`), JSON.stringify(request, null, 2));
  if (role === 'receiver' && holdReceiver) {
    pendingReplies.add(res); res.on('close', () => pendingReplies.delete(res)); return;
  }
  const response = modelOutput(role, request, api);
  if (!request.stream) return json(res, 200, response);
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  if (api === 'responses') {
    const events = [{ type:'response.created', response:{ ...response,status:'in_progress',output:[] } }];
    for (const [output_index,item] of response.output.entries()) {
      events.push({ type:'response.output_item.added', output_index,item: item.type==='function_call' ? { ...item,arguments:'' } : { ...item,content:[] } });
      if(item.type==='function_call') {events.push({type:'response.function_call_arguments.delta',item_id:item.id,output_index,delta:item.arguments});events.push({type:'response.function_call_arguments.done',item_id:item.id,output_index,arguments:item.arguments});}
      else {const part=item.content[0];events.push({type:'response.content_part.added',item_id:item.id,output_index,content_index:0,part:{...part,text:''}});events.push({type:'response.output_text.delta',item_id:item.id,output_index,content_index:0,delta:part.text});events.push({type:'response.output_text.done',item_id:item.id,output_index,content_index:0,text:part.text});events.push({type:'response.content_part.done',item_id:item.id,output_index,content_index:0,part});}
      events.push({type:'response.output_item.done',output_index,item});
    }
    events.push({type:'response.completed',response});for(const event of events)res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  } else {
    const choice = response.choices[0], delta = choice.message.tool_calls ? { role: 'assistant', tool_calls: choice.message.tool_calls.map((call,index) => ({ ...call,index })) } : choice.message;
    res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}
const server = createServer((req,res) => { void (async () => {
  const url = new URL(req.url || '/', 'http://fixture.invalid');
  if (url.pathname.startsWith('/fixture/')) {
    if (req.headers.authorization !== `Bearer ${controlToken}`) return json(res, 403, { error: 'fixture_control_required' });
    if (url.pathname === '/fixture/state') return json(res, 200, { inference: { sender: inference.sender.length, receiver: inference.receiver.length }, senderToolCalls, receiverAnswer, accounts: Object.fromEntries(Object.entries(accounts).map(([role,value]) => [role,{ id:value.user.id, email:value.user.email }])), devices: (await getPool().query('SELECT device_id, user_id, custom_name, display_name, relay_id, features FROM user_devices')).rows });
    if (url.pathname === '/fixture/hold-model') { holdReceiver = (await body(req)).hold === true; if (!holdReceiver) { for (const response of pendingReplies) response.destroy(); pendingReplies.clear(); } return json(res, 200, { holdReceiver }); }
    if (url.pathname === '/fixture/offline-device') {
      const id = 'friends-e2e-offline-computer', token = accounts.receiver.token;
      await withUserScope(accounts.receiver.user.id, tx => new MobileDevicesRepoPg(tx).upsert({ userId: accounts.receiver.user.id, authToken: token, deviceId:id, displayName:'Offline E2E computer', platform:process.platform, relayId:'friends_e2e_offline_relay', relayUrl:origin, appVersion:'e2e', features:{ friendsMessaging:2 }, now:Date.now() }));
      return json(res, 200, { id });
    }
    return json(res, 404, { error:'fixture_control_not_found' });
  }
  const inferenceRoute = /^\/model\/(sender|receiver)\/v1\/(responses|chat\/completions)$/.exec(url.pathname);
  if (inferenceRoute) return model(req,res,inferenceRoute[1],inferenceRoute[2] === 'responses' ? 'responses' : 'chat');
  if (/^\/model\/(sender|receiver)\/v1\/models$/.test(url.pathname)) return json(res, 200, { object:'list', data:[{ id:'friends-e2e', object:'model', owned_by:'isolated-fixture' }] });
  if (url.pathname === '/api/friends/request') return handleFriendsRequest(req,res,users,{ relay:broker });
  const deviceHandlers = { '/api/mobile/devices': devices.handleMobileDevicesList, '/api/mobile/devices/register': devices.handleMobileDeviceRegister, '/api/mobile/devices/heartbeat': devices.handleMobileDeviceHeartbeat, '/api/mobile/devices/unregister': devices.handleMobileDeviceUnregister };
  if (deviceHandlers[url.pathname]) return deviceHandlers[url.pathname](req,res,users);
  if (url.pathname.startsWith('/api/mobile/relay/')) { if (await broker.handleHttp(req,res)) return; }
  if (url.pathname === '/healthz') return json(res,200,{ fixture:true });
  return json(res,404,{ error:'fixture_route_not_found' });
})().catch(error => { progress('http_failure',{ path:req.url, message:String(error) }); if (!res.headersSent) json(res,500,{ error:String(error) }); else res.destroy(); }); });
server.on('upgrade',(req,socket,head) => { void broker.handleUpgrade(req,socket,head).then(handled => { if (!handled) socket.destroy(); }).catch(() => socket.destroy()); });
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
writeFileSync(resolve(root,'cloud-ready.json'),JSON.stringify({ origin, accounts },null,2),{ mode:0o600 });
progress('ready',{ origin, users:Object.fromEntries(Object.entries(accounts).map(([role,value]) => [role,value.user.id])) });
const close = async () => { broker.close(); for (const response of pendingReplies) response.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await closeDb(); process.exit(0); };
process.once('SIGTERM',() => void close()); process.once('SIGINT',() => void close());
