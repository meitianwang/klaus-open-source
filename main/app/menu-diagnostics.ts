import { BrowserWindow, contentTracing, dialog, shell, type App, type BrowserWindowConstructorOptions, type ProcessMetric } from 'electron';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export type MenuTraceState = 'idle' | 'starting' | 'recording' | 'stopping' | 'saving';

export interface MenuDiagnosticsOptions {
  app: Pick<App, 'getAppMetrics' | 'getVersion' | 'getName'>;
  configRoot: string;
  parent: () => BrowserWindow | null | undefined;
  chinese: () => boolean;
  status: () => Record<string, unknown>;
  onChanged: () => void;
  log: (kind: string, detail: string) => void;
}

/** Optional native ports keep lifecycle tests independent of the GUI process. */
export interface MenuDiagnosticsServices {
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  tracing: Pick<typeof contentTracing, 'startRecording' | 'stopRecording' | 'getTraceBufferUsage'>;
  dialog: Pick<typeof dialog, 'showSaveDialog' | 'showMessageBox'>;
  shell: Pick<typeof shell, 'openPath' | 'showItemInFolder'>;
}

const labels = {
  en: {
    tasks: 'Task Manager', status: 'System Status', process: 'Process', pid: 'Process ID', type: 'Type', cpu: 'CPU (%)',
    memory: 'Memory (MB)', peak: 'Peak memory (MB)', refresh: 'Updates every second. Select a column heading to sort.',
    updated: 'Last updated', unavailable: 'Diagnostics are unavailable.', version: 'Version', platform: 'Platform',
    processes: 'Application processes', engine: 'Engine', native: 'Native capabilities', ready: 'Ready', stopped: 'Stopped',
    engineProcesses: 'Engine processes', searches: 'Search processes', ptys: 'Terminal sessions', searchSessions: 'Search sessions',
    traceStart: 'Start Performance Trace', traceStarting: 'Starting Performance Trace…', traceStop: 'Stop Performance Trace',
    traceStopping: 'Stopping Performance Trace…', traceSaving: 'Saving Performance Trace…', traceSave: 'Save Performance Trace',
    traceSaved: 'Performance trace saved', traceRetained: 'The performance trace is available at:',
    traceError: 'Performance trace could not be completed', diagnosticsError: 'Diagnostics could not be opened',
    openLogs: 'Open Logs Folder', ok: 'OK', saved: 'The performance trace was saved to:',
  },
  zh: {
    tasks: '任务管理器', status: '系统状态', process: '进程', pid: '进程 ID', type: '类型', cpu: 'CPU（%）',
    memory: '内存（MB）', peak: '峰值内存（MB）', refresh: '每秒更新。选择列标题进行排序。',
    updated: '最后更新', unavailable: '诊断信息暂不可用。', version: '版本', platform: '平台',
    processes: '应用进程数', engine: '引擎', native: '原生能力', ready: '就绪', stopped: '已停止',
    engineProcesses: '引擎进程数', searches: '搜索进程数', ptys: '终端会话数', searchSessions: '搜索会话数',
    traceStart: '开始性能跟踪', traceStarting: '正在开始性能跟踪…', traceStop: '停止性能跟踪',
    traceStopping: '正在停止性能跟踪…', traceSaving: '正在保存性能跟踪…', traceSave: '保存性能跟踪',
    traceSaved: '性能跟踪已保存', traceRetained: '性能跟踪文件位于：',
    traceError: '无法完成性能跟踪', diagnosticsError: '无法打开诊断信息',
    openLogs: '打开日志文件夹', ok: '确定', saved: '性能跟踪已保存至：',
  },
};

type Copy = typeof labels.en;
type DiagnosticKind = 'tasks' | 'status';
interface DiagnosticWindow { window: BrowserWindow; timer: NodeJS.Timeout; ready: boolean; updating: boolean; }

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}

