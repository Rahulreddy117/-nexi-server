// backend/index.ts
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
import admin from "firebase-admin";
import { config } from "./config";
import { MongoClient } from "mongodb";

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*", credentials: true }));

// -------------------------------------------------------------------
// 1. Initialize Firebase Admin SDK (once)
// -------------------------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID!,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL!,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n")!,
    }),
  });
  console.log("Firebase Admin initialized");
}

// -------------------------------------------------------------------
// 2. Parse Server
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
// 3. Ensure Message class + Indexes
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
    console.log("Message class ready");

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
      console.warn("Index warning (ok):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class already exists");
    } else {
      console.error("Schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 4. Socket.IO — Real-time chat
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

  // -----------------------------------------------------------------
  // 5. SEND MESSAGE + FCM
  // -----------------------------------------------------------------
  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      // 1. Get receiver
      const receiverQuery = new Parse.Query("UserProfile");
      receiverQuery.equalTo("auth0Id", data.receiverId);
      const receiver = await receiverQuery.first({ useMasterKey: true });
      if (!receiver) {
        socket.emit("sendError", { error: "User not found" });
        return;
      }

      // 2. Get sender
      const senderQuery = new Parse.Query("UserProfile");
      senderQuery.equalTo("auth0Id", data.senderId);
      const sender = await senderQuery.first({ useMasterKey: true });

      const senderName = sender?.get("username") || sender?.get("name") || "Someone";
      const senderPic = sender?.get("profilePicUrl") || "";

      // 3. Save message
      const Message = Parse.Object.extend("Message");
      const message = new Message();
      message.set("senderId", data.senderId);
      message.set("receiverId", data.receiverId);
      message.set("text", data.text);
      const saved = await message.save(null, { useMasterKey: true });

      // 4. Payload
      const payload = {
        objectId: saved.id,
        text: data.text,
        senderId: data.senderId,
        receiverId: data.receiverId,
        createdAt: saved.get("createdAt")!.toISOString(),
        senderName,
        senderPic,
      };

      // 5. Socket.IO (if receiver online)
      const receiverSocketId = onlineUsers.get(data.receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", payload);
        console.log(`Socket delivered to ${data.receiverId}`);
      }

      // 6. FCM (if receiver offline or app closed)
      const fcmToken = receiver.get("fcmToken");
      if (fcmToken) {
        try {
          await admin.messaging().send({
            token: fcmToken,
            data: {
              receiverId: data.senderId,
              receiverName: senderName,
              receiverPic: senderPic,
              message: data.text,
            },
            android: {
              priority: "high",
            },
            apns: {
              payload: {
                aps: {
                  contentAvailable: true,
                },
              },
            },
          });
          console.log(`FCM sent to ${data.receiverId}`);
        } catch (fcmErr: any) {
          if (fcmErr.code === "messaging/registration-token-not-registered") {
            receiver.unset("fcmToken");
            await receiver.save(null, { useMasterKey: true });
            console.log("Invalid FCM token removed");
          } else {
            console.warn("FCM error:", fcmErr.message);
          }
        }
      }

      // 7. Confirm to sender
      socket.emit("messageSent", payload);

    } catch (err: any) {
      console.error("sendMessage error:", err);
      socket.emit("sendError", { error: err.message || "Failed to send" });
    }
  });

  // -----------------------------------------------------------------
  // 6. DISCONNECT
  // -----------------------------------------------------------------
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
// 7. Start server
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
      console.log(`FCM Push + Real-time Chat = WORKING`);
    });
  } catch (error) {
    console.error("Server failed:", error);
    process.exit(1);
  }
})();
