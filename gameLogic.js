const ROLES = {
  MAFIA: "Mafia",
  POLICE: "Police",
  DOCTOR: "Doctor",
  CITIZEN: "Citizen",
  TELLER: "Fortune Teller",
  KILLER: "Serial Killer",
};

const handleGameLogic = {
  // Assign roles to players based on game settings
  assignRoles: (game, settings) => {
    const { playerCount, mafiaCount, includeDoctor, includePolice, includeTeller, includeKiller } = settings;
    const players = [...game.players];
    const roles = [];
    
    // Add required roles
    for (let i = 0; i < mafiaCount; i++) {
      roles.push(ROLES.MAFIA);
    }
    
    if (includeDoctor) roles.push(ROLES.DOCTOR);
    if (includePolice) roles.push(ROLES.POLICE);
    if (includeTeller) roles.push(ROLES.TELLER);
    if (includeKiller) roles.push(ROLES.KILLER);
    
    // Fill remaining slots with citizens
    while (roles.length < players.length) {
      roles.push(ROLES.CITIZEN);
    }
    
    // Shuffle roles
    for (let i = roles.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [roles[i], roles[j]] = [roles[j], roles[i]];
    }
    
    // Assign roles to players
    players.forEach((player, index) => {
      player.role = roles[index];
    });
    
    // Update game roles for win condition checking
    game.roles = {
      mafia: players.filter(p => p.role === ROLES.MAFIA).length,
      killer: players.filter(p => p.role === ROLES.KILLER).length,
      town: players.filter(p => p.role !== ROLES.MAFIA && p.role !== ROLES.KILLER).length
    };
  },
  
  // Get role description
  getRoleDescription: (role) => {
    switch(role) {
      case ROLES.MAFIA:
        return "Kill one person each night. Blend in during the day.";
      case ROLES.POLICE:
        return "Investigate one player each night to learn if they are evil.";
      case ROLES.DOCTOR:
        return "Choose one player to protect each night.";
      case ROLES.CITIZEN:
        return "Find and eliminate the Mafia during day discussions.";
      case ROLES.TELLER:
        return "See the role of one player each night.";
      case ROLES.KILLER:
        return "Kill one person each night. Win by being the last one standing.";
      default:
        return "";
    }
  },
  
  // Process night actions and transition to day
  endNightPhase: (io, roomCode, game) => {
    // Reset votes
    game.votes = {};
    
    // Process night actions
    const nightResults = processNightActions(game);
    
    // Update game state
    game.currentPhase = 'day';
    game.nightActions = {};
    
    // Check win conditions
    const winResult = checkWinConditions(game);
    if (winResult) {
      endGame(io, roomCode, game, winResult);
      return;
    }
    
    // Notify players of night results
    io.to(roomCode).emit('night_results', nightResults);
    
    // Start day phase
    io.to(roomCode).emit('phase_changed', {
      phase: 'day',
      round: game.round,
      timeLeft: 120,
      alivePlayers: game.players.filter(p => p.isAlive).map(p => ({
        id: p.id,
        name: p.name
      }))
    });
    
    // Set timer for phase end
    setTimeout(() => {
      handleGameLogic.endDayPhase(io, roomCode, game);
    }, 120000); // 120 seconds for day phase
  },
  
  // Process day votes and transition to night
  endDayPhase: (io, roomCode, game) => {
    // Process votes
    const voteResults = processVotes(game);
    
    // Update game state
    game.currentPhase = 'night';
    game.round++;
    game.votes = {};
    
    // Check win conditions
    const winResult = checkWinConditions(game);
    if (winResult) {
      endGame(io, roomCode, game, winResult);
      return;
    }
    
    // Notify players of vote results
    io.to(roomCode).emit('vote_results', voteResults);
    
    // Start night phase
    io.to(roomCode).emit('phase_changed', {
      phase: 'night',
      round: game.round,
      timeLeft: 60,
      alivePlayers: game.players.filter(p => p.isAlive).map(p => ({
        id: p.id,
        name: p.name
      }))
    });
    
    // Set timer for phase end
    setTimeout(() => {
      handleGameLogic.endNightPhase(io, roomCode, game);
    }, 60000); // 60 seconds for night phase
  }
};

