// index.ts
const express = require("express");
const cors = require("cors");
const { ParseServer } = require("parse-server");
const { config } = require("./config");

const app = express();

app.use(cors({
  origin: ['*'],
  credentials: true,
}));

const parseServer = new ParseServer({
  databaseURI: config.databaseURI,
  appId: config.appId,
  masterKey: config.masterKey,
  serverURL: config.serverURL,
  allowClientClassCreation: config.allowClientClassCreation,
  maintenanceKey: config.maintenanceKey,
  enableInsecureAuthAdapters: false,
});

(async () => {
  try {
    await parseServer.start();
    console.log('Parse Server started successfully');
    app.use("/parse", parseServer.app);
    const PORT = process.env.PORT || 1337;
    app.listen(PORT, () => {
      console.log(`Parse Server running on http://localhost:${PORT}/parse (local) or https://nexi-server.onrender.com/parse (Render)`);
    });
  } catch (error) {
    console.error('Failed to start Parse Server:', error);
    process.exit(1);
  }
})();