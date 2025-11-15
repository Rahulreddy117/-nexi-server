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

      console.log("Message indexes created");
    } catch (err: any) {
      console.warn("Index warning:", err.message);
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
// 2. FOLLOW / FOLLOWERS – _Follow class (NO CLOUD CODE)
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("_Follow");
    schema.setCLP({
      find: { "*": true },
      get: { "*": true },
      create: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
    });

    await schema
      .addString("fromAuth0Id")
      .addString("toAuth0Id");

    await schema.save();
    console.log("_Follow class created");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const col = client.db().collection("_Follow");
    await col.createIndexes([
      { key: { fromAuth0Id: 1 }, background: true },
      { key: { toAuth0Id: 1 }, background: true },
    ]);
    await client.close();
    console.log("_Follow indexes created");
  } catch (e: any) {
    if (e.code !== 103) console.error("_Follow schema error:", e);
  }
})();

// -------------------------------------------------------------------
// 3. Socket.IO — Real-time chat + follow
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

  // === SEND MESSAGE ===
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

  // === FOLLOW USER ===
  socket.on("followUser", async (data: { fromAuth0Id: string; toAuth0Id: string }) => {
    try {
      const { fromAuth0Id, toAuth0Id } = data;

      if (fromAuth0Id === toAuth0Id) {
        socket.emit("followError", { error: "Cannot follow yourself" });
        return;
      }

      const q = new Parse.Query("_Follow");
      q.equalTo("fromAuth0Id", fromAuth0Id);
      q.equalTo("toAuth0Id", toAuth0Id);
      const exists = await q.first({ useMasterKey: true });
      if (exists) {
        socket.emit("followError", { error: "Already following" });
        return;
      }

      const Follow = Parse.Object.extend("_Follow");
      const f = new Follow();
      f.set("fromAuth0Id", fromAuth0Id);
      f.set("toAuth0Id", toAuth0Id);
      await f.save(null, { useMasterKey: true });

      const payload = { fromAuth0Id, toAuth0Id, action: "follow" };
      const toSocket = onlineUsers.get(toAuth0Id);
      if (toSocket) io.to(toSocket).emit("followUpdate", payload);
      socket.emit("followSuccess", payload);
    } catch (err: any) {
      socket.emit("followError", { error: err.message });
    }
  });

  // === UNFOLLOW USER ===
  socket.on("unfollowUser", async (data: { fromAuth0Id: string; toAuth0Id: string }) => {
    try {
      const q = new Parse.Query("_Follow");
      q.equalTo("fromAuth0Id", data.fromAuth0Id);
      q.equalTo("toAuth0Id", data.toAuth0Id);
      const obj = await q.first({ useMasterKey: true });
      if (obj) await obj.destroy({ useMasterKey: true });

      const payload = { fromAuth0Id: data.fromAuth0Id, toAuth0Id: data.toAuth0Id, action: "unfollow" };
      const toSocket = onlineUsers.get(data.toAuth0Id);
      if (toSocket) io.to(toSocket).emit("followUpdate", payload);
      socket.emit("unfollowSuccess", payload);
    } catch (err: any) {
      socket.emit("followError", { error: err.message });
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
// 4. Start server
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
