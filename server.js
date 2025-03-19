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
 // Join game handler
 socket.on('join_game', ({ roomCode, playerName, isHost }) => {
	console.log(`Player ${playerName} (${socket.id}) joining room ${roomCode}, isHost: ${isHost}`);
	
	// Create room if it doesn't exist
	if (!activeGames.has(roomCode)) {
		console.log(`Creating new room: ${roomCode}`);
		activeGames.set(roomCode, {
			roomCode,
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
	
	// Add player to game if not already present
	const existingPlayerIndex = game.players.findIndex(p => 
		p.name.toLowerCase() === playerName.toLowerCase()
	);
	
	if (existingPlayerIndex >= 0) {
		// Update existing player's socket ID
		game.players[existingPlayerIndex].id = socket.id;
		console.log(`Player ${playerName} reconnected with new socket ID: ${socket.id}`);
	} else {
		// Add new player to game
		const player = {
			id: socket.id,
			name: playerName,
			isHost: isHost === "true" || isHost === true,
			isAlive: true,
			role: null
		};
		
		game.players.push(player);
		console.log(`Added new player ${playerName} to room ${roomCode}`);
	}
	
	// Store room code on socket for disconnect handling
	socket.data = { ...socket.data, roomCode, playerName };
	
	// Join socket room
	socket.join(roomCode);
	
	// Log current players in the room
	console.log(`Current players in room ${roomCode}:`, 
		game.players.map(p => `${p.name}${p.isHost ? ' (Host)' : ''}`));
	
	// Notify all players in the room about the updated player list
	io.to(roomCode).emit('player_joined', {
		players: game.players.map(p => ({
			id: p.id,
			name: p.name,
			isHost: p.isHost,
			isAlive: p.isAlive
		}))
	});
	
	// Also send the initial player list to the joining player
	socket.emit('player_list', {
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
	// Your existing start_game handler...
		
		// Make sure to include all players in the game_started event
		io.to(roomCode).emit('game_started', {
			players: game.players.map(p => ({
				id: p.id,
				name: p.name,
				isHost: p.isHost,
				isAlive: p.isAlive
			}))
		});
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
  
  // Handle game start
  socket.on('start_game', ({ roomCode, settings }) => {
    // Your existing start_game handler...
    
    // Make sure to include all players in the game_started event
    io.to(roomCode).emit('game_started', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isAlive: p.isAlive
      }))
    });
  });


	// Handle get game state request
  socket.on('get_game_state', ({ roomCode }) => {
    console.log(`Get game state requested for room ${roomCode} by ${socket.id}`);
    
    const game = activeGames.get(roomCode);
    if (!game) {
      console.error(`Room ${roomCode} not found`);
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    // Find the player in the game
    const player = game.players.find(p => p.id === socket.id);
    if (!player) {
      console.error(`Player ${socket.id} not found in room ${roomCode}`);
      
      // Try to rejoin the game
      socket.emit('rejoin_needed');
      return;
    }
    
    // Send current game state to the player
    socket.emit('game_state', {
      players: game.players.map(p => ({
        id: p.id,
        name: p.name,
        isHost: p.isHost,
        isAlive: p.isAlive
      })),
      gameState: game.gameState,
      currentPhase: game.currentPhase,
      round: game.round
    });
    
    // If game is already in progress, send role information
    if (game.gameState === 'playing') {
      socket.emit('role_assigned', {
        role: player.role,
        description: getRoleDescription(player.role)
      });
      
      // Send current phase information
      socket.emit('phase_changed', {
        phase: game.currentPhase,
        round: game.round,
        timeLeft: 60, // Default time left
        alivePlayers: game.players.filter(p => p.isAlive).map(p => ({
          id: p.id,
          name: p.name
        }))
      });
    }
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