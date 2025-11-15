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
app.use(express.json());

// -------------------------------------------------------------------
// 1. Parse Server Setup
// -------------------------------------------------------------------
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
    if (err.code === 103) console.log("Message class exists");
    else console.error("Schema error:", err);
  }
})();

// -------------------------------------------------------------------
// 1.5 Ensure Vibe class (Follow system) — ONLY ONE BLOCK
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("Vibe");
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    await schema
      .addPointer("from", "UserProfile")
      .addPointer("to", "UserProfile")
      .addBoolean("active")
      .addIndex("idx_from_to", { from: 1, to: 1 });

    await schema.save();
    console.log("Vibe class created");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("Vibe");
      await collection.createIndex(
        { from: 1, to: 1 },
        { unique: true, background: true }
      );
      console.log("Vibe unique index created");
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) console.log("Vibe class exists");
    else console.error("Vibe schema error:", err);
  }
})();

// -------------------------------------------------------------------
// 2. Socket.IO — Real-time chat
// -------------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const onlineUsers = new Map<string, string>();

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
      if (!receiver) return socket.emit("sendError", { error: "User not found" });

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
      if (receiverSocketId) io.to(receiverSocketId).emit("newMessage", payload);
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
// 3. Start Parse Server + Mount Routes
// -------------------------------------------------------------------
(async () => {
  try {
    await parseServer.start();
    console.log("Parse Server started");

    // Mount Parse at /parse
    app.use("/parse", parseServer.app);

    // -------------------------------------------------------------------
    // 4. Vibe Routes (Follow/Unfollow + Count + Check)
    // -------------------------------------------------------------------

    // POST /vibe → Follow
    app.post("/vibe", async (req, res) => {
      try {
        const { fromAuth0Id, toAuth0Id } = req.body;
        if (!fromAuth0Id || !toAuth0Id) {
          return res.status(400).json({ error: "fromAuth0Id and toAuth0Id required" });
        }

        const [fromUser, toUser] = await Promise.all([
          new Parse.Query("UserProfile").equalTo("auth0Id", fromAuth0Id).first({ useMasterKey: true }),
          new Parse.Query("UserProfile").equalTo("auth0Id", toAuth0Id).first({ useMasterKey: true }),
        ]);

        if (!fromUser || !toUser) {
          return res.status(404).json({ error: "User not found" });
        }

        const Vibe = Parse.Object.extend("Vibe");
        const vibe = new Vibe();
        vibe.set("from", fromUser);
        vibe.set("to", toUser);
        vibe.set("active", true);

        await vibe.save(null, { useMasterKey: true });
        res.json({ success: true, action: "vibed" });
      } catch (err: any) {
        if (err.code === 137) {
          res.json({ success: true, action: "already_vibed" });
        } else {
          console.error("Vibe error:", err);
          res.status(500).json({ error: err.message });
        }
      }
    });

    // DELETE /vibe → Unfollow
    app.delete("/vibe", async (req, res) => {
      try {
        const { fromAuth0Id, toAuth0Id } = req.body;
        if (!fromAuth0Id || !toAuth0Id) {
          return res.status(400).json({ error: "fromAuth0Id and toAuth0Id required" });
        }

        const [fromUser, toUser] = await Promise.all([
          new Parse.Query("UserProfile").equalTo("auth0Id", fromAuth0Id).first({ useMasterKey: true }),
          new Parse.Query("UserProfile").equalTo("auth0Id", toAuth0Id).first({ useMasterKey: true }),
        ]);

        if (!fromUser || !toUser) {
          return res.status(404).json({ error: "User not found" });
        }

        const vibeQuery = new Parse.Query("Vibe");
        vibeQuery.equalTo("from", fromUser);
        vibeQuery.equalTo("to", toUser);
        const vibe = await vibeQuery.first({ useMasterKey: true });

        if (vibe) {
          await vibe.destroy({ useMasterKey: true });
          res.json({ success: true, action: "unvibed" });
        } else {
          res.json({ success: true, action: "not_vibed" });
        }
      } catch (err: any) {
        console.error("Unvibe error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /vibes/count?userId=xxx
    app.get("/vibes/count", async (req, res) => {
      try {
        const { userId } = req.query;
        if (!userId || typeof userId !== "string") {
          return res.status(400).json({ error: "userId required" });
        }

        const user = await new Parse.Query("UserProfile")
          .equalTo("auth0Id", userId)
          .first({ useMasterKey: true });
        if (!user) return res.status(404).json({ error: "User not found" });

        const count = await new Parse.Query("Vibe")
          .equalTo("from", user)
          .equalTo("active", true)
          .count({ useMasterKey: true });

        res.json({ count });
      } catch (err: any) {
        console.error("Vibes count error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // GET /vibes/check?from=xxx&to=yyy
    app.get("/vibes/check", async (req, res) => {
      try {
        const { from, to } = req.query;
        if (!from || !to) {
          return res.status(400).json({ error: "from and to required" });
        }

        const [fromUser, toUser] = await Promise.all([
          new Parse.Query("UserProfile").equalTo("auth0Id", from as string).first({ useMasterKey: true }),
          new Parse.Query("UserProfile").equalTo("auth0Id", to as string).first({ useMasterKey: true }),
        ]);

        if (!fromUser || !toUser) {
          return res.status(404).json({ error: "User not found" });
        }

        const vibe = await new Parse.Query("Vibe")
          .equalTo("from", fromUser)
          .equalTo("to", toUser)
          .first({ useMasterKey: true });

        res.json({ isVibed: !!vibe });
      } catch (err: any) {
        console.error("Vibe check error:", err);
        res.status(500).json({ error: err.message });
      }
    });

    // -------------------------------------------------------------------
    // 5. Start HTTP + Socket.IO Server
    // -------------------------------------------------------------------
    const PORT = process.env.PORT || 1337;
    server.listen(PORT, () => {
      console.log(`Server running on: http://localhost:${PORT}`);
      console.log(`Parse: http://localhost:${PORT}/parse`);
      console.log(`Socket.IO: ws://localhost:${PORT}`);
      console.log(`Vibe API: /vibe, /vibes/count, /vibes/check`);
    });
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
})();
