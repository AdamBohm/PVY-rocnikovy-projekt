const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration with more robust settings
const io = socketIo(server, {
    pingTimeout: 120000, // Increased timeout to 2 minutes
    pingInterval: 10000, // More frequent pings
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    },
    transports: ['websocket'], // Force WebSocket only for better stability
    allowEIO3: true,
    maxHttpBufferSize: 1e8,
    connectTimeout: 30000,
    upgradeTimeout: 30000
});

app.use(express.static('public'));

const players = {};
let winner = null;
const FINISH_LINE_Y = 50;
const RACE_RESET_DELAY = 5000;
const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const PLAYER_WIDTH = 60;
const PLAYER_HEIGHT = 30;
const MAX_PLAYERS = 50;
const INACTIVE_TIMEOUT = 120000; // 2 minutes

// Connection tracking
const activeConnections = new Set();
const connectionAttempts = new Map();
const lastActivity = new Map();

io.on('connection', (socket) => {
    // Check for duplicate connections
    if (activeConnections.has(socket.id)) {
        console.log(`Duplicate connection attempt from ${socket.id}`);
        socket.disconnect(true);
        return;
    }

    // Check server capacity
    if (Object.keys(players).length >= MAX_PLAYERS) {
        console.log(`Server full, rejecting connection from ${socket.id}`);
        socket.emit('serverFull');
        socket.disconnect(true);
        return;
    }

    activeConnections.add(socket.id);
    lastActivity.set(socket.id, Date.now());
    console.log(`New player connected: ${socket.id}`);

    // Initialize player at bottom of screen with random x position
    const startX = Math.floor(Math.random() * (CANVAS_WIDTH - PLAYER_WIDTH));
    players[socket.id] = { 
        x: startX, 
        y: CANVAS_HEIGHT - PLAYER_HEIGHT - 20,
        lastUpdate: Date.now(),
        name: `Player ${socket.id.slice(0, 4)}`,
        carImage: 'fabia' // Default car
    };

    // Send current players to new player
    socket.emit('currentPlayers', players);
    // Notify others about new player
    socket.broadcast.emit('newPlayer', { id: socket.id, ...players[socket.id] });

    // Handle car selection
    socket.on('carSelected', (carType) => {
        if (players[socket.id]) {
            players[socket.id].carImage = carType;
            io.emit('playerCarChanged', { id: socket.id, carImage: carType });
        }
    });

    // Setup ping mechanism
    const pingInterval = setInterval(() => {
        if (socket.connected) {
            socket.emit('ping');
        }
    }, 10000);

    socket.on('pong', () => {
        if (players[socket.id]) {
            players[socket.id].lastUpdate = Date.now();
            lastActivity.set(socket.id, Date.now());
        }
    });

    socket.on('move', (data) => {
        if (players[socket.id] && !winner) {
            // Update player position
            players[socket.id].x = data.x;
            players[socket.id].y = data.y;
            players[socket.id].lastUpdate = Date.now();
            lastActivity.set(socket.id, Date.now());
            
            // Calculate rotation based on movement direction
            if (data.prevX !== undefined && data.prevY !== undefined) {
                const dx = data.x - data.prevX;
                const dy = data.y - data.prevY;
                if (dx !== 0 || dy !== 0) {
                    players[socket.id].rotation = Math.atan2(dy, dx);
                }
            }
            
            // Broadcast movement to all players
            io.emit('playerMoved', { 
                id: socket.id, 
                x: data.x, 
                y: data.y,
                rotation: players[socket.id].rotation
            });

            // Check if player reached finish line
            if (players[socket.id].y <= FINISH_LINE_Y) {
                winner = socket.id;
                const winnerName = players[socket.id].name;
                io.emit('raceOver', { 
                    winner: socket.id,
                    winnerName: winnerName
                });
                console.log(`Player ${winnerName} won the race!`);
                
                // Reset race after delay
                setTimeout(() => {
                    winner = null;
                    // Reset all players to starting positions
                    for (let id in players) {
                        const newStartX = Math.floor(Math.random() * (CANVAS_WIDTH - PLAYER_WIDTH));
                        players[id].y = CANVAS_HEIGHT - PLAYER_HEIGHT - 20;
                        players[id].x = newStartX;
                        players[id].rotation = 0;
                    }
                    io.emit('resetRace');
                    io.emit('currentPlayers', players);
                }, RACE_RESET_DELAY);
            }
        }
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        clearInterval(pingInterval);
        activeConnections.delete(socket.id);
        lastActivity.delete(socket.id);
        delete players[socket.id];
        io.emit('playerDisconnected', socket.id);

        // Reset race if winner disconnected
        if (winner === socket.id) {
            winner = null;
            io.emit('resetRace');
        }
    });

    socket.on('error', (error) => {
        console.error(`Socket error for ${socket.id}:`, error);
    });
});

// Periodic cleanup of inactive players
setInterval(() => {
    const now = Date.now();
    for (let id in players) {
        const lastActive = lastActivity.get(id) || 0;
        if (now - lastActive > INACTIVE_TIMEOUT) {
            console.log(`Removing inactive player: ${id}`);
            delete players[id];
            lastActivity.delete(id);
            activeConnections.delete(id);
            io.emit('playerDisconnected', id);
        }
    }
}, 30000);

function getRandomColor() {
    const colors = ['red', 'blue', 'green', 'orange', 'purple', 'yellow', 'cyan', 'magenta'];
    return colors[Math.floor(Math.random() * colors.length)];
}

server.listen(3000, () => {
    console.log('Server listening on port 3000');
});
