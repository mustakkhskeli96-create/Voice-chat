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

// Official Room हमेशा मौजूद रहेगा।
rooms.set(OFFICIAL_ROOM, {
    users: [],
    hostId: null,
    official: true,
    requests: new Set(),
    speakers: new Set()
});

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
            official: false,
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

function canManageMic(ws, room) {
    return isAdmin(ws) || room.hostId === ws.id;
}

function sendUsers(room) {
    return room.users.map(user => ({
        id: user.id,
        name: user.name,
        role: user.role,
        canSpeak: room.speakers.has(user.id)
    }));
}

function setMicPermission(room, target, allowed) {
    if (!target) return;

    if (allowed) {
        room.speakers.add(target.id);
    } else {
        room.speakers.delete(target.id);
    }

    room.requests.delete(target.id);

    send(target.ws, {
        type: "mic_permission",
        allowed: allowed
    });

    broadcast(room, {
        type: "speaker_changed",
        id: target.id,
        canSpeak: allowed
    });
}

function notifyMicRequest(room, requester) {
    let sent = false;

    for (const user of room.users) {
        if (canManageMic(user.ws, room) &&
            user.id !== requester.id) {
            send(user.ws, {
                type: "mic_request_received",
                id: requester.id,
                name: requester.name
            });
            sent = true;
        }
    }

    if (!sent) {
        send(requester.ws, {
            type: "message",
            text: "Host/Admin अभी ऑनलाइन नहीं है।"
        });
    }
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
            send(ws, {
                type: "message",
                text: "Invalid message"
            });
            return;
        }

        // Admin login
        if (data.type === "admin_login") {
            if (!ADMIN_PASSWORD) {
                send(ws, {
                    type: "admin_login_result",
                    ok: false,
                    text: "ADMIN_PASSWORD Render में सेट नहीं है"
                });
                return;
            }

            if (safeEqual(data.password, ADMIN_PASSWORD)) {
                ws.isAdmin = true;
                send(ws, {
                    type: "admin_login_result",
                    ok: true,
                    text: "Admin verified"
                });
            } else {
                send(ws, {
                    type: "admin_login_result",
                    ok: false,
                    text: "गलत Admin password"
                });
            }
            return;
        }

        // Join room
        if (data.type === "join") {
            if (ws.room) return;

            const roomId = String(data.room || "").trim();
            const name = String(data.name || "User")
                .trim()
                .slice(0, 40);

            if (!roomId || !name) {
                send(ws, {
                    type: "message",
                    text: "Room ID और नाम डालें"
                });
                return;
            }

            const room = getRoom(roomId);

            if (room.users.length >= MAX_USERS) {
                send(ws, {
                    type: "room_full",
                    text: "Room full - 9 users maximum"
                });
                return;
            }

            ws.room = roomId;
            ws.name = name;

            if (room.official) {
                if (isAdmin(ws)) {
                    ws.role = "admin";
                    room.hostId = ws.id;
                } else {
                    ws.role = "user";
                }
            } else if (room.users.length === 0) {
                ws.role = "host";
                room.hostId = ws.id;
            } else {
                ws.role = "user";
            }

            room.users.push({
                id: ws.id,
                name: ws.name,
                role: ws.role,
                ws
            });

            send(ws, {
                type: "joined",
                id: ws.id,
                role: ws.role,
                hostId: room.hostId,
                official: room.official,
                canSpeak: room.speakers.has(ws.id),
                users: sendUsers(room)
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

        // Ask for speaking permission
        if (data.type === "mic_request") {
            if (room.speakers.has(ws.id)) {
                send(ws, {
                    type: "mic_permission",
                    allowed: true
                });
                return;
            }

            room.requests.add(ws.id);
            notifyMicRequest(room, {
                id: ws.id,
                name: ws.name,
                ws
            });
            return;
        }

        // Host/Admin grants or revokes mic permission
        if (data.type === "mic_permission_set") {
            if (!canManageMic(ws, room)) {
                send(ws, {
                    type: "message",
                    text: "Host/Admin permission required"
                });
                return;
            }

            const target = findUser(room, data.target);
            if (!target) return;

            setMicPermission(
                room,
                target,
                data.allowed === true
            );
            return;
        }

        // Admin may assign a new Official Room host.
        if (data.type === "set_official_host") {
            if (!room.official || !isAdmin(ws)) {
                send(ws, {
                    type: "message",
                    text: "Only Admin can assign Official Room Host"
                });
                return;
            }

            const target = findUser(room, data.target);
            if (!target || isAdmin(target.ws)) return;

            const oldHost = findUser(room, room.hostId);
            if (oldHost && !isAdmin(oldHost.ws)) {
                oldHost.role = "user";
            }

            room.hostId = target.id;
            target.role = "host";

            broadcast(room, {
                type: "host_changed",
                hostId: room.hostId
            });
            return;
        }

        // WebRTC signaling
        if (data.type === "offer" ||
            data.type === "answer" ||
            data.type === "candidate") {
            const target = findUser(room, data.target);
            if (!target) return;

            send(target.ws, {
                ...data,
                from: ws.id
            });
        }
    });

    ws.on("close", () => {
        if (!ws.room) return;

        const roomId = ws.room;
        const room = rooms.get(roomId);
        if (!room) return;

        const leavingId = ws.id;
        const wasHost = room.hostId === leavingId;

        room.users = room.users.filter(
            user => user.id !== leavingId
        );

        room.requests.delete(leavingId);
        room.speakers.delete(leavingId);

        broadcast(room, {
            type: "user_left",
            id: leavingId
        });

        if (wasHost) {
            room.hostId = null;

            if (room.official) {
                const admin = room.users.find(
                    user => isAdmin(user.ws)
                );

                if (admin) {
                    room.hostId = admin.id;
                }
            } else if (room.users.length > 0) {
                room.hostId = room.users[0].id;
                room.users[0].role = "host";
            }

            broadcast(room, {
                type: "host_changed",
                hostId: room.hostId
            });
        }

        // Private rooms disappear when empty.
        // Official Room remains available.
        if (room.users.length === 0 && !room.official) {
            rooms.delete(roomId);
        }
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        "Ro_ko Voice Chat server started on port " + PORT
    );
});
