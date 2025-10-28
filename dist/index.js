"use strict";
const express = require("express");
const { ParseServer } = require("parse-server");
const { config } = require("./config");
const app = express();
const parseServer = new ParseServer({
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
