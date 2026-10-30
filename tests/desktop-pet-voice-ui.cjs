const { app, BrowserWindow } = require('electron');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const assert = require('node:assert/strict');
const logs = process.argv[2];
app.setPath('userData', mkdtempSync(join(tmpdir(), 'klaus-pet-voice-ui-')));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 530, height: 550, show: true, webPreferences: { backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  const js = source => window.webContents.executeJavaScript(source, true);
  const until = async (source, label) => {
    const end = Date.now() + 8000;
    while (Date.now() < end) { if (await js(source)) return; await wait(30); }
    throw Error(label);
  };
  try {
    await window.loadFile(join(logs, 'voice.html'));
    await until('document.body.textContent.includes("当前会话的模型来源不支持实时语音聊天")', 'Localized capability notice appears');
    const count = await js('document.body.textContent.split("当前会话的模型来源不支持实时语音聊天").length - 1');
    assert.equal(count, 1); assert.equal(await js('window.__petVoiceFixture.errors.length'), 0);
    assert.equal(await js('document.querySelectorAll("[role=alert]").length'), 0);
    assert.equal(await js('document.querySelector(".pet-dictation svg").getBoundingClientRect().width >= 16'), true);
    await js('document.querySelector(".pet-dictation").click()');
    await until('document.querySelector(".pet-dictation").dataset.dictationState === "recording"', 'Configured account starts recording despite unsupported realtime');
    await wait(1250);
    await js('document.querySelector(".pet-dictation").click()');
    await until('document.querySelector("textarea").value === "语音输入草稿"', 'Transcription enters the editable draft');
    const request = await js('window.__petVoiceFixture.transcriptions[0]');
    assert.equal(request.source, 'qwenwork'); assert.equal(request.mime, 'audio/wav'); assert(request.bytes > 44);
    assert.equal(await js('window.__petVoiceFixture.transcriptions.length'), 1);
    assert.equal(await js('document.querySelectorAll("[role=alert]").length'), 0);
    writeFileSync(join(logs, 'voice-ui.png'), (await window.webContents.capturePage()).toPNG());
    console.log('Companion voice UI: one Chinese capability notice, independent account dictation, PCM WAV conversion, and one draft insertion passed.');
    app.exit(0);
  } catch (error) { console.error(error); console.error(await js('document.body.innerText')); console.error(await js('JSON.stringify(window.__petVoiceFixture)')); app.exit(1); }
});
