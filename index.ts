// index.ts (Backend) — FULL CODE
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
import { config } from "./config";
import { MongoClient } from "mongodb";
import admin from "firebase-admin";

const app = express();
const server = http.createServer(app);

app.use(cors({ origin: "*", credentials: true }));

// -------------------------------------------------------------------
// 1. Firebase Admin SDK
// -------------------------------------------------------------------
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: "nexi-a3a0c",
      clientEmail: "firebase-adminsdk-fbsvc@nexi-a3a0c.iam.gserviceaccount.com",
      privateKey: `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDOKH2QwsJ22Heu
k0w40JWC1wQSHNoymKNZH6zBQh+Ky5CpycMDZkNNWkPdrgEC1U0XDp8Pkux20GXJ
MlBt0FblKxotdcrYJufVavHeumRr5/ZIbn4vPI/93L2i6uE6hdGYHqyBE7NM4KGJ
DaKfc6Av4yFjo53fDk/QZ8A//uM79gZS49/BvNBO/CY+5mO7fWGFhYODHuCcW/Ib
5+PuVxcfRfjVx/WsdTonee/CmilZIZRF4cXMwTGLD8jWUUcH52qdtBwhFUPbFnZN
GomlMcdBNFUUsf35dzvlNpQ7IFMH1J/lFOBBVU7yAMo/xz8MWJ6YlQ4sMQCgFhEa
XT3NOjABAgMBAAECggEAB+TiBgCHLMDWOF+YjBZkmzl7hOwI6OYSXy/I0C+lgI2R
8QZySreIPTaHIb5veHnNdWQQcCq6lkQdmaotDT9sjGLtoi8AAO3gc7ogH9y4Sq97
rUNZ3potk1V4B3yB+lk0cOQ/y8OC2p9BYDue7gch66OBXEzgFzH3mW3XnTu33MxZ
0qXoCeXk+enmotvlafWdkFfPRC8rMQHQfpfvkjjHDu4/8+vXlM/jBEBhE8e34Czb
AsN2gQWdFX/axC45NsMGWsmaZin/AIx8j7uU8Mw7qF8bHCBYTLDZUQIZu4hfzuNv
20PMktfVh6A8K/f+0Hmqts8FZ3cp06jVjQaO/JotlwKBgQDl3kAEHbtei86GajK7
bRqCQiYBuuCf+AckYc6sY7HhXzNscEyUV/EYoIE0XxRrWS96sK2w/up8PBhykoJx
RHiaoHuS0PumWH/ztDUTu4s0yvuMxad/cVnY11aB6znuVoiNvFnx0192mr80Z6sL
/Y/73ZU0+m5YI29dOkaP6Xb+BwKBgQDlmDgQGE55/nW98vH1i1XqB5tTeB59A+qO
vmPfijOkQmmtybrh87Ws6bruEpizWbFntk8jZLP2VG4ablkfnzGx9zTYS1DwpUX1
zD60JwtdZ5tuKDrbDaJB3R8xT24WA6Wp7tKDQESpn45RuurmCppnnebiepcevL/g
03qZXmpftwKBgC6imHo9TfYwhwXeJczApdAne25+a3QI7eoDrdprn3sJxXUKk37F
GLTWW2A0qf/daDSMA7EVBp2N06fq8WvpaE52oJt4qpVk/xCCTwJh2iwrwj0dHI5O
gNvtVC+neWlRRQL8Y4McTxHQ81m+boVQPBXtLohBBoH7LmzLleU8iFehAoGBAJB0
T4HA6U9UTJxwiM/nFO0kUBQaVYRuvFuHaqsw9wD4UClp7U1Q2xOqE1TLGoxteHM6
f1xTde8cfBHhL+33aXsBgJw99vUR54yZLzKGBl6EW4TZhv5f+6DZEVEjGq57KPZc
LtMp0omuvAqsQjLupOtgq+3/F6ndNBSuukpY3zDNAoGAUC3iw44Q0HYZkmkFXk8B
b2VUR7OVQhMxS5Vn60hpZHF5pgwX2ZtVcs/c8WoiA8Jaq14VUIGh3dwh8YyrfejL
yE97vJLxPNcOWf0+LcVt1h+ynqSB/XyQ92XSOlAJj2nFF0GvHFc+kd3wHNWil1rw
eHbGHT/xcvHJ2VaUqELfkFc=
-----END PRIVATE KEY-----`.replace(/\\n/g, '\n'),
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
// 3. Schema & Indexes
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
    const db = client.db();
    await db.collection("Message").createIndexes([
      { key: { senderId: 1, createdAt: -1 }, background: true },
      { key: { receiverId: 1, createdAt: -1 }, background: true },
    ]);
    console.log("Indexes created");
    await client.close();
  } catch (err: any) {
    if (err.code !== 103) console.error("Schema error:", err);
  }
})();

// -------------------------------------------------------------------
// 4. Socket.IO + FCM
// -------------------------------------------------------------------
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
const onlineUsers = new Map<string, string>();

Parse.Cloud.define("saveFcmToken", async (request) => {
  const { userId, fcmToken } = request.params;
  if (!userId || !fcmToken) throw "Missing params";
  const user = await new Parse.Query("UserProfile").equalTo("auth0Id", userId).first({ useMasterKey: true });
  if (!user) throw "User not found";
  user.set("fcmToken", fcmToken);
  await user.save(null, { useMasterKey: true });
  return { success: true };
});

io.on("connection", (socket: Socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  socket.on("join", (auth0Id: string) => {
    onlineUsers.set(auth0Id, socket.id);
    console.log(`JOIN: ${auth0Id}`);
    socket.emit("joined", { success: true });
  });

  socket.on("sendMessage", async (data: { senderId: string; receiverId: string; text: string }) => {
    try {
      const receiver = await new Parse.Query("UserProfile").equalTo("auth0Id", data.receiverId).first({ useMasterKey: true });
      if (!receiver) return socket.emit("sendError", { error: "User not found" });

      const sender = await new Parse.Query("UserProfile").equalTo("auth0Id", data.senderId).first({ useMasterKey: true });
      const senderName = sender?.get("username") || "Someone";
      const senderPic = sender?.get("profilePicUrl") || "";

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

      // 1. Socket.IO (online)
      const receiverSocketId = onlineUsers.get(receiver.get("auth0Id"));
      if (receiverSocketId) {
        io.to(receiverSocketId).emit("newMessage", payload);
      }

      // 2. FCM DATA-ONLY (online or offline)
      const fcmToken = receiver.get("fcmToken");
      if (fcmToken) {
        console.log("SENDING FCM DATA TO:", fcmToken);
        try {
          await admin.messaging().send({
            token: fcmToken,
            data: {
              title: senderName,
              body: data.text,
              receiverId: receiver.get("auth0Id"),
              receiverName: senderName,
              receiverPic: senderPic,
              type: "chat",
            },
          });
          console.log("FCM DATA SENT");
        } catch (err: any) {
          console.error("FCM ERROR:", err.message);
          if (err.code === "messaging/registration-token-not-registered") {
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
      if (sid === socket.id) {
        onlineUsers.delete(id);
        console.log(`DISCONNECTED: ${id}`);
        break;
      }
    }
  });
});

// -------------------------------------------------------------------
// 5. Start Server
// -------------------------------------------------------------------
(async () => {
  await parseServer.start();
  console.log("Parse Server started");
  app.use("/parse", parseServer.app);
  const PORT = process.env.PORT || 1337;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
})();
