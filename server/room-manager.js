/**
 * 방 관리 모듈 (최대 4인)
 */
class RoomManager {
  constructor() {
    this.rooms = new Map();
  }

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    } while (this.rooms.has(code));
    return code;
  }

  createRoom(hostId, hostNickname, equippedAvatar) {
    const code = this.generateCode();
    const room = {
      code,
      players: [{ id: hostId, nickname: hostNickname, equippedAvatar: equippedAvatar || null }],
      maxPlayers: 4,
      status: 'waiting',
      gameState: null,
      createdAt: Date.now(),
      readyPlayers: new Set(),
    };
    this.rooms.set(code, room);
    return room;
  }

  joinRoom(code, playerId, nickname, equippedAvatar) {
    const room = this.rooms.get(code);
    if (!room) return { error: '존재하지 않는 방입니다.' };
    if (room.status === 'playing') return { error: '이미 게임이 진행 중입니다.' };
    if (room.players.length >= room.maxPlayers) return { error: '방이 가득 찼습니다.' };
    if (room.players.some(p => p.id === playerId)) return { error: '이미 방에 참가 중입니다.' };
    room.players.push({ id: playerId, nickname, equippedAvatar: equippedAvatar || null });
    return { room };
  }

  leaveRoom(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return null;
    const idx = room.players.findIndex(p => p.id === playerId);
    if (idx === -1) return null;
    room.players.splice(idx, 1);
    room.readyPlayers.delete(playerId);
    if (room.players.length === 0) {
      this.rooms.delete(code);
      return { disbanded: true };
    }
    if (room.status !== 'waiting' && room.players.length < 2) {
      room.status = 'waiting';
      room.gameState = null;
    }
    return { disbanded: false };
  }

  getRoom(code) { return this.rooms.get(code) || null; }

  getPublicList() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.status !== 'waiting') continue;
      list.push({
        code: room.code,
        hostNickname: room.players[0]?.nickname,
        playerCount: room.players.length,
        maxPlayers: room.maxPlayers,
      });
    }
    return list;
  }

  cleanup(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.status === 'waiting' && room.players.length <= 1 && now - room.createdAt > maxAgeMs)
        this.rooms.delete(code);
    }
  }
}

module.exports = RoomManager;