function page(kind: DiagnosticKind, copy: Copy, chinese: boolean, nonce: string): string {
  const title = kind === 'tasks' ? copy.tasks : copy.status;
  return `<!doctype html><html lang="${chinese ? 'zh-CN' : 'en'}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'">
<meta name="color-scheme" content="light dark"><title>${title}</title><style>
:root{font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color-scheme:light dark}body{margin:24px;color:CanvasText;background:Canvas}h1{font-size:22px;font-weight:600;margin:0 0 12px}p{color:GrayText}table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid color-mix(in srgb,CanvasText 14%,transparent)}th{position:sticky;top:0;background:Canvas}th button{border:0;padding:0;background:transparent;color:inherit;font:inherit;font-weight:600;cursor:pointer;text-align:left}button:focus-visible{outline:2px solid Highlight;outline-offset:4px}td{white-space:pre-wrap;overflow-wrap:anywhere}#message{color:GrayText}#updated{font-size:12px}th:nth-child(n+4),.numeric{text-align:right}</style></head>
<body><h1>${title}</h1><p id="hint"></p><p id="message" role="status"></p><table><thead id="head"></thead><tbody id="rows"></tbody></table><p id="updated"></p>
<script nonce="${nonce}">
(()=>{'use strict';const kind=${scriptJson(kind)};let copy=${scriptJson(copy)},locale=${scriptJson(chinese ? 'zh-CN' : 'en')},current=null,sortKey='cpu',descending=true;
const columns=[['name','process'],['pid','pid'],['type','type'],['cpu','cpu'],['memory','memory'],['peak','peak']];
const element=(tag,value)=>{const node=document.createElement(tag);node.textContent=String(value??'');return node;};
if(kind==='tasks'){const row=document.createElement('tr');for(const [key,label] of columns){const th=document.createElement('th'),button=element('button',copy[label]);button.type='button';button.addEventListener('click',()=>{descending=sortKey===key?!descending:!['name','type'].includes(key);sortKey=key;render();});th.append(button);th.dataset.key=key;th.dataset.label=label;row.append(th);}document.getElementById('head').append(row);}
function render(){if(!current)return;const body=document.getElementById('rows');body.replaceChildren();document.querySelector('h1').textContent=copy[kind];document.title=current.title;document.documentElement.lang=locale;document.getElementById('message').textContent=current.error?copy.unavailable:'';
if(kind==='tasks'){document.getElementById('hint').textContent=copy.refresh;for(const th of document.querySelectorAll('th')){th.setAttribute('aria-sort',th.dataset.key===sortKey?(descending?'descending':'ascending'):'none');th.querySelector('button').textContent=copy[th.dataset.label];}const rows=[...(current.rows||[])].sort((a,b)=>{const av=a[sortKey],bv=b[sortKey];return (typeof av==='number'?av-bv:String(av).localeCompare(String(bv),locale))*(descending?-1:1);});for(const value of rows){const row=document.createElement('tr');for(const [key] of columns){const cell=element('td',['cpu','memory','peak'].includes(key)?Number(value[key]).toLocaleString(locale,{maximumFractionDigits:1}):value[key]);if(['pid','cpu','memory','peak'].includes(key))cell.className='numeric';row.append(cell);}body.append(row);}}
else for(const entry of current.rows||[]){const row=document.createElement('tr');row.append(element('th',entry[0]),element('td',entry[1]));body.append(row);}
document.getElementById('updated').textContent=copy.updated+': '+new Date(current.at).toLocaleTimeString(locale);}
globalThis.updateDiagnostics=value=>{current=value;copy=value.copy;locale=value.locale;render();};})();
</script></body></html>`;
}

function metricRows(metrics: ProcessMetric[], chinese: boolean): Array<Record<string, string | number>> {
  const names: Record<string, string> = { Browser: '主进程', Tab: '渲染进程', Utility: '工具进程', Zygote: '派生进程',
    'Sandbox helper': '沙盒辅助进程', GPU: '图形进程', 'Pepper Plugin': '插件进程', 'Pepper Plugin Broker': '插件代理进程', Unknown: '未知进程' };
  return metrics.map(metric => ({ name: metric.name || metric.serviceName || (chinese ? names[metric.type] ?? metric.type : metric.type), pid: metric.pid, type: chinese ? names[metric.type] ?? metric.type : metric.type,
    cpu: metric.cpu.percentCPUUsage, memory: metric.memory.workingSetSize / 1024, peak: metric.memory.peakWorkingSetSize / 1024 }));
}

export class DesktopMenuDiagnostics {
  private readonly services: MenuDiagnosticsServices;
  private readonly windows = new Map<DiagnosticKind, DiagnosticWindow>();
  private state: MenuTraceState = 'idle';
  private ownsRecording = false;
  private closed = false;
  private operation: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private bufferTimer: NodeJS.Timeout | null = null;
  private checkingBuffer = false;

  constructor(private readonly options: MenuDiagnosticsOptions, services?: Partial<MenuDiagnosticsServices>) {
    this.services = { createWindow: options => new BrowserWindow(options), tracing: contentTracing, dialog, shell, ...services };
  }

