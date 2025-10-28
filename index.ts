// server/index.ts
import express from "express";
import { ParseServer } from "parse-server";
import { config } from "./config.js";

// ⛔️ Fix TypeScript complaining about `new ParseServer(...)`
const ParseServerClass: any = ParseServer as any;

const app = express();

const parseServer = new ParseServerClass({
  databaseURI: config.databaseURI,
  appId: config.appId,
  masterKey: config.masterKey,
  serverURL: config.serverURL,
  cloud: config.cloud,
  allowClientClassCreation: config.allowClientClassCreation,
  maintenanceKey: config.maintenanceKey,
});

app.use("/parse", parseServer.app);

app.listen(1337, () => {
  console.log("✅ Parse Server running on http://localhost:1337/parse");
});
