// index.ts
import express from "express";
import cors from "cors";
import ParseServer from "parse-server";
import http from "http";
import { Server, Socket } from "socket.io";
import Parse from "parse/node";
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

/* ------------------------------------------------------------------
   AUTO-CREATE Message CLASS (with read field)
   ------------------------------------------------------------------ */
/* ------------------------------------------------------------------
   AUTO-CREATE Message CLASS (with safe read-field handling)
   ------------------------------------------------------------------ */
(async () => {
  try {
    const schema = new Parse.Schema("Message");

    // CLP
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { "*": true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    // Define the fields we *always* want
    await schema
      .addString("senderId")
      .addString("receiverId")
      .addString("text")
      .addDate("expiresAt")
      .addBoolean("read");               // <-- NEW

    await schema.save();
    console.log("Message class created with 'read' field");
  } catch (err: any) {
    if (err.code === 103) {
      // Class already exists – try to add the field **only if it’s missing**
      console.log("Message class exists – checking for 'read' field");

      try {
        const existing = await new Parse.Schema("Message").get();
        const fields = existing.fields as Record<string, any>;

        if (!fields.read) {
          // Field missing → add it manually via a cloud-code style update
          const Message = Parse.Object.extend("Message");
          const dummy = new Message();
          dummy.set("read", false);
          await dummy.save(null, { useMasterKey: true });
          console.log("'read' field added to existing Message class");
        } else {
          console.log("'read' field already present");
        }
      } catch (e) {
        console.warn("Could not verify/add 'read' field (non-critical):", e);
      }

      // Re-apply CLP (optional but safe)
      try {
        const schema = new Parse.Schema("Message");
        schema.setCLP({ /* same CLP as above */ });
        await schema.update();
        console.log("CLP refreshed");
      } catch {}
    } else {
      console.error("Schema error:", err);
    }
  }
})();

/* ------------------------------------------------------------------
   SOCKET.IO
   ------------------------------------------------------------------ */
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

const onlineUsers = new Map<string, string>(); // auth0Id → socket.id

io.on("connection", (socket: Socket) => {
  console.log("SOCKET CONNECTED:", socket.id);

  /* ---------- JOIN ---------- */
  socket.on("join", (auth0Id: string) => {
    onlineUsers.set(auth0Id, socket.id);
    console.log(`JOIN: ${auth0Id} → ${socket.id}`);
    socket.emit("joined", { success: true });
  });

  /* ---------- SEND MESSAGE ---------- */
  socket.on(
    "sendMessage",
    async (data: { senderId: string; receiverId: string; text: string }) => {
      try {
        // 1. Verify receiver exists
        const receiverQuery = new Parse.Query("_User");
        receiverQuery.equalTo("auth0Id", data.receiverId);
        const receiver = await receiverQuery.first({ useMasterKey: true });
        if (!receiver) {
          socket.emit("sendError", { error: "User not found" });
          return;
        }

        // 2. Create message
        const Message = Parse.Object.extend("Message");
        const message = new Message();

        message.set("senderId", data.senderId);
        message.set("receiverId", receiver.get("auth0Id"));
        message.set("text", data.text);
        message.set("expiresAt", new Date(Date.now() + 24 * 60 * 60 * 1000));
        message.set("read", false);               // NEW

        // 3. Save
        const savedMessage = await message.save(null, { useMasterKey: true });

        // 4. Payload
        const msgPayload = {
          objectId: savedMessage.id,
          text: data.text,
          senderId: data.senderId,
          createdAt: savedMessage.get("createdAt").toISOString(),
        };

        // 5. Deliver to receiver (if online)
        const receiverSocketId = onlineUsers.get(receiver.get("auth0Id"));
        if (receiverSocketId) {
          io.to(receiverSocketId).emit("newMessage", msgPayload);
          io.to(receiverSocketId).emit("refreshInbox");   // NEW
          
        }

        const senderSocketId = onlineUsers.get(data.senderId);
if (senderSocketId) {
  io.to(senderSocketId).emit('messageSent', msgPayload);
  io.to(senderSocketId).emit('refreshInbox'); // Refresh sender inbox
}

        // 6. Confirm to sender
        socket.emit("messageSent", msgPayload);
      } catch (err: any) {
        console.error("Send error:", err);
        socket.emit("sendError", { error: err.message || "Failed" });
      }
    }
  );

  /* ---------- MARK AS READ ---------- */
  socket.on(
    "markAsRead",
    async ({ senderId }: { senderId: string }) => {
      try {
        // Find the auth0Id of the socket that requested the mark
        const auth0Id = [...onlineUsers.entries()].find(
          ([, sid]) => sid === socket.id
        )?.[0];
        if (!auth0Id) return;

        const query = new Parse.Query("Message");
        query.equalTo("senderId", senderId);
        query.equalTo("receiverId", auth0Id);
        query.equalTo("read", false);

        const unread = await query.find({ useMasterKey: true });
        for (const m of unread) m.set("read", true);
        await Parse.Object.saveAll(unread, { useMasterKey: true });

        // Optional: tell the sender that the messages are now read
        const senderSocketId = onlineUsers.get(senderId);
        if (senderSocketId) {
          io.to(senderSocketId).emit("messagesRead", { readerId: auth0Id });
        }
      } catch (err) {
        console.error("markAsRead error:", err);
      }
    }
  );

  /* ---------- DISCONNECT ---------- */
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

/* ------------------------------------------------------------------
   START SERVER
   ------------------------------------------------------------------ */
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
