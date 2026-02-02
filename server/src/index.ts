import express from "express";
import http from "http";
import cors from "cors";
import { Server } from "socket.io";

type RoomCode = string;

type PlaybackActionType = "play" | "pause" | "seek" | "rate";

type ClientReport = {
  timeSeconds: number;
  isPlaying: boolean;
  playbackRate: number;
  receivedAtMs: number;
  lastCorrectedAtMs: number;
};

type PlaybackState = {
  isPlaying: boolean;
  positionSeconds: number;
  playbackRate: number;
  updatedAtMs: number;
  seq: number;
};

type Room = {
  code: RoomCode;
  hostSocketId: string;
  sockets: Set<string>;
  playback: PlaybackState;
  reports: Map<string, ClientReport>;
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

const SYNC_TOLERANCE_SECONDS = 0.25;
const HARD_SEEK_THRESHOLD_SECONDS = 2.0;
const REPORT_STALE_MS = 4000;
const CORRECT_COOLDOWN_MS = 800;

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

function getPlaybackSnapshot(room: Room, nowMs: number) {
  const elapsedSeconds = room.playback.isPlaying
    ? ((nowMs - room.playback.updatedAtMs) / 1000) * room.playback.playbackRate
    : 0;
  const positionSeconds = Math.max(0, room.playback.positionSeconds + elapsedSeconds);
  return {
    isPlaying: room.playback.isPlaying,
    positionSeconds,
    playbackRate: room.playback.playbackRate,
    seq: room.playback.seq,
    serverTimeMs: nowMs,
  };
}

function applyPlaybackAction(room: Room, nowMs: number, action: { type: PlaybackActionType; timeSeconds?: number }) {
  // First, advance the room clock to "now" so our state is continuous.
  const current = getPlaybackSnapshot(room, nowMs);
  room.playback.positionSeconds = current.positionSeconds;
  room.playback.updatedAtMs = nowMs;

  const timeSeconds = Number.isFinite(action.timeSeconds) ? Math.max(0, action.timeSeconds as number) : undefined;

  if (action.type === "seek") {
    if (timeSeconds !== undefined) room.playback.positionSeconds = timeSeconds;
  }

  if (action.type === "rate") {
    // Uses timeSeconds to carry the desired playbackRate.
    if (timeSeconds !== undefined) {
      room.playback.playbackRate = Math.min(2, Math.max(0.5, timeSeconds));
    }
  }

  if (action.type === "play") {
    if (timeSeconds !== undefined) room.playback.positionSeconds = timeSeconds;
    room.playback.isPlaying = true;
  }

  if (action.type === "pause") {
    if (timeSeconds !== undefined) room.playback.positionSeconds = timeSeconds;
    room.playback.isPlaying = false;
  }

  room.playback.seq += 1;
}

function emitPlaybackState(code: RoomCode, payload: { by: string; action: PlaybackActionType | "state" }) {
  const room = rooms.get(code);
  if (!room) return;

  const nowMs = Date.now();
  const snapshot = getPlaybackSnapshot(room, nowMs);
  io.to(code).emit("playback:state", {
    ...snapshot,
    by: payload.by,
    action: payload.action,
  });
}

function computeClientPositionAtNow(report: ClientReport, nowMs: number) {
  const ageSeconds = Math.max(0, (nowMs - report.receivedAtMs) / 1000);
  const adv = report.isPlaying ? ageSeconds * report.playbackRate : 0;
  return Math.max(0, report.timeSeconds + adv);
}

function getRoomSyncStatus(room: Room, nowMs: number) {
  const snapshot = getPlaybackSnapshot(room, nowMs);

  let worstAbsDriftSeconds = 0;
  let allHaveFreshReports = true;
  const drifts: Array<{ socketId: string; driftSeconds: number; abs: number }> = [];

  for (const socketId of room.sockets) {
    const report = room.reports.get(socketId);
    if (!report || nowMs - report.receivedAtMs > REPORT_STALE_MS) {
      allHaveFreshReports = false;
      continue;
    }

    const clientPos = computeClientPositionAtNow(report, nowMs);
    const driftSeconds = clientPos - snapshot.positionSeconds;
    const abs = Math.abs(driftSeconds);
    worstAbsDriftSeconds = Math.max(worstAbsDriftSeconds, abs);
    drifts.push({ socketId, driftSeconds, abs });
  }

  const isSynced = allHaveFreshReports && drifts.every((d) => d.abs <= SYNC_TOLERANCE_SECONDS);
  return { snapshot, isSynced, worstAbsDriftSeconds, allHaveFreshReports, drifts };
}

function emitRoomSyncIndicator(code: RoomCode, payload: { isSynced: boolean; worstAbsDriftSeconds: number }) {
  io.to(code).emit("room:sync", {
    isSynced: payload.isSynced,
    worstAbsDriftSeconds: payload.worstAbsDriftSeconds,
    toleranceSeconds: SYNC_TOLERANCE_SECONDS,
    serverTimeMs: Date.now(),
  });
}

io.on("connection", (socket) => {
  // CREATE ROOM
  socket.on("room:create", (cb?: (payload: { code: string }) => void) => {
    const code = createUniqueRoomCode();

    const room: Room = {
      code,
      hostSocketId: socket.id,
      sockets: new Set([socket.id]),
      playback: {
        isPlaying: false,
        positionSeconds: 0,
        playbackRate: 1,
        updatedAtMs: Date.now(),
        seq: 0,
      },
      reports: new Map(),
    };

    rooms.set(code, room);
    socket.join(code);

    if (cb) cb({ code });
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

    // Send current playback snapshot to the new user (late join + reconnect).
    socket.emit("playback:state", {
      ...getPlaybackSnapshot(room, Date.now()),
      by: socket.id,
      action: "state",
    });

    socket.emit("room:joined", { code: room.code });
    emitRoomInfo(room.code);
  });

  // PLAYBACK ACTION (ANY USER)
  socket.on(
    "playback:action",
    ({ code, type, timeSeconds }: { code: string; type: PlaybackActionType; timeSeconds?: number }) => {
      const normalized = code.trim().toUpperCase();
      const room = rooms.get(normalized);
      if (!room) return;

      // Only accept actions from sockets that are in the room.
      if (!room.sockets.has(socket.id)) return;

      const nowMs = Date.now();
      applyPlaybackAction(room, nowMs, { type, timeSeconds });
      emitPlaybackState(room.code, { by: socket.id, action: type });
    }
  );

  // PLAYBACK STATE REQUEST (ANY USER)
  socket.on(
    "playback:request",
    (
      { code }: { code: string },
      cb?: (state: { isPlaying: boolean; positionSeconds: number; playbackRate: number; seq: number; serverTimeMs: number }) => void
    ) => {
      const normalized = code.trim().toUpperCase();
      const room = rooms.get(normalized);
      if (!room) return;

      const snapshot = getPlaybackSnapshot(room, Date.now());
      if (cb) {
        cb(snapshot);
        return;
      }

      socket.emit("playback:state", {
        ...snapshot,
        by: socket.id,
        action: "state",
      });
    }
  );

  // CLIENT REPORT (PERIODIC) - enables server-side verification.
  socket.on(
    "playback:report",
    ({
      code,
      timeSeconds,
      isPlaying,
      playbackRate,
    }: {
      code: string;
      timeSeconds: number;
      isPlaying: boolean;
      playbackRate: number;
    }) => {
      const normalized = code.trim().toUpperCase();
      const room = rooms.get(normalized);
      if (!room) return;
      if (!room.sockets.has(socket.id)) return;

      const nowMs = Date.now();
      room.reports.set(socket.id, {
        timeSeconds: Number.isFinite(timeSeconds) ? Math.max(0, timeSeconds) : 0,
        isPlaying: !!isPlaying,
        playbackRate: Number.isFinite(playbackRate) ? Math.min(2, Math.max(0.5, playbackRate)) : 1,
        receivedAtMs: nowMs,
        lastCorrectedAtMs: room.reports.get(socket.id)?.lastCorrectedAtMs ?? 0,
      });
    }
  );

  // DISCONNECT
  socket.on("disconnect", () => {
    for (const [code, room] of rooms) {
      if (!room.sockets.has(socket.id)) continue;

      room.sockets.delete(socket.id);
      room.reports.delete(socket.id);

      if (room.hostSocketId === socket.id) {
        const nextHost = room.sockets.values().next().value as string | undefined;
        if (!nextHost) {
          rooms.delete(code);
          continue;
        }
        room.hostSocketId = nextHost;
        emitRoomInfo(code);
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

// Periodic verification + sync indicator + targeted corrections.
setInterval(() => {
  const nowMs = Date.now();

  for (const [code, room] of rooms) {
    const { snapshot, isSynced, worstAbsDriftSeconds, drifts, allHaveFreshReports } = getRoomSyncStatus(room, nowMs);

    // Server-driven indicator: green only when everyone is within tolerance.
    emitRoomSyncIndicator(code, { isSynced, worstAbsDriftSeconds });

    // If we don't have all reports, don't try to correct aggressively.
    if (!allHaveFreshReports) continue;

    for (const drift of drifts) {
      const report = room.reports.get(drift.socketId);
      if (!report) continue;

      // Also correct mismatched play/pause/rate even if time is close.
      const stateMismatch = report.isPlaying !== snapshot.isPlaying || Math.abs(report.playbackRate - snapshot.playbackRate) > 0.001;
      const needsCorrection = drift.abs > SYNC_TOLERANCE_SECONDS || stateMismatch;
      if (!needsCorrection) continue;

      if (nowMs - report.lastCorrectedAtMs < CORRECT_COOLDOWN_MS) continue;

      report.lastCorrectedAtMs = nowMs;
      room.reports.set(drift.socketId, report);

      const mode = drift.abs >= HARD_SEEK_THRESHOLD_SECONDS ? "hard" : "soft";

      io.to(drift.socketId).emit("playback:correct", {
        code,
        targetTimeSeconds: snapshot.positionSeconds,
        isPlaying: snapshot.isPlaying,
        playbackRate: snapshot.playbackRate,
        seq: snapshot.seq,
        serverTimeMs: snapshot.serverTimeMs,
        mode,
        toleranceSeconds: SYNC_TOLERANCE_SECONDS,
      });
    }
  }
}, 500);

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
server.listen(PORT, () => {
  console.log(`Socket server listening on http://localhost:${PORT}`);
});
