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
      addField: { requiresAuthentication: true },
    });
    await schema.addString("senderId").addString("receiverId").addString("text");
    await schema.save();
    console.log("Message class ready");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const col = client.db().collection("Message");
    await col.createIndexes([
      { key: { senderId: 1, createdAt: -1 }, background: true },
      { key: { receiverId: 1, createdAt: -1 }, background: true },
    ]);
    await client.close();
  } catch (e: any) {
    if (e.code !== 103) console.error(e);
  }
})();

// -------------------------------------------------------------------
// 2. _Follow Class
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
    await schema.addString("fromAuth0Id").addString("toAuth0Id");
    await schema.save();
    console.log("_Follow class ready");

    const client = new MongoClient(config.databaseURI);
    await client.connect();
    const col = client.db().collection("_Follow");
    await col.createIndexes([
      { key: { fromAuth0Id: 1 }, background: true },
      { key: { toAuth0Id: 1 }, background: true },
    ]);
    await client.close();
  } catch (e: any) {
    if (e.code !== 103) console.error(e);
  }
})();

// -------------------------------------------------------------------
// 3. Socket.IO + Real-Time Follow Events
// -------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});
const onlineUsers = new Map<string, string>(); // auth0Id → socket.id

io.on("connection", (socket: Socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  // JOIN ROOM
  socket.on("join", (auth0Id: string) => {
    if (!auth0Id) return;
    console.log("USER JOINED ROOM:", auth0Id, "| Socket:", socket.id);
    onlineUsers.set(auth0Id, socket.id);
    socket.emit("joined", { success: true });
  });

  // --- CHAT ---
  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      const receiver = await new Parse.Query("UserProfile")
        .equalTo("auth0Id", data.receiverId)
        .first({ useMasterKey: true });
      if (!receiver) return socket.emit("sendError", { error: "User not found" });

      const Message = Parse.Object.extend("Message");
      const msg = new Message();
      msg.set("senderId", data.senderId);
      msg.set("receiverId", data.receiverId);
      msg.set("text", data.text);
      const saved = await msg.save(null, { useMasterKey: true });

      const payload = {
        objectId: saved.id,
        text: data.text,
        senderId: data.senderId,
        receiverId: data.receiverId,
        createdAt: saved.get("createdAt")!.toISOString(),
      };

      const receiverSocket = onlineUsers.get(data.receiverId);
      if (receiverSocket) io.to(receiverSocket).emit("newMessage", payload);
      socket.emit("messageSent", payload);
    } catch (err: any) {
      socket.emit("sendError", { error: err.message });
    }
  });

  // --- FOLLOW ---
  socket.on("followUser", async (data: { fromAuth0Id: string; toAuth0Id: string }) => {
    try {
      if (data.fromAuth0Id === data.toAuth0Id) throw new Error("Cannot follow self");

      const exists = await new Parse.Query("_Follow")
        .equalTo("fromAuth0Id", data.fromAuth0Id)
        .equalTo("toAuth0Id", data.toAuth0Id)
        .first({ useMasterKey: true });
      if (exists) throw new Error("Already following");

      const Follow = Parse.Object.extend("_Follow");
      const f = new Follow();
      f.set("fromAuth0Id", data.fromAuth0Id);
      f.set("toAuth0Id", data.toAuth0Id);
      await f.save(null, { useMasterKey: true });

      const payload = { ...data, action: "follow" };

      const fromSocket = onlineUsers.get(data.fromAuth0Id);
      const toSocket = onlineUsers.get(data.toAuth0Id);

      // SEND TO BOTH: followSuccess (for button) + followUpdate (for count)
      if (fromSocket) {
        io.to(fromSocket).emit("followSuccess", payload);
        io.to(fromSocket).emit("followUpdate", payload);
      }
      if (toSocket) {
        io.to(toSocket).emit("followUpdate", payload);
      }

      console.log("FOLLOW SUCCESS:", data.fromAuth0Id, "→", data.toAuth0Id);
    } catch (err: any) {
      console.error("Follow error:", err.message);
      socket.emit("followError", { error: err.message });
    }
  });

  // --- UNFOLLOW ---
  socket.on("unfollowUser", async (data: { fromAuth0Id: string; toAuth0Id: string }) => {
    try {
      const obj = await new Parse.Query("_Follow")
        .equalTo("fromAuth0Id", data.fromAuth0Id)
        .equalTo("toAuth0Id", data.toAuth0Id)
        .first({ useMasterKey: true });
      if (obj) await obj.destroy({ useMasterKey: true });

      const payload = { ...data, action: "unfollow" };

      const fromSocket = onlineUsers.get(data.fromAuth0Id);
      const toSocket = onlineUsers.get(data.toAuth0Id);

      if (fromSocket) {
        io.to(fromSocket).emit("unfollowSuccess", payload);
        io.to(fromSocket).emit("followUpdate", payload);
      }
      if (toSocket) {
        io.to(toSocket).emit("followUpdate", payload);
      }

      console.log("UNFOLLOW SUCCESS:", data.fromAuth0Id, "→", data.toAuth0Id);
    } catch (err: any) {
      console.error("Unfollow error:", err.message);
      socket.emit("followError", { error: err.message });
    }
  });

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const [auth0Id, sid] of onlineUsers.entries()) {
      if (sid === socket.id) {
        console.log("USER LEFT ROOM:", auth0Id);
        onlineUsers.delete(auth0Id);
        break;
      }
    }
  });
});

// -------------------------------------------------------------------
// 4. Cloud Function (Optional)
// -------------------------------------------------------------------
app.post("/functions/triggerSocket", async (req, res) => {
  try {
    const { event, data } = req.body;
    const fromSocket = onlineUsers.get(data.fromAuth0Id);
    const toSocket = onlineUsers.get(data.toAuth0Id);
    if (fromSocket) io.to(fromSocket).emit(event, data);
    if (toSocket) io.to(toSocket).emit(event, data);
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// 5. Start Server
// -------------------------------------------------------------------
(async () => {
  try {
    await parseServer.start();
    app.use("/parse", parseServer.app);
    const PORT = process.env.PORT || 1337;
    server.listen(PORT, () => {
      console.log(`Server running: http://localhost:${PORT}/parse`);
      console.log(`Socket.IO ready: ws://localhost:${PORT}`);
    });
  } catch (e) {
    console.error("Failed to start server:", e);
    process.exit(1);
  }
})();
