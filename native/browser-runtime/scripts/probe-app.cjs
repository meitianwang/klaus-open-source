// The native probe owns initialization and termination. Keep the default app
// from creating a separate window or quitting before its result is written.
const { app } = require('electron');
app.on('window-all-closed', () => {});
