'use strict';
const fs = require('node:fs');
const { createApp } = require('./app');
const dataDir = process.env.DATA_DIR || './data';
fs.mkdirSync(dataDir, { recursive: true });
const app = createApp({ dbFile: `${dataDir}/flagship.db` });
const port = Number(process.env.PORT || 3000);
app.server.listen(port, () => console.log(`Flagship is running on http://localhost:${port}`));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { app.close(); process.exit(0); });
