'use strict';
// Development helper: runs a scripted sequence and saves screenshots.
// SK_SHOT=path/to/steps.json  →  [{ "js": "...", "wait": 600, "out": "file.png" }, ...]
const fs = require('fs');
const { app } = require('electron');

module.exports = (win) => {
  const steps = JSON.parse(fs.readFileSync(process.env.SK_SHOT, 'utf8'));
  win.webContents.on('console-message', (e) => {
    const m = e.message || '';
    if (/error|fail|uncaught/i.test(m)) console.log('[renderer]', m);
  });
  win.webContents.once('did-finish-load', async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(1500);
    for (const step of steps) {
      if (step.js) {
        try {
          const r = await win.webContents.executeJavaScript(step.js, true);
          if (r !== undefined) console.log('[js]', JSON.stringify(r).slice(0, 2000));
        } catch (err) { console.log('[js error]', err.message); }
      }
      await sleep(step.wait || 400);
      if (step.out) {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(step.out, img.toPNG());
        console.log('[shot]', step.out);
      }
    }
    app.exit(0);
  });
};
