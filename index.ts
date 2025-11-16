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
app.use(express.json()); // For parsing POST bodies in /follow route

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
// Custom /follow route (no Cloud Code needed) - Call this from your app's follow button instead of direct Parse REST
// -------------------------------------------------------------------
app.post('/follow', async (req, res) => {
  const { followerId, followingId } = req.body;
  if (!followerId || !followingId) {
    return res.status(400).json({ error: 'Missing followerId or followingId' });
  }
  if (followerId === followingId) {
    return res.status(400).json({ error: 'Cannot follow yourself' });
  }
  try {
    // Check if already following
    const Follow = Parse.Object.extend("Follow");
    const followQuery = new Parse.Query(Follow);
    followQuery.equalTo("followerId", followerId);
    followQuery.equalTo("followingId", followingId);
    const existingFollow = await followQuery.first({ useMasterKey: true });
    if (existingFollow) {
      return res.json({ success: true, alreadyFollowing: true });
    }

    // Create follow
    const follow = new Follow();
    follow.set("followerId", followerId);
    follow.set("followingId", followingId);
    await follow.save(null, { useMasterKey: true });

    // Update follower's followingCount (with safeguard against negative)
    const followerQuery = new Parse.Query("UserProfile");
    followerQuery.equalTo("auth0Id", followerId);
    const followerProfile = await followerQuery.first({ useMasterKey: true });
    if (followerProfile) {
      const currentFollowing = followerProfile.get("followingCount") || 0;
      followerProfile.set("followingCount", Math.max(0, currentFollowing + 1));
      await followerProfile.save(null, { useMasterKey: true });
      console.log(`Updated followingCount for ${followerId}: ${currentFollowing} -> ${followerProfile.get("followingCount")}`);
    }

    // Update following's followersCount (with safeguard against negative)
    const followingQuery = new Parse.Query("UserProfile");
    followingQuery.equalTo("auth0Id", followingId);
    const followingProfile = await followingQuery.first({ useMasterKey: true });
    if (followingProfile) {
      const currentFollowers = followingProfile.get("followersCount") || 0;
      followingProfile.set("followersCount", Math.max(0, currentFollowers + 1));
      await followingProfile.save(null, { useMasterKey: true });
      console.log(`Updated followersCount for ${followingId}: ${currentFollowers} -> ${followingProfile.get("followersCount")}`);
    }

    // Create notification only if it doesn't exist
    const Notif = Parse.Object.extend("FollowNotification");
    const notifQuery = new Parse.Query(Notif);
    notifQuery.equalTo("followerId", followerId);
    notifQuery.equalTo("followedId", followingId);
    const existingNotif = await notifQuery.first({ useMasterKey: true });

    let newNotificationCreated = false;
    if (!existingNotif) {
      const notification = new Notif();
      notification.set("followerId", followerId);
      notification.set("followedId", followingId);
      notification.set("read", false);
      if (followerProfile) {
        notification.set("followerProfile", {
          __type: "Pointer",
          className: "UserProfile",
          objectId: followerProfile.id,
        });
      }
      await notification.save(null, { useMasterKey: true });
      newNotificationCreated = true;
    }

    // Emit real-time update to followed user (for badge increment)
    const followedSocketId = onlineUsers.get(followingId);
    if (followedSocketId && newNotificationCreated) {
      io.to(followedSocketId).emit("newUnreadNotification");
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error("Follow error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// Optional: /unfollow route (similar logic, deletes follow and notification)
// -------------------------------------------------------------------
app.post('/unfollow', async (req, res) => {
  const { followerId, followingId } = req.body;
  if (!followerId || !followingId) {
    return res.status(400).json({ error: 'Missing followerId or followingId' });
  }
  if (followerId === followingId) {
    return res.status(400).json({ error: 'Cannot unfollow yourself' });
  }
  try {
    // Find and delete follow
    const Follow = Parse.Object.extend("Follow");
    const followQuery = new Parse.Query(Follow);
    followQuery.equalTo("followerId", followerId);
    followQuery.equalTo("followingId", followingId);
    const existingFollow = await followQuery.first({ useMasterKey: true });
    if (!existingFollow) {
      return res.json({ success: true, notFollowing: true });
    }
    await existingFollow.destroy({ useMasterKey: true });

    // Decrement follower's followingCount (with safeguard against negative)
    const followerQuery = new Parse.Query("UserProfile");
    followerQuery.equalTo("auth0Id", followerId);
    const followerProfile = await followerQuery.first({ useMasterKey: true });
    if (followerProfile) {
      const currentFollowing = followerProfile.get("followingCount") || 0;
      const newFollowing = Math.max(0, currentFollowing - 1);
      followerProfile.set("followingCount", newFollowing);
      await followerProfile.save(null, { useMasterKey: true });
      console.log(`Updated followingCount for ${followerId}: ${currentFollowing} -> ${newFollowing}`);
    }

    // Decrement following's followersCount (with safeguard against negative)
    const followingQuery = new Parse.Query("UserProfile");
    followingQuery.equalTo("auth0Id", followingId);
    const followingProfile = await followingQuery.first({ useMasterKey: true });
    if (followingProfile) {
      const currentFollowers = followingProfile.get("followersCount") || 0;
      const newFollowers = Math.max(0, currentFollowers - 1);
      followingProfile.set("followersCount", newFollowers);
      await followingProfile.save(null, { useMasterKey: true });
      console.log(`Updated followersCount for ${followingId}: ${currentFollowers} -> ${newFollowers}`);
    }

    // Delete notification (if unread, emit decrement to followed)
    const Notif = Parse.Object.extend("FollowNotification");
    const notifQuery = new Parse.Query(Notif);
    notifQuery.equalTo("followerId", followerId);
    notifQuery.equalTo("followedId", followingId);
    const existingNotif = await notifQuery.first({ useMasterKey: true });
    let wasUnread = false;
    if (existingNotif) {
      wasUnread = !existingNotif.get("read");
      await existingNotif.destroy({ useMasterKey: true });
    }

    // Emit decrement if it was unread (use a separate event for clarity)
    const followedSocketId = onlineUsers.get(followingId);
    if (followedSocketId && wasUnread) {
      io.to(followedSocketId).emit("unreadNotificationRemoved");
    }

    res.json({ success: true });
  } catch (err: any) {
    console.error("Unfollow error:", err);
    res.status(500).json({ error: err.message });
  }
});

// -------------------------------------------------------------------
// One-time migration to fix negative counts (run once, then comment out)
// -------------------------------------------------------------------
(async () => {
  try {
    console.log("Running one-time migration to fix negative counts...");
    const UserProfileQuery = new Parse.Query("UserProfile");
    const profiles = await UserProfileQuery.find({ useMasterKey: true });
    let fixed = 0;
    for (const profile of profiles) {
      let changed = false;
      const followers = profile.get("followersCount");
      if (followers !== undefined && followers < 0) {
        profile.set("followersCount", 0);
        changed = true;
      }
      const following = profile.get("followingCount");
      if (following !== undefined && following < 0) {
        profile.set("followingCount", 0);
        changed = true;
      }
      if (changed) {
        await profile.save(null, { useMasterKey: true });
        fixed++;
      }
    }
    console.log(`Migration complete: Fixed ${fixed} profiles with negative counts.`);
  } catch (err: any) {
    console.error("Migration error:", err);
  }
})();

// -------------------------------------------------------------------
// 5. Socket.IO — Real-time chat + follow notifications
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
// 6. Start server
// -------------------------------------------------------------------
(async () => {
  try {
    await parseServer.start();
    console.log("Parse Server started");
    app.use("/parse", parseServer.app); // Custom routes like /follow are before this
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