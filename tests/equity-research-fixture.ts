import { app, BrowserWindow, ipcMain, protocol, WebContentsView } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { EquityResearchService } from '../main/equity-research/service';
import { registerEquityResearchHandlers } from '../main/ipc/handlers/equity-research';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { assert, assertEqual, Harness } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');
const equityPluginRoot = officialPluginRoot('equity-research');

const fixtureLanguage = process.env.KLAUS_EQUITY_FIXTURE_LANG || (process.env.KLAUS_EQUITY_FIXTURE_DOC_PATH ? 'zh-CN' : 'en-US');
const profile = process.env.KLAUS_EQUITY_RESEARCH_FIXTURE_PROFILE;
if (!profile) throw new Error('An isolated equity-research fixture profile is required.');
const workspaceDir = join(profile, 'workspace');
mkdirSync(workspaceDir, { recursive: true });
const logs = resolve(__dirname, '../equity-research-logs');
mkdirSync(logs, { recursive: true });

app.setPath('userData', profile);
registerAppScheme();
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const deadline = setTimeout(() => {
    appendFileSync(join(logs, 'fixture-progress.log'), 'Fixture deadline exceeded.\n');
    app.exit(1);
  }, 150_000);
  const test = (name: string, body: () => Promise<void>): Promise<void> => h.test(name, async () => {
    appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} START ${name}\n`);
    try { await body(); }
    finally { appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} END ${name}\n`); }
  });

  protocol.handle(APP_SCHEME, () => new Response(
    '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><h1>Equity research host fixture</h1>',
    { headers: { 'Content-Type': 'text/html' } },
  ));
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    show: false,
    webPreferences: {
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false,
    },
  });
  await window.loadURL(appUrl('index.html'));

  const roles = new WindowRoleRegistry();
  const registry = new ChannelRegistry();
  const caller = { senderId: window.webContents.id, senderFrameIsTop: true, role: 'main' as const };
  roles.register(caller.senderId, caller.role);
  const service = new EquityResearchService({
    configRoot: profile!, window, pluginRoot: () => equityPluginRoot,
    language: () => fixtureLanguage,
    readRoots: () => [workspaceDir, logs], writeRoots: () => [workspaceDir, logs],
    registerRenderer: (id, role) => roles.register(id, role),
    unregisterRenderer: id => roles.unregister(id),
    emit: (channel, data) => {
      const { requestId } = record(data);
      if (channel === 'equity-research:open-panel' && requestId) {
        void router.route(caller, 'equity-research:open-result', [{ requestId, ok: true }]);
      }
    },
  });
  registerEquityResearchHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload: unknown) => {
    const fields = record(payload);
    return handleCoreInvoke({
      roleOf: id => roles.resolver()(id),
      route: (caller, channel, args) => router.route(caller, channel, args),
      windowOp: () => { throw new Error('The equity-research runtime has no window actions.'); },
    }, event, String(fields.command), fields.args);
  });

  const owner = 'equity-fixture-session';
  let id = '';
  const call = async (name: string, fields: Data = {}): Promise<Data> => {
    const result = await service.call(owner, name, { ...(id ? { id } : {}), ...fields });
    assert(result.isError !== true, JSON.stringify(result));
    return record(result.structuredContent);
  };
  const reportPath = join(logs, 'equity-research-fixture-result.json');
  try {
    await test('Open and show the workspace at version one', async () => {
      const path = process.env.KLAUS_EQUITY_FIXTURE_DOC_PATH;
      const document = path ? record(JSON.parse(readFileSync(path, 'utf8'))) : syntheticWorkspace();
      id = String((await call('equity_open', { document })).id);
      const result = await router.route(caller, 'equity-research:panel-show', [{
        id, sessionId: owner, bounds: { x: 480, y: 0, width: 960, height: 900 },
      }]);
      assert(result.ok, JSON.stringify(result));
      const shown = record(result.value);
      assertEqual(shown.ok, true, JSON.stringify(shown));
      assertEqual((await call('equity_inspect')).version, 1, 'opened workspace version');
    });

    await test('Reject a stale publish and recompute valuation on a current publish', async () => {
      const rejected = await service.call(owner, 'equity_publish', { id, expected_version: 0 });
      assertEqual(rejected.isError, true, 'rejected.isError');
      const conflict = record(rejected.structuredContent);
      assertEqual(conflict.conflict, true, 'conflict.conflict');
      assertEqual(conflict.version, 1, 'conflict.version');
      const thesis = fixtureLanguage.startsWith('zh') ? {
        headline: '高配电池放量与现金转化仍有预期差', stance: '积极观察',
        pricedIn: '现价隐含动力电池出货稳步增长，但未充分反映快充和高能量密度产品占比提升。',
        variantPerception: '若神行与麒麟电池在高配车型的渗透率持续上升，产品结构改善可能抵消单价压力，带动自由现金流增长。',
        bullCase: '高配产品放量快于预期，海外订单提升产能利用率。',
        baseCase: '出货稳步增长，高配产品占比缓慢上升。',
        bearCase: '价格竞争加剧，新增产能拖累现金回报。',
        catalysts: ['2027Q1 · 神行与麒麟高配车型放量验证', '2027Q2 · 海外基地爬坡与现金转化验证'],
        falsifiers: ['连续两个季度高配电池占比未提升，且单位毛利走弱'],
        risks: ['原材料价格波动与整车厂年度议价', '海外产能爬坡慢于计划'],
      } : {
        headline: 'Cash conversion can outpace market expectations', stance: 'Constructive',
        pricedIn: 'The current quote implies modest margin expansion.',
        variantPerception: 'Recurring maintenance sales can improve the gross margin mix.',
        bullCase: 'Maintenance renewals accelerate and free cash flow expands.',
        baseCase: 'Renewals remain stable and capacity investment normalizes.',
        bearCase: 'Equipment demand falls and discounts pressure margins.',
        catalysts: ['Next quarterly cash flow disclosure'],
        falsifiers: ['Two successive quarters of falling maintenance renewals'],
        risks: ['Customer concentration', 'Working capital absorption'],
      };
      const published = await call('equity_publish', { expected_version: 1, thesis, valuation_overrides: { wacc: 0.088 } });
      assertEqual(published.version, 2, 'published.version');
      assertEqual(record(published.thesis).headline, thesis.headline, 'record(published.thesis).headline');
      assertEqual(record(record(record(published.valuation).scenarios).base).wacc, 0.088, 'record(record(record(published.valuation).scenarios).base).wacc');
    });

    await test('Save a manual valuation edit through the isolated panel bridge', async () => {
      const inspected = await call('equity_inspect', { include_bars: true });
      const current = record(inspected.document);
      const document = { ...current, valuationOverrides: { ...record(current.valuationOverrides), wacc: 0.094 } };
      const view = window.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView);
      assert(view, 'the equity research panel is attached to the host window');
      const saved = record(await view.webContents.executeJavaScript(
        `window.klausEquityResearchHost.action(${JSON.stringify({ type: 'save', expectedVersion: 2, document })})`,
      ));
      assertEqual(saved.ok, true, JSON.stringify(saved));
      assertEqual(saved.version, 3, 'saved.version');
      const persisted = await call('equity_inspect');
      assertEqual(persisted.version, 3, 'persisted.version');
      // The direct bridge call writes to disk without updating the renderer's local document.
      assertEqual(record(record(service.store.runtimeLoad(id, owner).document).valuationOverrides).wacc, 0.094, 'record(record(service.store.runtimeLoad(id, owner).document).valuationOverrides).wacc');
    });

    await test('Capture all five panels and export an XLSX and an HTML report', async () => {
      window.showInactive();
      for (const tab of ['overview', 'financials', 'valuation', 'peers', 'sources']) {
        const path = join(logs, process.env.KLAUS_EQUITY_FIXTURE_DOC_PATH ? `zh-v2-${tab}-light.png` : `preview-${tab}.png`);
        await call('equity_preview', { tab, output_path: path });
        const bytes = readFileSync(path);
        assertEqual(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', "bytes.subarray(0, 8).toString('hex')");
        assert(bytes.length > 5000, `${tab} preview contains a nontrivial PNG`);
      }
      if (process.env.KLAUS_EQUITY_FIXTURE_DOC_PATH) {
        const view = window.contentView.children.find((child): child is WebContentsView => child instanceof WebContentsView);
        assert(view, 'the equity research panel is attached');
        const measurements: unknown[] = [];
        const errors: string[] = [];
        const original = view.getBounds();
        for (const theme of ['light', 'dark']) for (const width of [480, 720, 960, 1280]) {
          view.setBounds({ ...original, width });
          for (const tab of ['overview', 'financials', 'valuation', 'peers', 'sources']) {
            const geometry = await view.webContents.executeJavaScript(`(async () => {
              const runtime = window.__klausEquityResearchRuntime;
              runtime.setTheme(${JSON.stringify(theme)});
              runtime.invoke('workspace.setTab', ${JSON.stringify(tab)});
              await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
              const rects = selector => [...document.querySelectorAll(selector)].map(node => ({
                className: node.className, ...node.getBoundingClientRect().toJSON(),
              })).filter(rect => rect.width && rect.height);
              return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
                cards: rects('main > section'), controls: rects('.seg,.btn,.num-wrap') };
            })()`);
            measurements.push({ theme, tab, expectedWidth: width, ...geometry });
            if (geometry.width !== width || geometry.scrollWidth > width ||
              geometry.controls.some((r: { height: number }) => Math.abs(r.height - 28) > 1) ||
              geometry.cards.some((a: { top: number; height: number }, i: number) => geometry.cards.slice(i + 1).some((b: typeof a) => Math.abs(a.top - b.top) < 2 && Math.abs(a.height - b.height) > 1))) errors.push(`${theme}/${width}/${tab}`);
          }
        }
        view.setBounds(original);
        writeFileSync(join(logs, 'layout-geometry-audit.json'), JSON.stringify({ measurements, errors }, null, 2));
        await call('equity_preview', { tab: 'overview', output_path: join(logs, 'zh-v2-overview-dark.png') });
        assertEqual(errors.length, 0, `layout errors: ${errors.join(', ')}`);
      }
      const xlsx = join(logs, 'equity-research-fixture.xlsx');
      const html = join(logs, 'equity-research-fixture.html');
      await call('equity_export', { format: 'xlsx', output_path: xlsx });
      await call('equity_export', { format: 'html', output_path: html });
      assertEqual(readFileSync(xlsx).subarray(0, 4).toString('hex'), '504b0304', "readFileSync(xlsx).subarray(0, 4).toString('hex')");
      assert(/^(?:<!doctype html>|<html[\s>])/i.test(readFileSync(html, 'utf8').trimStart()), 'the report starts with HTML markup');
    });
    return await h.finish(reportPath, 'equity-research-fixture');
  } finally {
    clearTimeout(deadline);
    await service.dispose();
    window.destroy();
  }
}

