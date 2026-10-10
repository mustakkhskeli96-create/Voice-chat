const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const MAX_USERS = 9;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OFFICIAL_ROOM = "ROKO_OFFICIAL";

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Ro_ko Voice Chat server is running");
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
let nextId = 1;

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data, except = null) {
    if (!room) return;
    for (const user of room.users) {
        if (user.ws !== except) send(user.ws, data);
    }
}

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, {
            users: [],
            hostId: null,
            official: roomId === OFFICIAL_ROOM,
            requests: new Set(),
            speakers: new Set()
        });
    }
    return rooms.get(roomId);
}

function findUser(room, id) {
    return room.users.find(user => user.id === String(id));
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || ""));
    const y = Buffer.from(String(b || ""));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function isAdmin(ws) {
    return ws.isAdmin === true;
}

wss.on("connection", ws => {
    ws.id = String(nextId++);
    ws.room = null;
    ws.name = "User";
    ws.role = "user";
    ws.isAdmin = false;

    ws.on("message", raw => {
        let data;
        try {
            data = JSON.parse(raw.toString());
        } catch (_) {
            return;
        }

        // Admin password verification
        if (data.type === "admin_login") {
            if (!ADMIN_PASSWORD) {
                send(ws, { type: "admin_login_result", ok: false,
                    text: "Admin password is not configured on server" });
                return;
            }

            if (safeEqual(data.password, ADMIN_PASSWORD)) {
                ws.isAdmin = true;
                send(ws, { type: "admin_login_result", ok: true,
                    text: "Admin verified" });
            } else {
                send(ws, { type: "admin_login_result", ok: false,
                    text: "Incorrect admin password" });
            }
            return;
        }

        // Join a room
        if (data.type === "join") {
            if (ws.room) return;

            const roomId = String(data.room || "").trim();
            const name = String(data.name || "User").trim().slice(0, 40);

            if (!roomId || !name) {
                send(ws, { type: "message", text: "Room ID and name required" });
                return;
            }

            // Official room: only the authenticated admin may create it.
            // Everyone else can join once it exists.
            if (roomId === OFFICIAL_ROOM && !rooms.has(OFFICIAL_ROOM) && !isAdmin(ws)) {
                send(ws, { type: "message",
                    text: "Official Room is not open yet. Please try again later." });
                return;
            }

            const room = getRoom(roomId);
            if (room.users.length >= MAX_USERS) {
                send(ws, { type: "room_full", text: "Room full - 9 users maximum" });
                return;
            }

            ws.room = roomId;
            ws.name = name;

            if (room.official) {
                ws.role = isAdmin(ws) ? "admin" : "user";
                if (isAdmin(ws)) room.hostId = ws.id;
            } else if (room.users.length === 0) {
                ws.role = "host";
                room.hostId = ws.id;
            } else {
                ws.role = "user";
            }

            room.users.push({ id: ws.id, name: ws.name, role: ws.role, ws });

            // In official room, everyone starts muted. Admin is also muted by default.
            send(ws, {
                type: "joined",
                id: ws.id,
                role: ws.role,
                hostId: room.hostId,
                official: room.official,
                canSpeak: room.speakers.has(ws.id),
                users: room.users.map(u => ({
                    id: u.id, name: u.name, role: u.role,
                    canSpeak: room.speakers.has(u.id)
                }))
            });

            broadcast(room, {
                type: "user_joined",
                id: ws.id,
                name: ws.name,
                role: ws.role,
                canSpeak: room.speakers.has(ws.id)
            }, ws);
            return;
        }

        if (!ws.room) return;
        const room = rooms.get(ws.room);
        if (!room) return;

        // Request permission to speak
        if (data.type === "mic_request") {
            if (!room.official) {
                room.speakers.add(ws.id);
                send(ws, { type: "mic_permission", allowed: true });
                return;
            }

            room.requests.add(ws.id);
            const admin = room.users.find(u => isAdmin(u.ws));
            if (admin) {
                send(admin.ws, {
                    type: "mic_request_received",
                    id: ws.id,
                    name: ws.name
                });
            } else {
                send(ws, { type: "message", text: "Admin is not currently online" });
            }
            return;
        }

        // Admin grants/revokes permission
        if (data.type === "mic_permission_set") {
            if (!room.official || !isAdmin(ws)) {
                send(ws, { type: "message", text: "Admin permission required" });
                return;
            }

            const targetId = String(data.target || "");
            const target = findUser(room, targetId);
            if (!target) return;

            if (data.allowed === true) {
                room.speakers.add(targetId);
                room.requests.delete(targetId);
            } else {
                room.speakers.delete(targetId);
                room.requests.delete(targetId);
            }

            send(target.ws, {
                type: "mic_permission",
                allowed: data.allowed === true
            });

            broadcast(room, {
                type: "speaker_changed",
                id: targetId,
                canSpeak: data.allowed === true
            });
            return;
        }

        // Non-official rooms retain host control; official-room admin is separate.
        if (data.type === "offer" || data.type === "answer" ||
            data.type === "candidate") {
            const target = findUser(room, data.target);
            if (!target) return;
            send(target.ws, { ...data, from: ws.id });
        }
    });

    ws.on("close", () => {
        if (!ws.room) return;
        const roomId = ws.room;
        const room = rooms.get(roomId);
        if (!room) return;

        const leavingId = ws.id;
        const wasHost = room.hostId === leavingId;

        room.users = room.users.filter(u => u.id !== leavingId);
        room.requests.delete(leavingId);
        room.speakers.delete(leavingId);

        broadcast(room, { type: "user_left", id: leavingId });

        if (wasHost && room.users.length > 0 && !room.official) {
            room.hostId = room.users[0].id;
            room.users[0].role = "host";
            broadcast(room, { type: "host_changed", hostId: room.hostId });
        }

        // Official room stays available even when empty.
        if (room.users.length === 0 && !room.official) {
            rooms.delete(roomId);
        } else if (room.official && wasHost) {
            room.hostId = null;
        }
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Ro_ko Voice Chat server started on port " + PORT);
});
