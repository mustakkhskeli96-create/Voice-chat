const http = require("http");
const WebSocket = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 10000;
const MAX_USERS = 9;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const OFFICIAL_ROOM = "IMK_OFFICIAL";

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("IMK Voice Chat server is running");
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();
let nextId = 1;

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data) {
    if (!room) return;
    for (const user of room.users) {
        send(user.ws, data);
    }
}

function createRoom(roomId) {
    return {
        id: roomId,
        users: [],
        hostId: null,
        official: roomId === OFFICIAL_ROOM,
        requests: new Set(),
        speakers: new Set()
    };
}

rooms.set(OFFICIAL_ROOM, createRoom(OFFICIAL_ROOM));

function getRoom(roomId) {
    if (!rooms.has(roomId)) {
        rooms.set(roomId, createRoom(roomId));
    }
    return rooms.get(roomId);
}

function findUser(room, id) {
    return room.users.find(user => user.id === String(id));
}

function safeEqual(a, b) {
    const x = Buffer.from(String(a || ""));
    const y = Buffer.from(String(b || ""));
    return x.length === y.length &&
        crypto.timingSafeEqual(x, y);
}

function isAdmin(ws) {
    return ws.isAdmin === true;
}

function canManageMic(ws, room) {
    if (isAdmin(ws)) return true;

    return room.official &&
        room.hostId === ws.id &&
        room.users.some(user => user.id === ws.id);
}

function sendUsers(room) {
    broadcast(room, {
        type: "users",
        hostId: room.hostId,
        users: room.users.map(user => ({
            id: user.id,
            name: user.name,
            role: user.role,
            canSpeak: room.speakers.has(user.id)
        }))
    });
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

        if (data.type === "admin_login") {
            if (!ADMIN_PASSWORD) {
                send(ws, {
                    type: "admin_login_result",
                    ok: false,
                    text: "Server पर ADMIN_PASSWORD सेट नहीं है"
                });
                return;
            }

            if (safeEqual(data.password, ADMIN_PASSWORD)) {
                ws.isAdmin = true;

                send(ws, {
                    type: "admin_login_result",
                    ok: true,
                    text: "Admin Login सफल"
                });
            } else {
                send(ws, {
                    type: "admin_login_result",
                    ok: false,
                    text: "Admin Password गलत है"
                });
            }

            return;
        }

        if (data.type === "join") {
            if (ws.room) {
                send(ws, {
                    type: "message",
                    text: "आप पहले से एक रूम में जुड़े हैं"
                });
                return;
            }

            let roomId = String(data.room || "").trim();

            // पुराने ऐप को नए आधिकारिक रूम पर भेजें।
            if (roomId.toUpperCase() === "ROKO_OFFICIAL") {
                roomId = OFFICIAL_ROOM;
            }

            const name = String(data.name || "User")
                .trim()
                .slice(0, 40);

            if (!roomId || !name) {
                send(ws, {
                    type: "message",
                    text: "नाम और Room ID डालें"
                });
                return;
            }

            const room = getRoom(roomId);

            if (room.users.length >= MAX_USERS) {
                send(ws, {
                    type: "room_full",
                    text: "रूम भर चुका है — अधिकतम 9 लोग"
                });
                return;
            }

            ws.room = roomId;
            ws.name = name;

            if (room.official) {
                if (isAdmin(ws)) {
                    ws.role = "admin";
                     room.speakers.add(ws.id);
                    // यदि होस्ट तय नहीं है, तो Admin होस्ट बनेगा।
                    if (!room.hostId) {
                        room.hostId = ws.id;
                    }
                } else if (room.hostId === ws.id) {
                    ws.role = "host";
                } else {
                    ws.role = "user";
                }
            } else if (room.users.length === 0) {
                ws.role = "host";
                room.hostId = ws.id;
                room.speakers.add(ws.id);
            } else {
                ws.role = "user";
                room.speakers.add(ws.id);
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
                users: room.users.map(user => ({
                    id: user.id,
                    name: user.name,
                    role: user.role,
                    canSpeak: room.speakers.has(user.id)
                }))
            });

            broadcast(room, {
                type: "user_joined",
                id: ws.id,
                name: ws.name,
                role: ws.role,
                canSpeak: room.speakers.has(ws.id)
            });

            return;
        }

        if (!ws.room) return;

        const room = rooms.get(ws.room);
        if (!room) return;

        if (data.type === "mic_request") {
            if (!room.official) {
                room.speakers.add(ws.id);
                send(ws, {
                    type: "mic_permission",
                    allowed: true
                });
                return;
            }

            room.requests.add(ws.id);

            const managers = room.users.filter(user =>
                canManageMic(user.ws, room)
            );

            if (managers.length === 0) {
                send(ws, {
                    type: "message",
                    text: "होस्ट/एडमिन ऑनलाइन नहीं है"
                });
                return;
            }

            for (const manager of managers) {
                send(manager.ws, {
                    type: "mic_request_received",
                    id: ws.id,
                    name: ws.name
                });
            }

            send(ws, {
                type: "message",
                text: "माइक अनुमति का अनुरोध भेज दिया गया"
            });

            return;
        }

        if (data.type === "mic_permission_set") {
            if (!canManageMic(ws, room)) {
                send(ws, {
                    type: "message",
                    text: "Admin या Official Host की अनुमति ज़रूरी है"
                });
                return;
            }

            const targetId = String(data.target || "");
            const target = findUser(room, targetId);

            if (!target) return;

            const allowed = data.allowed === true;

            if (allowed) {
                room.speakers.add(targetId);
            } else {
                room.speakers.delete(targetId);
                room.requests.delete(targetId);
            }

            if (allowed) {
                room.requests.delete(targetId);
            }

            send(target.ws, {
                type: "mic_permission",
                allowed
            });

            broadcast(room, {
                type: "speaker_changed",
                id: targetId,
                canSpeak: allowed
            });

            return;
        }

        if (data.type === "set_official_host") {
            if (!isAdmin(ws) || !room.official) {
                send(ws, {
                    type: "message",
                    text: "यह काम केवल Official Room Admin कर सकता है"
                });
                return;
            }

            const targetId = String(data.target || "");
            const target = findUser(room, targetId);

            if (!target) return;

            room.hostId = targetId;

            for (const user of room.users) {
                if (user.role === "host") user.role = "user";
            }

            target.role = "host";

            broadcast(room, {
                type: "host_changed",
                hostId: room.hostId
            });

            sendUsers(room);
            return;
        }

        if (
            data.type === "offer" ||
            data.type === "answer" ||
            data.type === "candidate"
        ) {
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

        if (wasHost && room.official) {
            room.hostId = null;

            // Admin ऑनलाइन हो तो उसे होस्ट बनाया जा सकता है।
            const admin = room.users.find(user =>
                isAdmin(user.ws)
            );

            if (admin) {
                room.hostId = admin.id;
                admin.role = "admin";
            }
        } else if (
            wasHost &&
            !room.official &&
            room.users.length > 0
        ) {
            room.hostId = room.users[0].id;
            room.users[0].role = "host";

            broadcast(room, {
                type: "host_changed",
                hostId: room.hostId
            });
        }

        if (room.users.length === 0 && !room.official) {
            rooms.delete(roomId);
        } else {
            sendUsers(room);
        }
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("IMK Voice Chat server started on port " + PORT);
});
