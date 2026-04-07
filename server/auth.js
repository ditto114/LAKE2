const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const supabase = require('./supabase');

const JWT_SECRET = process.env.JWT_SECRET;
const SALT_ROUNDS = 10;

// 한글 2바이트, 그 외 1바이트로 계산하는 바이트 길이
function byteLen(str) {
  let n = 0;
  for (const ch of str) n += ch.charCodeAt(0) > 127 ? 2 : 1;
  return n;
}

// 최대 maxBytes 바이트까지 잘라냄
function truncateBytes(str, maxBytes) {
  let n = 0, result = '';
  for (const ch of str) {
    const b = ch.charCodeAt(0) > 127 ? 2 : 1;
    if (n + b > maxBytes) break;
    n += b; result += ch;
  }
  return result;
}

// ── 토큰 블랙리스트 (인메모리) ──
const tokenBlacklist = new Set();

function blacklistToken(token) {
  tokenBlacklist.add(token);
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.exp) {
      const ttl = decoded.exp * 1000 - Date.now();
      if (ttl > 0) setTimeout(() => tokenBlacklist.delete(token), ttl);
      else tokenBlacklist.delete(token);
    }
  } catch { /* ignore */ }
}

async function signup(nickname, password, ingameNickname) {
  // 입력 검증
  if (!nickname || !password || !ingameNickname) {
    return { error: '모든 항목을 입력해주세요.' };
  }
  nickname = truncateBytes(nickname.trim(), 12);
  ingameNickname = truncateBytes(ingameNickname.trim(), 12);
  if (!nickname) return { error: '닉네임을 입력해주세요.' };
  if (password.length < 4) return { error: '비밀번호는 4자 이상이어야 합니다.' };
  if (!ingameNickname) return { error: '메랜 닉네임을 입력해주세요.' };

  // 닉네임 중복 확인
  const { data: existing } = await supabase
    .from('users')
    .select('id')
    .ilike('nickname', nickname)
    .limit(1);
  if (existing && existing.length > 0) {
    return { error: '이미 사용 중인 닉네임입니다.' };
  }

  // 메랜 닉네임 중복 확인
  const { data: existingIngame } = await supabase
    .from('users')
    .select('id')
    .ilike('ingame_nickname', ingameNickname)
    .limit(1);
  if (existingIngame && existingIngame.length > 0) {
    return { error: '이미 사용 중인 메랜 닉네임입니다.' };
  }

  // 비밀번호 해시 및 저장
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  const { data, error } = await supabase
    .from('users')
    .insert({ nickname, password_hash: passwordHash, ingame_nickname: ingameNickname })
    .select('id, nickname, ingame_nickname, elixir, equipped_avatar, character_avatar')
    .single();

  if (error) return { error: '회원가입에 실패했습니다.' };

  // 회원가입 즉시 토큰 발급 (별도 login 호출 불필요)
  const token = jwt.sign({ userId: data.id }, JWT_SECRET, { expiresIn: '7d' });
  return {
    success: true,
    token,
    user: { id: data.id, nickname: data.nickname, ingameNickname: data.ingame_nickname, elixir: data.elixir, equippedAvatar: data.equipped_avatar, characterAvatar: data.character_avatar },
  };
}

async function login(nickname, password) {
  if (!nickname || !password) return { error: '닉네임과 비밀번호를 입력해주세요.' };

  const { data, error } = await supabase
    .from('users')
    .select('id, nickname, password_hash, ingame_nickname, elixir, equipped_avatar, character_avatar')
    .ilike('nickname', nickname.trim())
    .single();

  if (error || !data) return { error: '존재하지 않는 계정입니다.' };

  const match = await bcrypt.compare(password, data.password_hash);
  if (!match) return { error: '비밀번호가 일치하지 않습니다.' };

  const token = jwt.sign({ userId: data.id }, JWT_SECRET, { expiresIn: '7d' });

  return {
    success: true,
    token,
    user: { id: data.id, nickname: data.nickname, ingameNickname: data.ingame_nickname, elixir: data.elixir, equippedAvatar: data.equipped_avatar, characterAvatar: data.character_avatar },
  };
}

async function verifyToken(token) {
  try {
    if (tokenBlacklist.has(token)) return null;
    const decoded = jwt.verify(token, JWT_SECRET);
    const { data, error } = await supabase
      .from('users')
      .select('id, nickname, ingame_nickname, elixir, equipped_avatar, character_avatar')
      .eq('id', decoded.userId)
      .single();
    if (error || !data) return null;
    return { id: data.id, nickname: data.nickname, ingameNickname: data.ingame_nickname, elixir: data.elixir, equippedAvatar: data.equipped_avatar, characterAvatar: data.character_avatar };
  } catch {
    return null;
  }
}

module.exports = { signup, login, verifyToken, blacklistToken };
