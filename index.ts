const express = require("express");
const { ParseServer } = require("parse-server");
const { config } = require("./config");

const app = express();

// ✅ Create Parse Server instance
const parseServer = new ParseServer({
  databaseURI: config.databaseURI,              // MongoDB URI
  appId: config.appId,                          // Your app ID
  masterKey: config.masterKey,                  // Your master key
  serverURL: config.serverURL,                  // Your Render URL (with /parse)
  cloud: config.cloud,                          // Optional cloud code path
  allowClientClassCreation: config.allowClientClassCreation,
  maintenanceKey: config.maintenanceKey,
});

// ✅ Mount Parse API at /parse
app.use("/parse", parseServer.app);

// ✅ Use Render's dynamic port
const PORT = process.env.PORT || 1337;

app.listen(PORT, () => {
  console.log(`✅ Parse Server running on https://nexi-server.onrender.com/parse`);
});