// Helper functions
function processNightActions(game) {
  const results = {
    killed: [],
    saved: [],
    investigated: []
  };
  
  // Get all targets selected by mafia
  const mafiaTargets = Object.values(game.nightActions[ROLES.MAFIA] || {});
  
  // Count votes for each target
  const targetCounts = {};
  mafiaTargets.forEach(targetId => {
    targetCounts[targetId] = (targetCounts[targetId] || 0) + 1;
  });
  
  // Find the target with most votes
  let maxVotes = 0;
  let mafiaTarget = null;
  
  Object.entries(targetCounts).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      mafiaTarget = targetId;
    }
  });
  
  // Get doctor protection target
  const doctorTargets = Object.values(game.nightActions[ROLES.DOCTOR] || {});
  const doctorTarget = doctorTargets.length > 0 ? doctorTargets[0] : null;
  
  // Get killer target
  const killerTargets = Object.values(game.nightActions[ROLES.KILLER] || {});
  const killerTarget = killerTargets.length > 0 ? killerTargets[0] : null;
  
  // Process mafia kill
  if (mafiaTarget) {
    const targetPlayer = game.players.find(p => p.id === mafiaTarget);
    if (targetPlayer && mafiaTarget !== doctorTarget) {
      targetPlayer.isAlive = false;
      results.killed.push({
        id: targetPlayer.id,
        name: targetPlayer.name
      });
    } else if (targetPlayer && mafiaTarget === doctorTarget) {
      results.saved.push({
        id: targetPlayer.id,
        name: targetPlayer.name
      });
    }
  }
  
  // Process killer kill
  if (killerTarget) {
    const targetPlayer = game.players.find(p => p.id === killerTarget);
    if (targetPlayer && killerTarget !== doctorTarget && targetPlayer.isAlive) {
      targetPlayer.isAlive = false;
      results.killed.push({
        id: targetPlayer.id,
        name: targetPlayer.name
      });
    } else if (targetPlayer && killerTarget === doctorTarget) {
      results.saved.push({
        id: targetPlayer.id,
        name: targetPlayer.name
      });
    }
  }
  
  // Update role counts
  game.roles = {
    mafia: game.players.filter(p => p.role === ROLES.MAFIA && p.isAlive).length,
    killer: game.players.filter(p => p.role === ROLES.KILLER && p.isAlive).length,
    town: game.players.filter(p => p.role !== ROLES.MAFIA && p.role !== ROLES.KILLER && p.isAlive).length
  };
  
  return results;
}

function processVotes(game) {
  // Count votes for each target
  const voteCounts = {};
  Object.values(game.votes).forEach(targetId => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });
  
  // Find the player with most votes
  let maxVotes = 0;
  let eliminatedId = null;
  
  Object.entries(voteCounts).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedId = targetId;
    }
  });
  
  // Eliminate player
  let eliminatedPlayer = null;
  if (eliminatedId) {
    eliminatedPlayer = game.players.find(p => p.id === eliminatedId);
    if (eliminatedPlayer) {
      eliminatedPlayer.isAlive = false;
    }
  }
  
  // Update role counts
  game.roles = {
    mafia: game.players.filter(p => p.role === ROLES.MAFIA && p.isAlive).length,
    killer: game.players.filter(p => p.role === ROLES.KILLER && p.isAlive).length,
    town: game.players.filter(p => p.role !== ROLES.MAFIA && p.role !== ROLES.KILLER && p.isAlive).length
  };
  
  return {
    voteCounts,
    eliminated: eliminatedPlayer ? {
      id: eliminatedPlayer.id,
      name: eliminatedPlayer.name,
      role: eliminatedPlayer.role
    } : null
  };
}

function checkWinConditions(game) {
  const { mafia, killer, town } = game.roles;
  
  if (mafia === 0 && killer === 0) {
    return { winner: "Town" };
  } else if (mafia >= town && killer === 0) {
    return { winner: "Mafia" };
  } else if (killer > 0 && mafia === 0 && killer >= town) {
    return { winner: "Serial Killer" };
  }
  
  return null;
}

function endGame(io, roomCode, game, winResult) {
  game.gameState = 'ended';
  
  io.to(roomCode).emit('game_over', {
    winner: winResult.winner,
    players: game.players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      isAlive: p.isAlive
    }))
  });
}

module.exports = { handleGameLogic, ROLES };