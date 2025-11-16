// index.ts
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
import { config } from "./config";
import { MongoClient } from "mongodb";

const app = express();
const server = http.createServer(app);
app.use(cors({ origin: "*", credentials: true }));

const parseServer = new ParseServer({
  databaseURI: config.databaseURI,
  appId: config.appId,
  masterKey: config.masterKey,
  serverURL: config.serverURL,
  allowClientClassCreation: config.allowClientClassCreation,
  maintenanceKey: config.maintenanceKey,
  enableInsecureAuthAdapters: false,
  cloud: __dirname + "/cloud.js", // ← REQUIRED
});

// -------------------------------------------------------------------
// 1. Message Class
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("Message");
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { "*": true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
    });
    await schema.addString("senderId").addString("receiverId").addString("text");
    await schema.save();
    console.log("Message class ready");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const db = client.db();
    await db.collection("Message").createIndexes([
      { key: { senderId: 1, createdAt: -1 } },
      { key: { receiverId: 1, createdAt: -1 } },
    ]);
    await client.close();
  } catch (err: any) {
    if (err.code !== 103) console.error("Message schema:", err);
  }
})();

// -------------------------------------------------------------------
// 2. _Follow Class
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("_Follow");
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
    });
    await schema.addPointer("follower", "_User").addPointer("following", "_User");
    await schema.save();
    console.log("_Follow class ready");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const db = client.db();
    await db.collection("_Follow").createIndexes([
      { key: { follower: 1, following: 1 }, unique: true },
      { key: { following: 1 } },
      { key: { follower: 1 } },
    ]);
    await client.close();
  } catch (err: any) {
    if (err.code !== 103) console.error("Follow schema:", err);
  }
})();

// -------------------------------------------------------------------
// 3. Add counters to _User (NO default)
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("_User");
    // Just add fields — default 0 will be handled by Parse
    await schema.addNumber("followingCount");
    await schema.addNumber("followersCount");
    await schema.save();
    console.log("_User counters added");
  } catch (err: any) {
    if (err.code !== 103) console.error("User schema:", err);
  }
})();

// -------------------------------------------------------------------
// 4. Cloud Functions (IN index.ts)
// -------------------------------------------------------------------
Parse.Cloud.define("followUser", async (req) => {
  const { myAuth0Id, targetAuth0Id } = req.params;
  if (!myAuth0Id || !targetAuth0Id) throw "Missing IDs";
  if (myAuth0Id === targetAuth0Id) throw "Cannot follow self";

  const [me, target] = await Promise.all([
    new Parse.Query("_User").equalTo("auth0Id", myAuth0Id).first({ useMasterKey: true }),
    new Parse.Query("_User").equalTo("auth0Id", targetAuth0Id).first({ useMasterKey: true }),
  ]);

  if (!me || !target) throw "User not found";

  const exist = await new Parse.Query("_Follow")
    .equalTo("follower", me)
    .equalTo("following", target)
    .first({ useMasterKey: true });
  if (exist) throw "Already following";

  const f = new Parse.Object("_Follow");
  f.set("follower", me);
  f.set("following", target);

  me.increment("followingCount");
  target.increment("followersCount"); // ← CORRECT

  await Parse.Object.saveAll([f, me, target], { useMasterKey: true });
  return { success: true };
});

Parse.Cloud.define("unfollowUser", async (req) => {
  const { myAuth0Id, targetAuth0Id } = req.params;
  if (!myAuth0Id || !targetAuth0Id) throw "Missing IDs";

  const [me, target] = await Promise.all([
    new Parse.Query("_User").equalTo("auth0Id", myAuth0Id).first({ useMasterKey: true }),
    new Parse.Query("_User").equalTo("auth0Id", targetAuth0Id).first({ useMasterKey: true }),
  ]);

  if (!me || !target) throw "User not found";

  const follow = await new Parse.Query("_Follow")
    .equalTo("follower", me)
    .equalTo("following", target)
    .first({ useMasterKey: true });
  if (!follow) throw "Not following";

  me.increment("followingCount", -1);
  target.increment("followersCount", -1); // ← CORRECT

  await Parse.Object.saveAll([me, target], { useMasterKey: true });
  await follow.destroy({ useMasterKey: true });
  return { success: true };
});

// -------------------------------------------------------------------
// 5. Socket.IO
// -------------------------------------------------------------------
const io = new Server(server, { cors: { origin: "*" } });
const onlineUsers = new Map<string, string>();

io.on("connection", (socket: Socket) => {
  socket.on("join", (auth0Id: string) => {
    onlineUsers.set(auth0Id, socket.id);
    socket.emit("joined", { success: true });
  });

  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      const receiver = await new Parse.Query("UserProfile")
        .equalTo("auth0Id", data.receiverId)
        .first({ useMasterKey: true });
      if (!receiver) return socket.emit("sendError", { error: "User not found" });

      const Message = Parse.Object.extend("Message");
      const message = new Message();
      message.set("senderId", data.senderId);
      message.set("receiverId", data.receiverId);
      message.set("text", data.text);
      const saved = await message.save(null, { useMasterKey: true });

      const payload = {
        objectId: saved.id,
        text: data.text,
        senderId: data.senderId,
        receiverId: data.receiverId,
        createdAt: saved.get("createdAt").toISOString(),
      };

      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("newMessage", payload);
      socket.emit("messageSent", payload);
    } catch (err: any) {
      socket.emit("sendError", { error: err.message });
    }
  });

  socket.on("disconnect", () => {
    for (const [id, sid] of onlineUsers.entries()) {
      if (sid === socket.id) onlineUsers.delete(id);
    }
  });
});

// -------------------------------------------------------------------
// 6. Start Server
// -------------------------------------------------------------------
(async () => {
  await parseServer.start();
  app.use("/parse", parseServer.app);
  const PORT = process.env.PORT || 1337;
  server.listen(PORT, () => {
    console.log(`Server: http://localhost:${PORT}/parse`);
  });
})();