  get traceState(): MenuTraceState { return this.state; }
  get traceEnabled(): boolean { return !this.closed && (this.state === 'idle' || this.state === 'recording'); }
  get traceLabel(): string {
    const copy = this.copy();
    return ({ idle: copy.traceStart, starting: copy.traceStarting, recording: copy.traceStop, stopping: copy.traceStopping, saving: copy.traceSaving })[this.state];
  }

  showTaskManager(): Promise<void> { return this.show('tasks'); }
  showStatus(): Promise<void> { return this.show('status'); }

  async openTroubleshooting(): Promise<void> {
    if (this.closed) return;
    try {
      await mkdir(this.options.configRoot, { recursive: true, mode: 0o700 });
      const failure = await this.services.shell.openPath(this.options.configRoot);
      if (failure) throw new Error(failure);
    } catch (error) { await this.report('menu-troubleshooting', this.copy().diagnosticsError, error); }
  }

  toggleTrace(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.operation) return this.operation;
    if (!this.traceEnabled) return Promise.resolve();
    const operation = this.state === 'recording' ? this.stopTrace(true) : this.startTrace();
    this.operation = operation.finally(() => { this.operation = null; });
    return this.operation;
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = this.dispose();
    return this.closing;
  }

  private async dispose(): Promise<void> {
    this.closed = true;
    this.clearBufferTimer();
    for (const entry of this.windows.values()) { clearInterval(entry.timer); if (!entry.window.isDestroyed()) entry.window.destroy(); }
    this.windows.clear();
    await this.operation;
    if (this.ownsRecording) await this.stopTrace(false);
  }

  private copy(): Copy { return this.options.chinese() ? labels.zh : labels.en; }
  private changed(state: MenuTraceState): void {
    this.state = state;
    try { this.options.onChanged(); } catch (error) { this.log('menu-diagnostics-change', error); }
  }
  private log(kind: string, value: unknown): void {
    try { this.options.log(kind, value instanceof Error ? value.message : String(value)); } catch { /* Diagnostics must not interrupt normal work. */ }
  }

  private async report(kind: string, title: string, error: unknown): Promise<void> {
    this.log(kind, error);
    if (this.closed) return;
    const options = { type: 'error' as const, title, message: title, detail: error instanceof Error ? error.message : String(error), buttons: [this.copy().ok] };
    try {
      const parent = this.options.parent();
      if (parent && !parent.isDestroyed()) await this.services.dialog.showMessageBox(parent, options);
      else await this.services.dialog.showMessageBox(options);
    } catch (failure) { this.log('menu-diagnostics-dialog', failure); }
  }

  private async show(kind: DiagnosticKind): Promise<void> {
    if (this.closed) return;
    const existing = this.windows.get(kind);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show(); existing.window.focus();
      await this.update(kind, existing); return;
    }
    try {
      const copy = this.copy();
      const window = this.services.createWindow({ width: kind === 'tasks' ? 880 : 620, height: 560, minWidth: 480, minHeight: 320,
        title: `${this.options.app.getName()} — ${kind === 'tasks' ? copy.tasks : copy.status}`, show: false, autoHideMenuBar: true,
        webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
          partition: `menu-diagnostics-${randomUUID()}` } });
      window.setMenu(null);
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', event => event.preventDefault());
      window.webContents.on('will-redirect', event => event.preventDefault());
      window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      window.webContents.session.setPermissionCheckHandler(() => false);
      const entry: DiagnosticWindow = { window, ready: false, updating: false, timer: setInterval(() => { void this.update(kind, entry); }, 1000) };
      entry.timer.unref();
      this.windows.set(kind, entry);
      window.once('closed', () => { clearInterval(entry.timer); if (this.windows.get(kind) === entry) this.windows.delete(kind); });
      try {
        await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(page(kind, copy, this.options.chinese(), randomUUID()))}`);
        if (window.isDestroyed() || this.closed) return;
        entry.ready = true;
        await this.update(kind, entry);
        window.show();
      } catch (error) { if (!window.isDestroyed()) window.destroy(); throw error; }
    } catch (error) { await this.report('menu-diagnostics-window', this.copy().diagnosticsError, error); }
  }

  private async update(kind: DiagnosticKind, entry: DiagnosticWindow): Promise<void> {
    if (this.closed || !entry.ready || entry.updating || entry.window.isDestroyed()) return;
    entry.updating = true;
    try {
      const chinese = this.options.chinese(), copy = chinese ? labels.zh : labels.en;
      const title = `${this.options.app.getName()} — ${copy[kind]}`;
      let rows: unknown, error = false;
      try {
        if (kind === 'tasks') rows = metricRows(this.options.app.getAppMetrics(), chinese);
        else {
          const local = this.options.status();
          const names: Record<string, string> = { engine: copy.engine, native: copy.native, version: copy.version, platform: copy.platform, processes: copy.processes,
            engineProcesses: copy.engineProcesses, searches: copy.searches, ptys: copy.ptys, searchSessions: copy.searchSessions };
          rows = [[copy.version, this.options.app.getVersion()], [copy.platform, `${process.platform} ${process.arch}`],
            [copy.processes, this.options.app.getAppMetrics().length],
            ...Object.entries(local).map(([key, value]) => [names[key] ?? key, typeof value === 'string' ? value : JSON.stringify(value)])];
        }
      } catch (failure) { this.log('menu-diagnostics-snapshot', failure); rows = []; error = true; }
      await entry.window.webContents.executeJavaScript(`globalThis.updateDiagnostics(${scriptJson({ rows, at: Date.now(), error, title, copy, locale: chinese ? 'zh-CN' : 'en' })})`);
      if (!entry.window.isDestroyed()) entry.window.setTitle(title);
    } catch (error) { if (!entry.window.isDestroyed()) this.log('menu-diagnostics-refresh', error); }
    finally { entry.updating = false; }
  }

  private async startTrace(): Promise<void> {
    this.changed('starting');
    try {
      await this.services.tracing.startRecording({ included_categories: ['*', 'disabled-by-default-v8.cpu_profiler'], recording_mode: 'record-until-full' });
      this.ownsRecording = true;
      this.changed('recording');
      if (this.closed) return;
      this.bufferTimer = setInterval(() => { void this.checkBuffer(); }, 1000);
      this.bufferTimer.unref();
    } catch (error) {
      this.changed('idle');
      await this.report('menu-trace-start', this.copy().traceError, error);
    }
  }

  private clearBufferTimer(): void { if (this.bufferTimer) clearInterval(this.bufferTimer); this.bufferTimer = null; }
  private async checkBuffer(): Promise<void> {
    if (this.closed || this.state !== 'recording' || this.checkingBuffer || this.operation) return;
    this.checkingBuffer = true;
    try {
      const usage = await this.services.tracing.getTraceBufferUsage();
      if (usage.percentage >= 0.99 && this.state === 'recording' && !this.closed && !this.operation) await this.toggleTrace();
    } catch (error) { this.log('menu-trace-buffer', error); }
    finally { this.checkingBuffer = false; }
  }

  private async stopTrace(prompt: boolean): Promise<void> {
    this.clearBufferTimer();
    this.changed('stopping');
    let retained: string | undefined;
    try {
      const directory = join(this.options.configRoot, 'diagnostics');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const path = join(directory, `performance-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      retained = await this.services.tracing.stopRecording(path);
      this.ownsRecording = false;
      await chmod(retained, 0o600);
      this.log('menu-trace-saved', retained);
      if (prompt && !this.closed) {
        this.changed('saving');
        const options = { title: this.copy().traceSave, defaultPath: retained, filters: [{ name: 'JSON', extensions: ['json'] }] };
        const parent = this.options.parent();
        const result = parent && !parent.isDestroyed() ? await this.services.dialog.showSaveDialog(parent, options) : await this.services.dialog.showSaveDialog(options);
        if (!result.canceled && result.filePath) {
          if (result.filePath !== retained) { await copyFile(retained, result.filePath); await chmod(result.filePath, 0o600); }
          this.services.shell.showItemInFolder(result.filePath);
        } else if (!this.closed) {
          const notice = { type: 'info' as const, title: this.copy().traceSaved, message: this.copy().traceRetained, detail: retained, buttons: [this.copy().ok] };
          if (parent && !parent.isDestroyed()) await this.services.dialog.showMessageBox(parent, notice);
          else await this.services.dialog.showMessageBox(notice);
        }
      }
      this.changed('idle');
    } catch (error) {
      this.changed(this.ownsRecording ? 'recording' : 'idle');
      if (retained) this.log('menu-trace-retained', retained);
      if (this.ownsRecording && !this.closed) { this.bufferTimer = setInterval(() => { void this.checkBuffer(); }, 1000); this.bufferTimer.unref(); }
      await this.report('menu-trace-stop', this.copy().traceError, error);
    }
  }
}
