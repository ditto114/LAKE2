/**
 * 방 관리 모듈
 * 방 생성 / 참가 / 퇴장 / 목록 조회
 */

class RoomManager {
  constructor() {
    /** @type {Map<string, Room>} */
    this.rooms = new Map();
  }

  // ── 방 코드 생성 (4자리, 혼동 문자 제외) ──

  generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
    } while (this.rooms.has(code));
    return code;
  }

  // ── 방 생성 ──

  createRoom(hostId, hostNickname) {
    const code = this.generateCode();
    const room = {
      code,
      host: { id: hostId, nickname: hostNickname },
      guest: null,
      status: 'waiting',   // waiting | playing | finished
      gameState: null,
      createdAt: Date.now(),
    };
    this.rooms.set(code, room);
    return room;
  }

  // ── 방 참가 ──

  joinRoom(code, guestId, guestNickname) {
    const room = this.rooms.get(code);
    if (!room) return { error: '존재하지 않는 방입니다.' };
    if (room.status === 'playing') return { error: '이미 게임이 진행 중입니다.' };
    if (room.guest) return { error: '방이 가득 찼습니다.' };
    if (room.host.id === guestId) return { error: '자신의 방에 참가할 수 없습니다.' };

    room.guest = { id: guestId, nickname: guestNickname };
    return { room };
  }

  // ── 방 퇴장 ──

  leaveRoom(code, playerId) {
    const room = this.rooms.get(code);
    if (!room) return null;

    if (room.host.id === playerId) {
      if (room.guest) {
        // 게스트를 호스트로 승격
        room.host = room.guest;
        room.guest = null;
        room.status = 'waiting';
        room.gameState = null;
        return { disbanded: false, promoted: room.host };
      }
      // 혼자 남은 호스트 퇴장 → 방 삭제
      this.rooms.delete(code);
      return { disbanded: true };
    }

    if (room.guest && room.guest.id === playerId) {
      room.guest = null;
      if (room.status !== 'waiting') {
        room.status = 'waiting';
        room.gameState = null;
      }
      return { disbanded: false, promoted: null };
    }

    return null;
  }

  // ── 조회 ──

  getRoom(code) {
    return this.rooms.get(code) || null;
  }

  getRoomByPlayerId(playerId) {
    for (const room of this.rooms.values()) {
      if (room.host.id === playerId) return room;
      if (room.guest && room.guest.id === playerId) return room;
    }
    return null;
  }

  getPublicList() {
    const list = [];
    for (const room of this.rooms.values()) {
      if (room.status !== 'waiting') continue;
      list.push({
        code: room.code,
        hostNickname: room.host.nickname,
        playerCount: room.guest ? 2 : 1,
      });
    }
    return list;
  }

  // ── 오래된 빈 방 정리 (기본 30분) ──

  cleanup(maxAgeMs = 30 * 60 * 1000) {
    const now = Date.now();
    for (const [code, room] of this.rooms) {
      if (room.status === 'waiting' && !room.guest && now - room.createdAt > maxAgeMs) {
        this.rooms.delete(code);
      }
    }
  }
}

module.exports = RoomManager;
