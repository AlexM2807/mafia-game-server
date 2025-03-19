const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
require('dotenv').config();

// Import game logic
const { handleGameLogic } = require('./gameLogic');

// Initialize app
const app = express();
const server = http.createServer(app);
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Connect to MongoDB (optional)
if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));
}

// In-memory game state
const activeGames = new Map();
const players = new Map();

// Socket.IO connection handler
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);
  
  // Handle player joining
  socket.on('join_game', ({ roomCode, playerName, isHost }) => {
    console.log(`Player ${playerName} joining room ${roomCode}`);
    
    // Create room if it doesn't exist
    if (!activeGames.has(roomCode)) {
      activeGames.set(roomCode, {
        players: [],
        gameState: 'waiting',
        settings: {},
        roles: {},
        currentPhase: null,
        round: 0,
        votes: {},
        nightActions: {}
      });
    }
    
    const game = activeGames.get(roomCode);
    
    // Add player to game
    const player = {
      id: socket.id,
      name: playerName,
      isHost,
      isAlive: true,
      role: null
    };
    
    game.players.push(player);
    players.set(socket.id, { roomCode, name: playerName });
    
    // Join socket room
    socket.join(roomCode);
    
    // Notify all players in the room
    io.to(roomCode).emit('player_joined', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isAlive: p.isAlive
      }))
    });
  });
  
  // Handle game start
  socket.on('start_game', ({ roomCode, settings }) => {
    const game = activeGames.get(roomCode);
    if (!game) return;
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    
    // Assign roles based on settings
    handleGameLogic.assignRoles(game, settings);
    
    // Update game state
    game.gameState = 'playing';
    game.settings = settings;
    game.currentPhase = 'night';
    game.round = 1;
    
    // Notify all players that game has started
    io.to(roomCode).emit('game_started');
    
    // Send role information to each player privately
    game.players.forEach(player => {
      io.to(player.id).emit('role_assigned', {
        role: player.role,
        description: handleGameLogic.getRoleDescription(player.role)
      });
    });
    
    // Start night phase
    io.to(roomCode).emit('phase_changed', {
      phase: 'night',
      round: game.round,
      timeLeft: 60
    });
    
    // Set timer for phase end
    setTimeout(() => {
      handleGameLogic.endNightPhase(io, roomCode, game);
    }, 60000); // 60 seconds for night phase
  });
  
  // Handle night actions (mafia kill, doctor save, etc.)
  socket.on('night_action', ({ roomCode, targetId, action }) => {
    const game = activeGames.get(roomCode);
    if (!game || game.gameState !== 'playing' || game.currentPhase !== 'night') return;
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;
    
    // Record the night action
    if (!game.nightActions[player.role]) {
      game.nightActions[player.role] = {};
    }
    game.nightActions[player.role][socket.id] = targetId;
    
    // Confirm action to player
    socket.emit('action_confirmed', { action, targetId });
  });
  
  // Handle day voting
  socket.on('vote', ({ roomCode, targetId }) => {
    const game = activeGames.get(roomCode);
    if (!game || game.gameState !== 'playing' || game.currentPhase !== 'day') return;
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isAlive) return;
    
    // Record the vote
    game.votes[socket.id] = targetId;
    
    // Notify all players about the vote
    io.to(roomCode).emit('vote_cast', {
      voterId: socket.id,
      voterName: player.name,
      targetId
    });
    
    // Check if all alive players have voted
    const aliveCount = game.players.filter(p => p.isAlive).length;
    const voteCount = Object.keys(game.votes).length;
    
    if (voteCount >= aliveCount) {
      // End day phase early if everyone has voted
      handleGameLogic.endDayPhase(io, roomCode, game);
    }
  });
  
  // Handle phase end (can be triggered by host/narrator)
  socket.on('end_phase', ({ roomCode }) => {
    const game = activeGames.get(roomCode);
    if (!game) return;
    
    const player = game.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    
    if (game.currentPhase === 'night') {
      handleGameLogic.endNightPhase(io, roomCode, game);
    } else {
      handleGameLogic.endDayPhase(io, roomCode, game);
    }
  });
  
  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    const playerData = players.get(socket.id);
    if (!playerData) return;
    
    const { roomCode } = playerData;
    const game = activeGames.get(roomCode);
    if (!game) return;
    
    // Remove player from game
    game.players = game.players.filter(p => p.id !== socket.id);
    players.delete(socket.id);
    
    // If no players left, remove the game
    if (game.players.length === 0) {
      activeGames.delete(roomCode);
      return;
    }
    
    // If host left, assign a new host
    const hostLeft = !game.players.some(p => p.isHost);
    if (hostLeft && game.players.length > 0) {
      game.players[0].isHost = true;
    }
    
    // Notify remaining players
    io.to(roomCode).emit('player_left', {
      playerId: socket.id,
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isAlive: p.isAlive
      }))
    });
  });
});

// Start server
const PORT = process.env.PORT || 3099;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});