function syntheticWorkspace(): Data {
  const generatedAtMs = Date.UTC(2026, 0, 1);
  const period = { date: '2025-12-31', currency: 'USD', revenue: 800e6, grossProfit: 320e6,
    gaapNetIncome: 96e6, coreNetIncome: 96e6, operatingCashFlow: 132e6, capex: 36e6,
    freeCashFlow: 96e6, cashAndEquivalents: 200e6, totalDebt: 120e6, bookValue: 480e6,
    sharesDiluted: 40e6, eps: 2.4, bps: 12, roe: 20, revenueGrowthPct: 12 };
  const ttm = { currency: 'USD', revenueTtm: 800e6, gaapNetIncomeTtm: 96e6, coreNetIncomeTtm: 96e6,
    ocfTtm: 132e6, capexTtm: 36e6, fcfTtm: 96e6, netCash: 80e6, bookValue: 480e6,
    sharesDiluted: 40e6, eps: 2.4, bps: 12, roe: 0.2, grossMargin: 0.4, netMargin: 0.12 };
  return {
    schema: 1, generatedAtMs,
    security: { market: 'US', code: 'NSTR', ticker: 'NSTR', secucode: 'NSTR.US', name: 'Northstar Industrial', currency: 'USD' },
    quote: { price: 32, prevClose: 31.8, sharesDiluted: 40e6, trailingPe: 13.33, marketCap: 1.28e9, industry: 'Industrial equipment' },
    macro: { riskFreeRate: 0.04, rates: {} },
    bars: Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2025, 10, i + 1)).toISOString().slice(0, 10),
      open: 28 + i / 15, close: 28.1 + i / 15, high: 28.3 + i / 15, low: 27.9 + i / 15, volume: 150000 + 500 * i })),
    financials: { sectorType: 'corporate', statementCurrency: 'USD', quoteCurrency: 'USD', fxToQuote: 1,
      coreLabel: 'Adjusted net income', annual: [period], quarterly: [], ttm: { statement: ttm, quote: ttm },
      operations: [], segments: [], valuationBand: [] },
    valuation: { methodology: 'dcf', scenarios: {}, sensitivity: { waccSteps: [], growthSteps: [], matrix: [] } },
    valuationOverrides: {}, peers: [], peerMedian: {}, peerAverage: {}, consensus: { forecasts: [] },
    ownership: [], filings: [], uiPrefs: { colorConvention: 'green-up' }, thesis: { headline: 'Northstar Industrial' },
    sources: [{ id: 'financials', field: 'Revenue', valueSummary: 'USD 800 million', sourceName: 'Synthetic annual report',
      reportPeriod: '2025', fetchedAtMs: generatedAtMs, verified: false }],
  };
}

void main().then(code => app.exit(code)).catch(error => {
  console.error(error);
  app.exit(1);
});
