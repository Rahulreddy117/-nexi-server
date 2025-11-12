// index.ts
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";  // ← IMPORT ONCE HERE
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

// AUTO-CREATE Message CLASS
// AUTO-CREATE Message CLASS (OPTIMIZED)
(async () => {
  try {
    const schema = new Parse.Schema("Message");

    // Set CLP first
    schema.setCLP({

      
      get: { requiresAuthentication: true },
      find: { "*": true },  // this for removing sesson token      
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
});

    // Define fields
    await schema
      .addString("senderId")
      .addString("receiverId")
      .addString("text")
      .addDate("expiresAt");

    // Save (creates if not exists)
    await schema.save();
    console.log("Message class ensured with CLP");

  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class already exists");
      // Optionally force-update CLP
      try {
        const schema = new Parse.Schema("Message");
        schema.setCLP({ /* same CLP */ });
        await schema.update();
        console.log("CLP updated");
      } catch {}
    } else {
      console.error("Schema error:", err);
    }
  }
})();

// SOCKET.IO SETUP
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
    // 1. Find receiver by auth0Id
    const receiverQuery = new Parse.Query("UserProfile");
    receiverQuery.equalTo("auth0Id", data.receiverId);
    const receiver = await receiverQuery.first({ useMasterKey: true });

    if (!receiver) {
      socket.emit("sendError", { error: "User not found" });
      return;
    }

    // 2. Create message with AUTH0 IDs
    const Message = Parse.Object.extend("Message");
    const message = new Message();

    message.set("senderId", data.senderId);                    // ← Auth0 ID
    message.set("receiverId", receiver.get("auth0Id"));        // ← Auth0 ID
    message.set("text", data.text);
    message.set("expiresAt", new Date(Date.now() + 24 * 60 * 60 * 1000));

    // 3. Save ONCE
    const savedMessage = await message.save(null, { useMasterKey: true });

    // 4. Send payload
    const msgPayload = {
      objectId: savedMessage.id,
      text: data.text,
      senderId: data.senderId,
      createdAt: savedMessage.get("createdAt").toISOString(),
    };

    // 5. Deliver
    const receiverSocketId = onlineUsers.get(receiver.get("auth0Id"));
    if (receiverSocketId) {
      io.to(receiverSocketId).emit("newMessage", msgPayload);
    }
    socket.emit("messageSent", msgPayload);

  } catch (err: any) {
    console.error("Send error:", err);
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

// START SERVER
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
