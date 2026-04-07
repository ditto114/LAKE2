/**
 * 상점 / 인벤토리 모듈
 */
const supabase = require('./supabase');

const SHOP_ITEMS = [
  { id: 'random_box', name: '말 랜덤박스', desc: '랜덤으로 말 아바타 1개를 획득합니다.', price: 10, type: 'random_box', image: null },
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

  const { data: user, error: userErr } = await supabase
    .from('users')
    .select('id, elixir, elixir_spent')
    .eq('id', userId)
    .single();
  if (userErr || !user) return { error: '유저 정보를 불러올 수 없습니다.' };

  if (user.elixir < item.price) return { error: '엘릭서가 부족합니다.' };

  const newElixir = user.elixir - item.price;
  const newElixirSpent = (user.elixir_spent || 0) + item.price;

  const { error: updateErr } = await supabase
    .from('users')
    .update({ elixir: newElixir, elixir_spent: newElixirSpent })
    .eq('id', userId);
  if (updateErr) return { error: '구매 처리 중 오류가 발생했습니다.' };

  // 랜덤박스: P1~P8 랜덤 선택 후 지급
  const n = Math.floor(Math.random() * 8) + 1;
  const obtainedId = 'avatar_' + n;
  const { error: insertErr } = await supabase
    .from('user_items')
    .insert({ user_id: userId, item_id: obtainedId });
  if (insertErr) return { error: '아이템 지급 중 오류가 발생했습니다.' };

  const ownedItems = await getInventory(userId);
  return { success: true, elixir: newElixir, ownedItems, obtained: obtainedId };
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
