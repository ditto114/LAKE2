/**
 * 상점 / 인벤토리 모듈
 */
const supabase = require('./supabase');

const SHOP_ITEMS = [
  { id: 'elixir_plus1', name: '엘릭서 +1', desc: '엘릭서 1개를 즉시 획득합니다.', price: 0, type: 'consumable', image: null },
  { id: 'avatar_1', name: '아바타 P1', desc: '말 아바타를 P1로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P1.png' },
  { id: 'avatar_2', name: '아바타 P2', desc: '말 아바타를 P2로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P2.png' },
  { id: 'avatar_3', name: '아바타 P3', desc: '말 아바타를 P3로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P3.png' },
  { id: 'avatar_4', name: '아바타 P4', desc: '말 아바타를 P4로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P4.png' },
  { id: 'avatar_5', name: '아바타 P5', desc: '말 아바타를 P5로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P5.png' },
  { id: 'avatar_6', name: '아바타 P6', desc: '말 아바타를 P6로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P6.png' },
  { id: 'avatar_7', name: '아바타 P7', desc: '말 아바타를 P7로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P7.png' },
  { id: 'avatar_8', name: '아바타 P8', desc: '말 아바타를 P8로 변경합니다.', price: 1, type: 'avatar', image: '/assets/P8.png' },
];

async function getInventory(userId) {
  const { data, error } = await supabase
    .from('user_items')
    .select('item_id')
    .eq('user_id', userId);
  if (error || !data) return [];
  return data.map(r => r.item_id);
}

async function buyItem(userId, itemId) {
  const item = SHOP_ITEMS.find(i => i.id === itemId);
  if (!item) return { error: '존재하지 않는 상품입니다.' };

  // 현재 유저 정보 조회
  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, elixir')
    .eq('id', userId)
    .single();
  if (userErr || !user) return { error: '유저 정보를 불러올 수 없습니다.' };

  if (user.elixir < item.price) return { error: '엘릭서가 부족합니다.' };

  // 아바타: 이미 보유 중인지 확인
  if (item.type === 'avatar') {
    const owned = await getInventory(userId);
    if (owned.includes(itemId)) return { error: '이미 보유 중인 아바타입니다.' };
  }

  // 엘릭서 차감 (consumable이면 +1 적용 → 순증가 = price === 0이면 +1)
  const elixirDelta = item.type === 'consumable' ? (1 - item.price) : -item.price;
  const newElixir = user.elixir + elixirDelta;

  const { error: updateErr } = await supabase
    .from('users')
    .update({ elixir: newElixir })
    .eq('id', userId);
  if (updateErr) return { error: '구매 처리 중 오류가 발생했습니다.' };

  // 아바타: user_items에 삽입
  if (item.type === 'avatar') {
    const { error: insertErr } = await supabase
      .from('user_items')
      .insert({ user_id: userId, item_id: itemId });
    if (insertErr) return { error: '아이템 지급 중 오류가 발생했습니다.' };
  }

  const ownedItems = await getInventory(userId);
  return { success: true, elixir: newElixir, ownedItems };
}

async function equipAvatar(userId, avatarId) {
  const val = avatarId || null;
  const { error } = await supabase
    .from('users')
    .update({ equipped_avatar: val })
    .eq('id', userId);
  if (error) return { error: '장착 처리 중 오류가 발생했습니다.' };
  return { success: true, equippedAvatar: val };
}

module.exports = { SHOP_ITEMS, getInventory, buyItem, equipAvatar };
