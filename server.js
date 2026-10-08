const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;
const MAX_USERS = 9;

const server = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("VoiceChat signaling server is running");
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
        if (user !== except) {
            send(user.ws, data);
        }
    }
}

wss.on("connection", (ws) => {
    ws.id = String(nextId++);
    ws.room = null;
    ws.name = "User";
    ws.role = "user";

    console.log("Client connected:", ws.id);

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message.toString());

            // =========================
            // JOIN ROOM
            // =========================
            if (data.type === "join") {
                const roomId = String(data.room || "").trim();
                const name = String(data.name || "User").trim();

                if (!roomId) {
                    send(ws, {
                        type: "message",
                        text: "Room ID required"
                    });
                    return;
                }

                if (ws.room) {
                    return;
                }

                if (!rooms.has(roomId)) {
                    rooms.set(roomId, {
                        users: [],
                        hostId: null
                    });
                }

                const room = rooms.get(roomId);

                if (room.users.length >= MAX_USERS) {
                    send(ws, {
                        type: "room_full",
                        text: "Room full - 9 users maximum"
                    });
                    return;
                }

                ws.room = roomId;
                ws.name = name;

                // First user = Host
                if (room.users.length === 0) {
                    ws.role = "host";
                    room.hostId = ws.id;
                } else {
                    ws.role = "user";
                }

                room.users.push({
                    id: ws.id,
                    name: ws.name,
                    role: ws.role,
                    ws: ws
                });

                console.log(
                    name + " joined room " + roomId +
                    " as " + ws.role
                );

                // Send current room information to new user
                send(ws, {
                    type: "joined",
                    id: ws.id,
                    role: ws.role,
                    hostId: room.hostId,
                    users: room.users.map(user => ({
                        id: user.id,
                        name: user.name,
                        role: user.role
                    }))
                });

                // Tell existing users about new user
                broadcast(room, {
                    type: "user_joined",
                    id: ws.id,
                    name: ws.name,
                    role: ws.role
                }, ws);

                console.log(
                    "Room " + roomId +
                    " now has " + room.users.length + " users"
                );

                return;
            }

            // =========================
            // WEBRTC SIGNALING
            // =========================
            if (
                data.type === "offer" ||
                data.type === "answer" ||
                data.type === "candidate"
            ) {
                if (!ws.room) return;

                const room = rooms.get(ws.room);
                if (!room) return;

                const targetId = String(data.target || "");

                const targetUser = room.users.find(
                    user => user.id === targetId
                );

                if (!targetUser) {
                    console.log(
                        "Target user not found:",
                        targetId
                    );
                    return;
                }

                send(targetUser.ws, {
                    ...data,
                    from: ws.id
                });

                return;
            }

        } catch (error) {
            console.log("Invalid message:", error.message);
        }
    });

    // =========================
    // USER DISCONNECTED
    // =========================
    ws.on("close", () => {
        if (!ws.room) return;

        const room = rooms.get(ws.room);
        if (!room) return;

        const leavingId = ws.id;
        const leavingName = ws.name;
        const wasHost = room.hostId === leavingId;

        room.users = room.users.filter(
            user => user.id !== leavingId
        );

        console.log(
            leavingName + " left room " + ws.room
        );

        // Notify remaining users
        broadcast(room, {
            type: "user_left",
            id: leavingId
        });

        // If Host left, promote first remaining user
        if (wasHost && room.users.length > 0) {
            const newHost = room.users[0];

            newHost.role = "host";
            room.hostId = newHost.id;

            broadcast(room, {
                type: "host_changed",
                hostId: newHost.id
            });

            console.log(
                newHost.name + " is now Host"
            );
        }

        // Delete empty room
        if (room.users.length === 0) {
            rooms.delete(ws.room);
            console.log(
                "Room " + ws.room + " deleted"
            );
        }
    });

    ws.on("error", (error) => {
        console.log(
            "WebSocket error:",
            error.message
        );
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(
        "VoiceChat signaling server started"
    );
    console.log(
        "Server listening on port " + PORT
    );
});
