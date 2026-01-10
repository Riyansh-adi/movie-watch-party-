import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type RoomCode = string;

type Room = {
  code: RoomCode;
  hostSocketId: string;
  sockets: Set<string>;
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
  // Extremely unlikely; fallback to timestamp-based.
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
  socket.on("room:create", () => {
    const code = createUniqueRoomCode();
    const room: Room = {
      code,
      hostSocketId: socket.id,
      sockets: new Set([socket.id]),
    };

    rooms.set(code, room);
    socket.join(code);

    socket.emit("room:created", { code });
    emitRoomInfo(code);
  });

  socket.on("room:join", ({ code }: { code: string }) => {
    const normalized = code.trim().toUpperCase();
    const room = rooms.get(normalized);

    if (!room) {
      socket.emit("room:error", { message: "Room not found" });
      return;
    }

    room.sockets.add(socket.id);
    socket.join(room.code);

    socket.emit("room:joined", { code: room.code });
    emitRoomInfo(room.code);
  });

  socket.on(
    "sync:action",
    ({ code, action, time }: { code: string; action: "play" | "pause" | "seek"; time: number }) => {
      const room = rooms.get(code);
      if (!room) return;
      if (socket.id !== room.hostSocketId) return;

      socket.to(code).emit("sync:action", { action, time });
    }
  );

  socket.on(
    "sync:status",
    ({ code, currentTime, isPlaying }: { code: string; currentTime: number; isPlaying: boolean }) => {
      const room = rooms.get(code);
      if (!room) return;
      if (socket.id !== room.hostSocketId) return;

      socket.to(code).emit("sync:status", { currentTime, isPlaying });
    }
  );

  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.sockets.has(socket.id)) continue;

      room.sockets.delete(socket.id);

      if (room.hostSocketId === socket.id) {
        // Simplest rule: if host leaves, close the room.
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
  // eslint-disable-next-line no-console
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
