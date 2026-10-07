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

const rooms = new Map();

console.log("VoiceChat signaling server started");

function send(ws, data) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(data));
    }
}

wss.on("connection", (ws) => {
    ws.room = null;
    ws.name = null;

    console.log("Client connected");

    ws.on("message", (message) => {
        try {
            const data = JSON.parse(message.toString());

            if (data.type === "join") {
                const room = String(data.room || "");
                const name = String(data.name || "User");

                ws.room = room;
                ws.name = name;

                if (!rooms.has(room)) {
                    rooms.set(room, []);
                }

                const users = rooms.get(room);

                if (users.length >= 2) {
                    send(ws, {
                        type: "message",
                        text: "Room is full"
                    });
                    return;
                }

                users.push(ws);

                console.log(name + " joined room " + room);

                if (users.length === 1) {
                    send(ws, {
                        type: "message",
                        text: "Waiting for another user..."
                    });
                } else if (users.length === 2) {
                    send(users[0], {
                        type: "ready"
                    });

                    send(users[1], {
                        type: "message",
                        text: "Second user joined"
                    });

                    console.log("Room " + room + " is ready");
                }

                return;
            }

            if (!ws.room) {
                return;
            }

            const users = rooms.get(ws.room);

            if (!users) {
                return;
            }

            for (const user of users) {
                if (user !== ws) {
                    send(user, data);
                }
            }

        } catch (error) {
            console.log("Invalid message:", error.message);
        }
    });

    ws.on("close", () => {
        if (!ws.room) {
            return;
        }

        const users = rooms.get(ws.room);

        if (!users) {
            return;
        }

        const index = users.indexOf(ws);

        if (index !== -1) {
            users.splice(index, 1);
        }

        for (const user of users) {
            send(user, {
                type: "message",
                text: "Other user left the room"
            });
        }

        if (users.length === 0) {
            rooms.delete(ws.room);
        }

        console.log(
            (ws.name || "User") +
            " left room " +
            ws.room
        );
    });

    ws.on("error", (error) => {
        console.log("WebSocket error:", error.message);
    });
});

server.listen(PORT, "0.0.0.0", () => {
    console.log("Server listening on port " + PORT);
});
