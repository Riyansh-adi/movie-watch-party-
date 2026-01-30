import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type RoomCode = string;

type Room = {
  code: RoomCode;
  hostSocketId: string;
  sockets: Set<string>;
  isPlaying: boolean;
  currentTime: number;
  lastUpdated: number;
};

const app = express();
app.use(cors());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: true,
    credentials: true,
  },
});

const rooms = new Map<RoomCode, Room>();

function randomRoomCode(): RoomCode {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function createUniqueRoomCode(): RoomCode {
  for (let i = 0; i < 20; i++) {
    const code = randomRoomCode();
    if (!rooms.has(code)) return code;
  }
  return `${Date.now().toString(36).toUpperCase().slice(-6)}`;
}

function emitRoomInfo(code: RoomCode) {
  const room = rooms.get(code);
  if (!room) return;

  io.to(code).emit("room:info", {
    code,
    hostSocketId: room.hostSocketId,
    usersCount: room.sockets.size,
  });
}

io.on("connection", (socket) => {
  // CREATE ROOM
  socket.on("room:create", () => {
    const code = createUniqueRoomCode();

    const room: Room = {
      code,
      hostSocketId: socket.id,
      sockets: new Set([socket.id]),
      isPlaying: false,
      currentTime: 0,
      lastUpdated: Date.now(),
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit("room:created", { code });
    emitRoomInfo(code);
  });

  // JOIN ROOM
  socket.on("room:join", ({ code }: { code: string }) => {
    const normalized = code.trim().toUpperCase();
    const room = rooms.get(normalized);

    if (!room) {
      socket.emit("room:error", { message: "Room not found" });
      return;
    }

    room.sockets.add(socket.id);
    socket.join(room.code);

    // 👉 NEW USER ko current video state bhejo
    socket.emit("sync:state", {
      currentTime: room.currentTime,
      isPlaying: room.isPlaying,
    });

    socket.emit("room:joined", { code: room.code });
    emitRoomInfo(room.code);
  });

  // PLAY / PAUSE / SEEK (ANY USER)
  socket.on(
    "sync:action",
    ({
      code,
      action,
      time,
    }: {
      code: string;
      action: "play" | "pause" | "seek";
      time: number;
    }) => {
      const room = rooms.get(code);
      if (!room) return;

      const now = Date.now();

      // agar video chal rahi thi to time update karo
      if (room.isPlaying) {
        room.currentTime += (now - room.lastUpdated) / 1000;
      }

      room.lastUpdated = now;

      if (action === "play") room.isPlaying = true;
      if (action === "pause") room.isPlaying = false;
      if (action === "seek") room.currentTime = time;

      io.to(code).emit("sync:action", {
        action,
        time: room.currentTime,
      });
    }
  );

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.sockets.has(socket.id)) continue;

      room.sockets.delete(socket.id);

      if (room.hostSocketId === socket.id) {
        io.to(code).emit("room:closed");
        rooms.delete(code);
        continue;
      }

      if (room.sockets.size === 0) {
        rooms.delete(code);
        continue;
      }

      emitRoomInfo(code);
    }
  });
});

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
