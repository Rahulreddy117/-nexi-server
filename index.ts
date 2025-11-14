import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
import admin from "firebase-admin";
import { config } from "./config";

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
  } catch (err: any) {
    if (err.code !== 103) console.error("Schema error:", err);
  }
})();

// FCM Admin Init
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const onlineUsers = new Map<string, string>();

io.on("connection", (socket: Socket) => {
  socket.on("join", (auth0Id: string) => {
    onlineUsers.set(auth0Id, socket.id);
  });

  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      const receiverQuery = new Parse.Query("UserProfile");
      receiverQuery.equalTo("auth0Id", data.receiverId);
      const receiver = await receiverQuery.first({ useMasterKey: true });
      if (!receiver) return socket.emit("sendError", { error: "User not found" });

      const senderQuery = new Parse.Query("UserProfile");
      senderQuery.equalTo("auth0Id", data.senderId);
      const senderProfile = await senderQuery.first({ useMasterKey: true });

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
        senderName: senderProfile?.get("username") || "User",
        receiverId: data.receiverId,
        createdAt: saved.get("createdAt")!.toISOString(),
      };

      // Socket (online)
      const receiverSocketId = onlineUsers.get(data.receiverId);
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", payload);
      }

      // FCM (background/killed)
      const fcmToken = receiver.get("fcmToken");
      if (fcmToken) {
        try {
          await admin.messaging().send({
            token: fcmToken,
            notification: {
              title: senderProfile?.get("username") || "New Message",
              body: data.text,
            },
            data: {
              receiverId: data.senderId,
              receiverName: senderProfile?.get("username") || "",
              receiverPic: senderProfile?.get("profilePicUrl") || "",
            },
            android: {
              priority: "high",
              notification: { sound: "default", clickAction: "FLUTTER_NOTIFICATION_CLICK" },
            },
          });
        } catch (fcmErr: any) {
          if (fcmErr.code === 'messaging/registration-token-not-registered') {
            receiver.unset("fcmToken");
            await receiver.save(null, { useMasterKey: true });
          }
        }
      }

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

(async () => {
  await parseServer.start();
  app.use("/parse", parseServer.app);
  const PORT = process.env.PORT || 1337;
  server.listen(PORT, () => {
    console.log(`Server running on ${PORT}`);
  });
})();