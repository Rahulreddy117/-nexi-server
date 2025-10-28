"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.config = void 0;
exports.config = {
    databaseURI: "mongodb://localhost:27017/nexi",
    appId: "myAppId",
    masterKey: "myMasterKey",
    serverURL: "http://localhost:1337/parse",
    cloud: "./cloud/main.js",
    allowClientClassCreation: true,
    maintenanceKey: "default-maintenance-key",
};
