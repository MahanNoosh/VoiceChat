const fs = require("fs");
const https = require("https");
const http = require("http");
const express = require("express");
const { Server } = require("socket.io");
const path = require("path");
const config = require("./config");

const app = express();
let server;

try {
  const options = {
    key: fs.readFileSync(config.ssl.key),
    cert: fs.readFileSync(config.ssl.cert),
  };
  server = https.createServer(options, app);
  console.log("✅ HTTPS server created");
} catch (e) {
  console.error("⚠️ Failed to load SSL certs, falling back to HTTP:", e.message);
  server = http.createServer(app);
}

const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(path.join(__dirname, "../frontend")));

io.on("connection", (socket) => {
  console.log("🔗 User connected:", socket.id);

  socket.on("join-room", ({ room, username }) => {
    socket.join(room);
    socket.room = room;
    socket.username = username || `guest-${Math.floor(Math.random() * 1000)}`;

    // Send list of existing peers (with usernames) to the joiner
    const roomSet = io.sockets.adapter.rooms.get(room) || new Set();
    const existing = [...roomSet]
      .filter((id) => id !== socket.id)
      .map((id) => {
        const s = io.sockets.sockets.get(id);
        return { id, username: (s && s.username) || id };
      });

    socket.emit("existing-peers", existing);

    // Notify others in room
    socket.to(room).emit("new-peer", { id: socket.id, username: socket.username });
  });

  socket.on("signal", ({ to, signal }) => {
    io.to(to).emit("signal", { from: socket.id, signal });
  });

  socket.on("disconnecting", () => {
    // Notify each room this socket was in
    for (const room of socket.rooms) {
      if (room !== socket.id) {
        socket.to(room).emit("peer-disconnect", socket.id);
      }
    }
  });
});

server.listen(config.port, () => {
  console.log(`🚀 Server running on port ${config.port}`);
});
