// index.ts
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
import { config } from "./config";
import { MongoClient } from "mongodb"; // ← ADD THIS

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
// 3. Ensure Message class + CLP + MongoDB Indexes
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
      .addString("text")
      .addDate("expiresAt");

    await schema.save();
    console.log("Message class ensured with CLP");

    // -----------------------------------------------------------------
    // CREATE MONGODB INDEXES (fast $or queries)
    // -----------------------------------------------------------------
    const uri = config.databaseURI;
    const client = new MongoClient(uri);

    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("Message");

      await collection.createIndexes([
        { key: { senderId: 1 }, background: true },
        { key: { receiverId: 1 }, background: true },
        { key: { expiresAt: -1 }, background: true, expireAfterSeconds: 0 }, // TTL
        {
          key: { senderId: 1, receiverId: 1, createdAt: -1 },
          background: true,
        },
        {
          key: { receiverId: 1, senderId: 1, createdAt: -1 },
          background: true,
        },
      ]);

      console.log("MongoDB indexes created on Message");
    } catch (idxErr: any) {
      if (idxErr.codeName === "IndexOptionsConflict" || idxErr.code === 85) {
        console.log("Indexes already exist with same name but different options – skipping");
      } else {
        console.warn("Index creation warning (non-fatal):", idxErr.message);
      }
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class exists – skipping schema creation");
    } else {
      console.error("Schema setup error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 4. Socket.IO
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

  socket.on(
    "sendMessage",
    async (data: { senderId: string; receiverId: string; text: string }) => {
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
        message.set("expiresAt", new Date(Date.now() + 24 * 60 * 60 * 1000));

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
    }
  );

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
// 5. Start Server
// -------------------------------------------------------------------
(async () => {
  try {
    await parseServer.start();
    console.log("Parse Server started");

    app.use("/parse", parseServer.app);

    const PORT = process.env.PORT || 1337;
    server.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}/parse`);
      console.log(`Socket.IO ready on ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
})();
