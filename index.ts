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
(async () => {
  try {
    const schema = new Parse.Schema("Message");
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
      .addString("text")
      .addDate("expiresAt");
    await schema.save();
    console.log("Message class ensured");
  } catch (err: any) {
    if (err.code !== 100) {
      console.error("Schema error:", err);
    } else {
      console.log("Message class already exists");
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

  socket.on(
    "sendMessage",
    async (data: { senderId: string; receiverId: string; text: string }) => {
      try {
        const Message = Parse.Object.extend("Message");
        const message = new Message();

        message.set("senderId", data.senderId);
        message.set("receiverId", data.receiverId);
        message.set("text", data.text);
        message.set("expiresAt", new Date(Date.now() + 24 * 60 * 60 * 1000));

        const savedMessage = await message.save(null, { useMasterKey: true });

        // ← SEND REAL objectId + createdAt
        const msgPayload = {
          objectId: savedMessage.id,
          text: data.text,
          senderId: data.senderId,
          createdAt: savedMessage.get("createdAt").toISOString(),
        };

        // Deliver to receiver if online
        const receiverSocketId = onlineUsers.get(data.receiverId);
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("newMessage", msgPayload);
          console.log(`DELIVERED to ${data.receiverId}`);
        } else {
          console.log(`${data.receiverId} is OFFLINE`);
        }

        // Confirm to sender
        socket.emit("messageSent", msgPayload);
      } catch (err: any) {
        console.error("Send error:", err);
        socket.emit("sendError", { error: err.message || "Failed to send" });
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