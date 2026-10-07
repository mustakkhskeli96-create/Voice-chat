const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
    res.writeHead(200, {
        "Content-Type": "text/plain"
    });

    res.end("VoiceChat signaling server is running");
});

const wss = new WebSocket.Server({ server });

// roomId -> Map(clientId -> client)
const rooms = new Map();

const MAX_USERS = 9;

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

function broadcast(room, data, exceptId = null) {
    for (const [id, client] of room.users) {
        if (id !== exceptId) {
            send(client.ws, data);
        }
    }
}

function makeUserList(room) {
    return Array.from(room.users.values()).map(client => ({
        id: client.id,
        name: client.name,
        role: client.role
    }));
}

wss.on("connection", (ws) => {

    const client = {
        ws,
        id: Math.random().toString(36).substring(2, 12),
        name: "",
        room: "",
        role: "user"
    };

    ws.on("message", (message) => {

        try {
            const data = JSON.parse(message.toString());

            // =========================
            // JOIN ROOM
            // =========================
            if (data.type === "join") {

                const roomId = String(data.room || "").trim();
                const name = String(data.name || "").trim();

                if (!roomId || !name) {
                    send(ws, {
                        type: "message",
                        text: "Name और Room ID जरूरी है"
                    });
                    return;
                }

                let room = rooms.get(roomId);

                if (!room) {
                    room = {
                        users: new Map(),
                        hostId: null
                    };

                    rooms.set(roomId, room);
                }

                if (room.users.size >= MAX_USERS) {
                    send(ws, {
                        type: "room_full",
                        text: "Room full है (Maximum 9 users)"
                    });

                    return;
                }

                client.name = name;
                client.room = roomId;

                // First person = HOST
                if (room.users.size === 0) {
                    client.role = "host";
                    room.hostId = client.id;
                } else {
                    client.role = "user";
                }

                room.users.set(client.id, client);

                // Send information to newly joined user
                send(ws, {
                    type: "joined",
                    id: client.id,
                    role: client.role,
                    hostId: room.hostId,
                    users: makeUserList(room)
                });

                // Tell existing users about new user
                broadcast(
                    room,
                    {
                        type: "user_joined",
                        id: client.id,
                        name: client.name,
                        role: client.role
                    },
                    client.id
                );

                console.log(
                    `${name} joined room ${roomId} as ${client.role}`
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

                const room = rooms.get(client.room);

                if (!room) {
                    return;
                }

                const targetId = data.target;

                if (!targetId) {
                    return;
                }

                const targetClient = room.users.get(targetId);

                if (!targetClient) {
                    return;
                }

                send(targetClient.ws, {
                    type: data.type,
                    from: client.id,
                    sdp: data.sdp,
                    sdpMid: data.sdpMid,
                    sdpMLineIndex: data.sdpMLineIndex,
                    candidate: data.candidate
                });

                return;
            }

            // =========================
            // CHAT / STATUS MESSAGE
            // =========================
            if (data.type === "message") {

                const room = rooms.get(client.room);

                if (!room) {
                    return;
                }

                broadcast(
                    room,
                    {
                        type: "message",
                        text: data.text || ""
                    },
                    client.id
                );

                return;
            }

        } catch (error) {

            console.log(
                "Message error:",
                error.message
            );
        }
    });

    // =========================
    // USER DISCONNECTED
    // =========================
    ws.on("close", () => {

        if (!client.room) {
            return;
        }

        const room = rooms.get(client.room);

        if (!room) {
            return;
        }

        room.users.delete(client.id);

        console.log(
            `${client.name} left room ${client.room}`
        );

        // If HOST leaves
        if (room.hostId === client.id) {

            const nextUser =
                room.users.values().next().value;

            if (nextUser) {

                nextUser.role = "host";
                room.hostId = nextUser.id;

                broadcast(room, {
                    type: "host_changed",
                    hostId: nextUser.id,
                    name: nextUser.name
                });

            } else {

                room.hostId = null;
            }
        }

        // Tell remaining users
        broadcast(room, {
            type: "user_left",
            id: client.id
        });

        // Delete empty room
        if (room.users.size === 0) {
            rooms.delete(client.room);

            console.log(
                `Room ${client.room} deleted`
            );
        }
    });
});

server.listen(
    PORT,
    "0.0.0.0",
    () => {
        console.log(
            `VoiceChat signaling server running on port ${PORT}`
        );
    }
);
