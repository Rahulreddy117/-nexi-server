const express = require("express");
const cors = require("cors");
const { ParseServer } = require("parse-server");
const Parse = require("parse/node");  // ✅ import Parse SDK
const { config } = require("./config");

const app = express();

// Enable CORS
app.use(cors({
  origin: ['*'],
  credentials: true,
}));

// Parse Server instance
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
    console.log('✅ Parse Server started successfully');
    app.use("/parse", parseServer.app);

    const PORT = process.env.PORT || 1337;
    app.listen(PORT, () => {
      console.log(`✅ Parse Server running on ${config.serverURL}`);
    });

    // ---------- TEMPORARY: Reset location field ----------
    Parse.initialize(config.appId, undefined, config.masterKey);
    Parse.serverURL = config.serverURL;

    const resetUserLocations = async () => {
      const query = new Parse.Query("UserProfile");
      query.limit(1000); // adjust if more users
      try {
        const users = await query.find({ useMasterKey: true });
        console.log(`Found ${users.length} users. Resetting location field...`);
        for (const user of users) {
          user.unset("location"); // remove old field
          await user.save(null, { useMasterKey: true });
        }
        console.log("✅ Location field reset. Next update will recreate GeoPoints.");
      } catch (err) {
        console.error("❌ Error resetting location field:", err);
      }
    };

    // Run once
    resetUserLocations();

  } catch (error) {
    console.error('❌ Failed to start Parse Server:', error);
    process.exit(1);
  }
})();
