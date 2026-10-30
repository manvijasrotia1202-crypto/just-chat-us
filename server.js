const express = require("express");
const http = require("http");
const crypto = require("crypto");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 2 * 1024 * 1024, // Socket.IO payload ceiling: 2 MiB
  cors: { origin: false }
});

const PORT = Number(process.env.PORT) || 3000;
const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // fallback: room expires after 12 hours
const DISCONNECT_GRACE_MS = 15_000; // wait briefly for accidental reconnects
const MAX_MESSAGES = 100;
// Set these two values in Render Environment to keep one reusable room.
const FIXED_ROOM_ID = process.env.FIXED_ROOM_ID || "";
const FIXED_ROOM_TOKEN = process.env.FIXED_ROOM_TOKEN || "";
const MAX_TEXT_LENGTH = 2_000;
const MAX_PHOTO_BYTES = 1 * 1024 * 1024; // 1 MiB per photo
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), {
  etag: false,
  lastModified: false,
  maxAge: 0
}));

// All room state lives only in this process's RAM. Nothing is written to disk.
const rooms = new Map();
const socketRooms = new Map();

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function roomIsExpired(room) {
  return Date.now() >= room.expiresAt;
}

function clearRoom(roomId, reason = "Room closed") {
  const room = rooms.get(roomId);
  if (!room) return;

  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  if (room.expiryTimer) clearTimeout(room.expiryTimer);

  // Notify connected clients before dropping all references to in-memory content.
  io.to(roomId).emit("room:ended", { message: reason });
  for (const socketId of room.members.keys()) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket) {
      socket.leave(roomId);
      socketRooms.delete(socketId);
    }
  }
  room.messages.length = 0;
  room.members.clear();
  rooms.delete(roomId);
}

function scheduleEmptyRoomCleanup(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.members.size !== 0) return;
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = setTimeout(() => {
    const current = rooms.get(roomId);
    if (current && current.members.size === 0) {
      clearRoom(roomId, "Both people left. This room has been erased.");
    }
  }, DISCONNECT_GRACE_MS);
  room.cleanupTimer.unref?.();
}

function makeRoom(roomId = randomToken(9), joinCode = randomToken(24)) {
  const room = {
    id: roomId,
    joinCode,
    createdAt: Date.now(),
    expiresAt: Date.now() + ROOM_TTL_MS,
    members: new Map(),
    messages: [],
    cleanupTimer: null,
    expiryTimer: null
  };
  room.expiryTimer = setTimeout(() => {
    clearRoom(roomId, "This room expired and its contents were erased.");
  }, ROOM_TTL_MS);
  room.expiryTimer.unref?.();
  rooms.set(roomId, room);
  return room;
}

function publicMessage(message) {
  // Return only metadata and ciphertext. No plaintext content exists on the server.
  return {
    id: message.id,
    senderId: message.senderId,
    senderName: message.senderName,
    createdAt: message.createdAt,
    iv: message.iv,
    ciphertext: message.ciphertext
  };
}

function roomForSocket(socket) {
  const roomId = socketRooms.get(socket.id);
  if (!roomId) return null;
  const room = rooms.get(roomId);
  if (!room || roomIsExpired(room)) {
    if (room) clearRoom(roomId, "This room expired and its contents were erased.");
    return null;
  }
  return room;
}

