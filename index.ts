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
});

// -------------------------------------------------------------------
// 1. Ensure Message class + CLP + Indexes (NO expiresAt)
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
      addField: { requiresAuthentication: true },
    });

    await schema
      .addString("senderId")
      .addString("receiverId")
      .addString("text");

    await schema.save();
    console.log("Message class created (no TTL)");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("Message");

      await collection.createIndexes([
        { key: { senderId: 1, createdAt: -1 }, background: true },
        { key: { receiverId: 1, createdAt: -1 }, background: true },
      ]);

      console.log("Message indexes created (fast $or queries)");
    } catch (err: any) {
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class exists");
    } else {
      console.error("Schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 2. _Follow Class + Indexes
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
    await schema.addPointer("follower", "_User")
                 .addPointer("following", "_User");
    await schema.save();
    console.log("_Follow class ready");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const db = client.db();
    await db.collection("_Follow").createIndexes([
      { key: { follower: 1, following: 1 }, unique: true },
      { key: { following: 1 } },
      { key: { follower: 1 } },
    ], { background: true });
    await client.close();
    console.log("_Follow indexes created");
  } catch (err: any) {
    if (err.code !== 103) console.error("Follow schema error:", err);
  }
})();

// -------------------------------------------------------------------
// 3. Cloud Functions: followUser / unfollowUser (using auth0Id)
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
  target.increment("followersCount");

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
  target.increment("followersCount", -1);

  await Parse.Object.saveAll([me, target], { useMasterKey: true });
  await follow.destroy({ useMasterKey: true });

  return { success: true };
});

// -------------------------------------------------------------------
// 4. Socket.IO — Real-time chat (UNCHANGED)
// -------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const onlineUsers = new Map<string, string>(); // auth0Id → socket.id

io.on("connection", (socket: Socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  socket.on("join", (auth0Id: string) => {
    onlineUsers.set(auth0Id, socket.id);
    console.log(`JOIN: ${auth0Id} → ${socket.id}`);
    socket.emit("joined", { success: true });
  });

  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      const receiverQuery = new Parse.Query("UserProfile");
      receiverQuery.equalTo("auth0Id", data.receiverId);
      const receiver = await receiverQuery.first({ useMasterKey: true });

      if (!receiver) {
        socket.emit("sendError", { error: "User not found" });
        return;
      }

      const Message = Parse.Object.extend("Message");
      const message = new Message();

      message.set("senderId", data.senderId);
      message.set("receiverId", receiver.get("auth0Id"));
      message.set("text", data.text);

      const saved = await message.save(null, { useMasterKey: true });

      const payload = {
        objectId: saved.id,
        text: data.text,
        senderId: data.senderId,
        receiverId: receiver.get("auth0Id"),
        createdAt: saved.get("createdAt")!.toISOString(),
      };

      const receiverSocketId = onlineUsers.get(receiver.get("auth0Id"));
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", payload);
      }
      socket.emit("messageSent", payload);
    } catch (err: any) {
      console.error("sendMessage error:", err);
      socket.emit("sendError", { error: err.message || "Failed" });
    }
  });

  socket.on("disconnect", () => {
    for (const [auth0Id, sid] of onlineUsers.entries()) {
      if (sid === socket.id) {
        onlineUsers.delete(auth0Id);
        console.log(`DISCONNECTED: ${auth0Id}`);
        break;
      }
    }
  });
});

// -------------------------------------------------------------------
// 5. Start server
// -------------------------------------------------------------------
(async () => {
  try {
    await parseServer.start();
    console.log("Parse Server started");

    app.use("/parse", parseServer.app);

    const PORT = process.env.PORT || 1337;
    server.listen(PORT, () => {
      console.log(`Server: http://localhost:${PORT}/parse`);
      console.log(`Socket.IO: ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server failed:", error);
    process.exit(1);
  }
})();
