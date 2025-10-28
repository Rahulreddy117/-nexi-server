"use strict";
const express = require("express");
const cors = require("cors");
const { ParseServer } = require("parse-server");
const { config } = require("./config");
const app = express();
// Enable CORS for client requests (e.g., React Native)
app.use(cors({
    origin: ['*'], // Allow all for testing; restrict to your app's domain in production
    credentials: true,
}));
// ✅ Create Parse Server instance (removed cloud option to avoid missing file error)
const parseServer = new ParseServer({
    databaseURI: config.databaseURI, // MongoDB URI
    appId: config.appId, // Your app ID
    masterKey: config.masterKey, // Your master key
    serverURL: config.serverURL, // Your Render URL (with /parse)
    // cloud: config.cloud,                       // Commented out: Missing cloud/main.js causes crash
    allowClientClassCreation: config.allowClientClassCreation,
    maintenanceKey: config.maintenanceKey,
    enableInsecureAuthAdapters: false, // Suppress insecure adapter warnings (if not needed)
});
// ✅ Start Parse Server asynchronously (fixes "Invalid server state: Initialized")
(async () => {
    try {
        // Critical: Await start() to fully initialize (required in Parse Server v4+)
        await parseServer.start();
        console.log('✅ Parse Server started successfully');
        // ✅ Mount Parse API at /parse AFTER start()
        app.use("/parse", parseServer.app);
        // ✅ Use Render's dynamic port
        const PORT = process.env.PORT || 1337;
        app.listen(PORT, () => {
            console.log(`✅ Parse Server running on http://localhost:${PORT}/parse (local) or https://nexi-server.onrender.com/parse (Render)`);
        });
    }
    catch (error) {
        console.error('❌ Failed to start Parse Server:', error);
        process.exit(1); // Exit on failure so Render retries
    }
})();
