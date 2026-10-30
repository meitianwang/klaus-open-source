import { moduleValue } from '../assets/helper.mjs';

try {
  const data = await (await fetch('../assets/data.json')).json();
  await document.querySelector('#image').decode();
  let parentAccessible = false;
  try { void parent.document.body; parentAccessible = true; } catch {}
  const result = {
    inlineRan: window.inlineRan === true,
    moduleValue,
    dataValue: data.value,
    color: getComputedStyle(document.querySelector('#title')).color,
    imageWidth: document.querySelector('#image').naturalWidth,
    bridgeVisible: !!(window.__KLAUS_DESKTOP__ || window.klaus),
    requireVisible: typeof require !== 'undefined',
    parentAccessible,
  };
  document.querySelector('#result').textContent = JSON.stringify(result, null, 2);
} catch (error) {
  document.querySelector('#result').textContent = `Preview failed: ${String(error)}`;
}