io.on("connection", (socket) => {
  socket.on("room:create", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const name = String(payload?.name || "").trim().slice(0, 32);
    if (!name) return reply({ ok: false, error: "Enter a display name first." });
    if (socketRooms.has(socket.id)) return reply({ ok: false, error: "You're already in a room." });

    let room;
    if (FIXED_ROOM_ID && FIXED_ROOM_TOKEN) {
      room = rooms.get(FIXED_ROOM_ID);
      if (room && roomIsExpired(room)) {
        clearRoom(FIXED_ROOM_ID, "This room expired and its contents were erased.");
        room = null;
      }
      if (!room) room = makeRoom(FIXED_ROOM_ID, FIXED_ROOM_TOKEN);
      if (room.members.size >= 2) return reply({ ok: false, error: "This room already has two people." });
      if (room.cleanupTimer) {
        clearTimeout(room.cleanupTimer);
        room.cleanupTimer = null;
      }
    } else {
      room = makeRoom();
    }
    room.members.set(socket.id, { name, joinedAt: Date.now() });
    socketRooms.set(socket.id, room.id);
    socket.join(room.id);

    reply({
      ok: true,
      roomId: room.id,
      inviteToken: room.joinCode,
      expiresAt: room.expiresAt,
      memberCount: room.members.size,
      messages: []
    });
  });

  socket.on("room:join", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const roomId = String(payload?.roomId || "");
    const inviteToken = String(payload?.inviteToken || "");
    const name = String(payload?.name || "").trim().slice(0, 32);

    if (!name) return reply({ ok: false, error: "Enter a display name first." });
    if (socketRooms.has(socket.id)) return reply({ ok: false, error: "You're already in a room." });

    let room = rooms.get(roomId);
    if (room && roomIsExpired(room)) {
      clearRoom(roomId, "This room expired and its contents were erased.");
      room = null;
    }
    // Re-create the same empty room after its temporary contents are erased or
    // the free hosting instance restarts. The fixed invitation remains valid.
    if (!room && FIXED_ROOM_ID && FIXED_ROOM_TOKEN &&
        roomId === FIXED_ROOM_ID && safeEqual(inviteToken, FIXED_ROOM_TOKEN)) {
      room = makeRoom(FIXED_ROOM_ID, FIXED_ROOM_TOKEN);
    }
    if (!room) {
      return reply({ ok: false, error: "That room doesn't exist anymore. Check your permanent invitation link." });
    }
    if (!safeEqual(inviteToken, room.joinCode)) {
      return reply({ ok: false, error: "That invitation link is invalid." });
    }
    if (room.members.size >= 2) return reply({ ok: false, error: "This room already has two people." });

    if (room.cleanupTimer) {
      clearTimeout(room.cleanupTimer);
      room.cleanupTimer = null;
    }

    room.members.set(socket.id, { name, joinedAt: Date.now() });
    socketRooms.set(socket.id, room.id);
    socket.join(room.id);

    reply({
      ok: true,
      roomId: room.id,
      expiresAt: room.expiresAt,
      memberCount: room.members.size,
      messages: room.messages.map(publicMessage)
    });
    io.to(room.id).emit("room:members", { count: room.members.size });
    socket.to(room.id).emit("room:notice", { text: `${name} joined the room.` });
  });

  socket.on("message:send", (payload, callback) => {
    const reply = typeof callback === "function" ? callback : () => {};
    const room = roomForSocket(socket);
    if (!room) return reply({ ok: false, error: "You're no longer in a live room." });

    const member = room.members.get(socket.id);
    if (!member) return reply({ ok: false, error: "You're not a member of this room." });

    // The server deliberately accepts only opaque ciphertext. It never receives
    // plaintext text/photo/reply fields and cannot inspect encrypted message content.
    const id = typeof payload?.id === "string" && /^[A-Za-z0-9_-]{12,80}$/.test(payload.id)
      ? payload.id : null;
    const iv = typeof payload?.iv === "string" && /^[A-Za-z0-9_-]{16,32}$/.test(payload.iv)
      ? payload.iv : null;
    const ciphertext = typeof payload?.ciphertext === "string" ? payload.ciphertext : "";
    const createdAt = Number(payload?.createdAt);

    if (!id || !iv || !ciphertext || ciphertext.length > 1_500_000 ||
        !Number.isFinite(createdAt) || Math.abs(Date.now() - createdAt) > 5 * 60 * 1000) {
      return reply({ ok: false, error: "Invalid encrypted message." });
    }
    if (room.messages.some((m) => m.id === id)) {
      return reply({ ok: false, error: "That message ID already exists." });
    }

    const message = {
      id,
      senderId: socket.id,
      senderName: member.name,
      createdAt,
      iv,
      ciphertext
    };

    room.messages.push(message);
    while (room.messages.length > MAX_MESSAGES) room.messages.shift();

    io.to(room.id).emit("message:new", message);
    reply({ ok: true, id: message.id });
  });

  socket.on("disconnect", () => {
    const roomId = socketRooms.get(socket.id);
    socketRooms.delete(socket.id);
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    room.members.delete(socket.id);
    io.to(roomId).emit("room:members", { count: room.members.size });
    if (room.members.size === 0) {
      scheduleEmptyRoomCleanup(roomId);
    }
  });
});

app.get("/health", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({ ok: true, rooms: rooms.size });
});

app.get("/{*path}", (_req, res) => {
  res.set("Cache-Control", "no-store");
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Just Us chat is running on port ${PORT}`);
});
