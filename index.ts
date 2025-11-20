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
// 1. Ensure UserProfile class + CLP + Indexes
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("UserProfile");

    schema.setCLP({
      get: { "*": true },
      find: { "*": true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    await schema
      .addString("auth0Id")
      .addString("email")
      .addString("username")
      .addString("name")
      .addString("bio")
      .addString("profilePicUrl")
      .addString("height")
      .addNumber("followersCount", { defaultValue: 0 })
      .addNumber("followingCount", { defaultValue: 0 });

    await schema.save();
    console.log("UserProfile class updated");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("UserProfile");

      await collection.createIndexes([
        { key: { auth0Id: 1 }, unique: true, background: true },
      ]);
      console.log("UserProfile indexes created");
    } catch (err: any) {
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("UserProfile class exists");
    } else {
      console.error("UserProfile schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 2. Ensure Follow class + CLP + Indexes
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("Follow");

    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { "*": true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    await schema.addString("followerId").addString("followingId");

    await schema.save();
    console.log("Follow class created");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("Follow");

      await collection.createIndexes([
        { key: { followerId: 1, followingId: 1 }, unique: true, background: true },
        { key: { followerId: 1 }, background: true },
        { key: { followingId: 1 }, background: true },
      ]);
      console.log("Follow indexes created");
    } catch (err: any) {
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("Follow class exists");
    } else {
      console.error("Follow schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 3. Ensure Message class + CLP + Indexes (NO expiresAt)
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
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class exists");
    } else {
      console.error("Message schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 4. Ensure FollowNotification class + CLP + Indexes
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("FollowNotification");

    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    await schema
      .addString("followerId")
      .addString("followedId")
      .addPointer("followerProfile", "UserProfile")
      .addBoolean("read", { defaultValue: false });

    await schema.save();
    console.log("FollowNotification class created");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("FollowNotification");

      await collection.createIndexes([
        { key: { followedId: 1, createdAt: -1 }, background: true },
        { key: { read: 1 }, background: true },
        { key: { followerId: 1, followedId: 1 }, unique: true, background: true },
      ]);
      console.log("FollowNotification indexes created");
    } catch (err: any) {
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("FollowNotification class exists");
    } else {
      console.error("FollowNotification schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// NEW: 5. Ensure MessageNotification class + CLP + Indexes
// -------------------------------------------------------------------
(async () => {
  try {
    const schema = new Parse.Schema("MessageNotification");

    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    await schema
      .addString("senderId")
      .addString("receiverId")
      .addPointer("message", "Message") // Pointer to actual message
      .addPointer("senderProfile", "UserProfile") // For quick username/pic in notifications
      .addBoolean("read", { defaultValue: false });

    await schema.save();
    console.log("MessageNotification class created");

    const client = new MongoClient(config.databaseURI);
    try {
      await client.connect();
      const db = client.db();
      const collection = db.collection("MessageNotification");

      await collection.createIndexes([
        { key: { receiverId: 1, createdAt: -1 }, background: true },
        { key: { read: 1 }, background: true },
        { key: { senderId: 1, receiverId: 1 }, unique: true, background: true }, // Prevent duplicates
      ]);
      console.log("MessageNotification indexes created");
    } catch (err: any) {
      console.warn("Index warning (safe to ignore):", err.message);
    } finally {
      await client.close();
    }
  } catch (err: any) {
    if (err.code === 103) {
      console.log("MessageNotification class exists");
    } else {
      console.error("MessageNotification schema error:", err);
    }
  }
})();

// -------------------------------------------------------------------
// 6. Socket.IO — Real-time chat + notifications
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

      // Save the actual message
      // Inside socket.on("sendMessage", async (data) => { ... })

// Save the actual message
const Message = Parse.Object.extend("Message");
const message = new Message();
message.set("senderId", data.senderId);
message.set("receiverId", receiver.get("auth0Id"));
message.set("text", data.text);
const savedMessage = await message.save(null, { useMasterKey: true });

// Create notification for receiver
const MessageNotification = Parse.Object.extend("MessageNotification");
const notification = new MessageNotification();
notification.set("senderId", data.senderId);
notification.set("receiverId", receiver.get("auth0Id"));
notification.set("message", savedMessage);

// Fixed: Correct way to set pointer
if (data.senderId) {
  const senderProfile = new Parse.Object("UserProfile");
  const senderObjectId = await getProfileObjectId(data.senderId);
  if (senderObjectId) {
    senderProfile.id = senderObjectId;
    notification.set("senderProfile", senderProfile);
  }
}
notification.set("read", false);

await notification.save(null, { useMasterKey: true });

      await notification.save(null, { useMasterKey: true });

      const payload = {
        objectId: savedMessage.id,
        text: data.text,
        senderId: data.senderId,
        receiverId: receiver.get("auth0Id"),
        createdAt: savedMessage.get("createdAt")!.toISOString(),
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

  // NEW: Helper to get profile objectId from auth0Id (for notification)
  async function getProfileObjectId(auth0Id: string): Promise<string | null> {
    const query = new Parse.Query("UserProfile");
    query.equalTo("auth0Id", auth0Id);
    const profile = await query.first({ useMasterKey: true });
    return profile ? profile.id : null;
  }

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
      console.log(`Server: http://localhost:${PORT}/parse`);
      console.log(`Socket.IO: ws://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("Server failed:", error);
    process.exit(1);
  }
})();