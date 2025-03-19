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
  
  // Join game handler
  socket.on('join_game', ({ roomCode, playerName, isHost }) => {
    console.log(`Player ${playerName} joining room ${roomCode}, isHost: ${isHost}`);
    
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
    
    // Check if player is already in the room (reconnection)
    const existingPlayerIndex = game.players.findIndex(p => 
      p.name.toLowerCase() === playerName.toLowerCase()
    );
    
    if (existingPlayerIndex >= 0) {
      // Update existing player's socket ID
      game.players[existingPlayerIndex].id = socket.id;
      console.log(`Player ${playerName} reconnected`);
    } else {
      // Add new player to game
      const player = {
        id: socket.id,
        name: playerName,
        isHost: isHost === "true" || isHost === true,  // Convert string to boolean
        isAlive: true,
        role: null
      };
      
      game.players.push(player);
      console.log(`Added player ${playerName} as ${player.isHost ? 'host' : 'player'}`);
    }
    
    // Join socket room
    socket.join(roomCode);
    
    // Store room code on socket for disconnect handling
    socket.roomCode = roomCode;
    
    // Notify all players in the room
    io.to(roomCode).emit('player_joined', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,  // Make sure this is included
        isAlive: p.isAlive
      }))
    });
  });
  
  // Handle game start
  socket.on('start_game', ({ roomCode, settings }) => {
    console.log(`Attempting to start game in room ${roomCode}`);
    
    const game = activeGames.get(roomCode);
    if (!game) {
      console.error(`Room ${roomCode} not found`);
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Find the player who is trying to start the game
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      console.error(`Player not found in room ${roomCode}`);
      socket.emit('error', { message: 'Player not found in room' });
      return;
    }
    
    // Check if the player is the host
    if (!player.isHost) {
      console.error(`Non-host player tried to start game in room ${roomCode}`);
      socket.emit('error', { message: 'Only the host can start the game' });
      return;
    }
    
    // Check if there are enough players
    if (game.players.length < 4) {
      console.error(`Not enough players in room ${roomCode}`);
      socket.emit('error', { message: 'Need at least 4 players to start' });
      return;
    }
    
    console.log(`Starting game in room ${roomCode} with ${game.players.length} players`);
    
    // Assign roles based on settings
    const roles = assignRoles(game.players.length, settings);
    
    // Assign roles to players
    game.players.forEach((player, index) => {
      player.role = roles[index];
      console.log(`Assigned role ${player.role} to player ${player.name}`);
    });
    
    // Update game state
    game.gameState = 'playing';
    game.settings = settings;
    game.currentPhase = 'night';
    game.round = 1;
    
    console.log(`Game started in room ${roomCode}`);
    
    // Notify all players that game has started
    io.to(roomCode).emit('game_started');
    
    // Send role information to each player privately
    game.players.forEach(player => {
      io.to(player.id).emit('role_assigned', {
        role: player.role,
        description: getRoleDescription(player.role)
      });
    });
    
    // Start night phase
    io.to(roomCode).emit('phase_changed', {
      phase: 'night',
      round: game.round,
      timeLeft: 60,
      alivePlayers: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isAlive: p.isAlive
      }))
    });
    
    // Set timer for phase end
    setTimeout(() => {
      endNightPhase(io, roomCode, game);
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


// server.js - Add a route to create rooms
app.post('/api/rooms', (req, res) => {
  const { hostName, settings } = req.body;
  
  // Generate a room code on the server
  const roomCode = generateRoomCode();
  
  // Create the room in memory
  activeGames.set(roomCode, {
    roomCode,
    players: [],
    gameState: 'waiting',
    settings: settings || {},
    roles: {},
    currentPhase: null,
    round: 0,
    votes: {},
    nightActions: {}
  });
  
  console.log(`Created room with code: ${roomCode}`);
  
  // Return the room code to the client
  res.json({ roomCode });
});

// Helper function to generate a room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

// Start server
const PORT = process.env.PORT || 3099;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Helper function to assign roles
function assignRoles(playerCount, settings) {
  const roles = [];
  const mafiaCount = settings.mafiaCount || 1;
  
  // Add mafia
  for (let i = 0; i < mafiaCount; i++) {
    roles.push("Mafia");
  }
  
  // Add special roles
  if (settings.includeDoctor) roles.push("Doctor");
  if (settings.includePolice) roles.push("Police");
  if (settings.includeTeller) roles.push("Fortune Teller");
  if (settings.includeKiller) roles.push("Serial Killer");
  
  // Fill remaining with citizens
  while (roles.length < playerCount) {
    roles.push("Citizen");
  }
  
  // Shuffle roles
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  
  return roles;
}

// Helper function for role descriptions
function getRoleDescription(role) {
  switch(role) {
    case "Mafia":
      return "Kill one person each night. Blend in during the day.";
    case "Police":
      return "Investigate one player each night to learn if they are evil.";
    case "Doctor":
      return "Choose one player to protect each night.";
    case "Citizen":
      return "Find and eliminate the Mafia during day discussions.";
    case "Fortune Teller":
      return "See the role of one player each night.";
    case "Serial Killer":
      return "Kill one person each night. Win by being the last one standing.";
    default:
      return "";
  }
}