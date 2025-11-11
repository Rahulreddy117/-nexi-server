"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// index.ts
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const parse_server_1 = __importDefault(require("parse-server"));
const http_1 = __importDefault(require("http"));
const socket_io_1 = require("socket.io");
const config_1 = require("./config");
const app = (0, express_1.default)();
const server = http_1.default.createServer(app);
app.use((0, cors_1.default)({ origin: "*", credentials: true }));
const parseServer = new parse_server_1.default({
    databaseURI: config_1.config.databaseURI,
    appId: config_1.config.appId,
    masterKey: config_1.config.masterKey,
    serverURL: config_1.config.serverURL,
    allowClientClassCreation: config_1.config.allowClientClassCreation,
    maintenanceKey: config_1.config.maintenanceKey,
    enableInsecureAuthAdapters: false,
});
(async () => {
    try {
        const Parse = require("parse/node").Parse;
        const schema = new Parse.Schema("Message");
        schema.setCLP({
            get: { requiresAuthentication: true },
            find: { requiresAuthentication: true },
            create: { requiresAuthentication: true },
            update: { requiresAuthentication: true },
            delete: { requiresAuthentication: true },
            addField: { requiresAuthentication: true },
        });
        await schema.addString("senderId").addString("receiverId").addString("text").addDate("expiresAt");
        await schema.save();
        console.log("Message class ready");
    }
    catch (err) {
        if (err.code !== 100)
            console.error("Schema error:", err);
    }
})();
const io = new socket_io_1.Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
});
const onlineUsers = new Map();
io.on("connection", (socket) => {
    console.log("SOCKET CONNECTED:", socket.id);
    socket.on("join", (auth0Id) => {
        onlineUsers.set(auth0Id, socket.id);
        console.log(`JOIN: ${auth0Id} → ${socket.id}`);
        socket.emit("joined", { success: true });
    });
    socket.on("sendMessage", async (data) => {
        try {
            const Parse = require("parse/node").Parse;
            const Message = Parse.Object.extend("Message");
            const message = new Message();
            message.set("senderId", data.senderId);
            message.set("receiverId", data.receiverId);
            message.set("text", data.text);
            message.set("expiresAt", new Date(Date.now() + 24 * 60 * 60 * 1000));
            await message.save(null, { useMasterKey: true });
            const msgData = {
                text: data.text,
                senderId: data.senderId,
                createdAt: new Date().toISOString(),
            };
            const receiverId = onlineUsers.get(data.receiverId);
            if (receiverId) {
                io.to(receiverId).emit("newMessage", msgData);
                console.log(`DELIVERED to ${data.receiverId}`);
            }
            else {
                console.log(`${data.receiverId} is OFFLINE`);
            }
            socket.emit("messageSent", msgData);
        }
        catch (err) {
            console.error("Send error:", err);
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
(async () => {
    await parseServer.start();
    app.use("/parse", parseServer.app);
    const PORT = 1337;
    server.listen(PORT, () => {
        console.log(`Server: http://localhost:${PORT}/parse`);
        console.log(`Socket.IO READY: ws://localhost:${PORT}`);
    });
})();
//# sourceMappingURL=index.js.map