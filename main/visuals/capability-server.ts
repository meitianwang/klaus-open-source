import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { message, record, text, type Data } from './data';
import type { Json } from '../ipc/contract';

/** Loopback MCP endpoints carry an unguessable capability bound to one task. */
export class VisualCapabilityServer {
  private server: Server | undefined;
  private starting: Promise<string> | undefined;
  private closed = false;
  private readonly tokens = new Map<string,string>();
  private readonly owners = new Map<string,string>();
  private readonly sessions = new Map<string,string>();
  private readonly generations = new Map<string,number>();
  constructor(private readonly name: string, private readonly tools: () => Data[], private readonly call: (owner: string,name: string,args: Data) => Promise<Data>, private readonly enabled: () => boolean = () => true) {}
  private start(): Promise<string> {
    if(this.closed)return Promise.reject(new Error(`${this.name} has shut down.`));
    if(this.starting)return this.starting;
    this.starting=new Promise((resolveStart,reject)=>{
      const server=createServer((request,response)=>{void (async()=>{
        try{
          const address=server.address();const host=address&&typeof address!=='string'?`127.0.0.1:${address.port}`:'';
          if(this.closed||request.headers.host!==host||request.headers.origin){this.send(response,403,{error:'Forbidden MCP origin.'});return;}
          const url=new URL(request.url??'/',`http://${host}`);const token=url.pathname.startsWith('/mcp/')?url.pathname.slice(5):'';const owner=this.owners.get(token);
          if(!owner||url.searchParams.get('session')!==owner){this.send(response,404,{error:'Unknown capability.'});return;}
          const sessionId=request.headers['mcp-session-id'];if(sessionId!==undefined&&(typeof sessionId!=='string'||this.sessions.get(sessionId)!==token)){this.send(response,404,{error:'Unknown MCP session.'});return;}
          if(request.method==='DELETE'){if(typeof sessionId==='string')this.sessions.delete(sessionId);this.send(response,200,{});return;}
          if(request.method!=='POST'){this.send(response,405);return;}
          if(!request.headers['content-type']?.toLowerCase().startsWith('application/json')){this.send(response,415);return;}
          const chunks:Buffer[]=[];let length=0;
          for await(const chunk of request){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=bytes.length;if(length>4*1024*1024){this.send(response,413);return;}chunks.push(bytes);}
          let body:Data;try{body=record(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{this.send(response,400,{jsonrpc:'2.0',id:null,error:{code:-32700,message:'Invalid JSON.'}});return;}
          if(body.jsonrpc!=='2.0'||typeof body.method!=='string'){this.send(response,400,{jsonrpc:'2.0',id:body.id??null,error:{code:-32600,message:'Invalid request.'}});return;}
          if(this.owners.get(token)!==owner||!this.enabled()){this.send(response,403,{error:'Capability released or disabled.'});return;}
          if(body.id===undefined){this.send(response,202);return;}
          const params=record(body.params);let result:Json;
          switch(body.method){
            case 'initialize':{const id=randomUUID();this.sessions.set(id,token);response.setHeader('Mcp-Session-Id',id);result={protocolVersion:params.protocolVersion??'2025-06-18',capabilities:{tools:{listChanged:false}},serverInfo:{name:this.name,version:'1.0.0'}};break;}
            case 'ping':result={};break;
            case 'tools/list':result={tools:this.tools()};break;
            case 'resources/list':result={resources:[]};break;
            case 'resources/templates/list':result={resourceTemplates:[]};break;
            case 'prompts/list':result={prompts:[]};break;
            case 'tools/call':result=await this.call(owner,text(params.name,'tool name'),record(params.arguments));break;
            default:this.send(response,200,{jsonrpc:'2.0',id:body.id,error:{code:-32601,message:`Unknown method: ${body.method}`}});return;
          }
          this.send(response,200,{jsonrpc:'2.0',id:body.id,result});
        }catch(error){this.send(response,500,{error:message(error)});}
      })();});
      this.server=server;server.requestTimeout=30_000;server.headersTimeout=10_000;server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const address=server.address();if(!address||typeof address==='string'){reject(new Error('MCP did not bind loopback.'));return;}resolveStart(`http://127.0.0.1:${address.port}`);});
    });return this.starting;
  }
  private send(response: ServerResponse,status: number,value?: unknown): void {if(response.destroyed||response.writableEnded)return;response.statusCode=status;response.setHeader('Cache-Control','no-store');if(value!==undefined)response.setHeader('Content-Type','application/json');response.end(value===undefined?undefined:JSON.stringify(value));}
  async hostCapabilities(owner: string): Promise<Data> {
    text(owner,'renderer session');if(owner.length>256)throw new Error('Renderer session id is too long.');
    if(!this.enabled())return {mcpServers:[],runtimeCapabilityRoots:[]};
    const generation=this.generations.get(owner)??0;
    const base=await this.start();
    if(this.closed||generation!==(this.generations.get(owner)??0)||!this.enabled())throw new Error('Visual capability was released while starting.');
    let token=this.tokens.get(owner);if(!token){token=randomBytes(32).toString('hex');this.tokens.set(owner,token);this.owners.set(token,owner);}
    // Deferred by default: schemas are surfaced via tool_search, not sent with every request.
    return {mcpServers:[{name:this.name,transport:'http',url:`${base}/mcp/${token}?session=${encodeURIComponent(owner)}`}],runtimeCapabilityRoots:[]};
  }
  releaseSession(owner: string): void {this.generations.set(owner,(this.generations.get(owner)??0)+1);const token=this.tokens.get(owner);this.tokens.delete(owner);if(token){this.owners.delete(token);for(const [id,entry]of this.sessions)if(entry===token)this.sessions.delete(id);}}
  async shutdown(): Promise<void> {if(this.closed)return;this.closed=true;this.tokens.clear();this.owners.clear();this.sessions.clear();if(this.starting)await this.starting.catch(()=>{});if(this.server){this.server.closeAllConnections();await new Promise<void>(resolveClose=>this.server!.close(()=>resolveClose()));this.server=undefined;}}
}
