/**
 * 랜덤 아바타 모듈
 * archive.maplestory.nexon.com 랭킹 페이지에서 아바타 URL을 크롤링하여 저장
 */
const https = require('https');
const supabase = require('./supabase');

function httpGet(url, redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (redirectCount > 5) return reject(new Error('Too many redirects'));
    https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        res.resume();
        return resolve(httpGet(next, redirectCount + 1));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

async function randomizeAvatar(userId) {
  try {
    const page = Math.floor(Math.random() * 100) + 1;
    const html = await httpGet(
      `https://archive.maplestory.nexon.com/Ranking/Phase1?page=${page}&j=0&d=0`
    );

    // 랭킹 페이지에서 /Character/180/HASH.png 패턴 추출
    const regex = /https:\/\/avatar\.maplestory\.nexon\.com\/Character\/180\/([A-Za-z0-9]+\.png)/g;
    const urls = [];
    let m;
    while ((m = regex.exec(html)) !== null) {
      // /180/ 제거 → 원본 크기 URL
      urls.push(`https://avatar.maplestory.nexon.com/Character/${m[1]}`);
    }

    if (urls.length === 0) return { error: '아바타를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.' };

    const avatarUrl = urls[Math.floor(Math.random() * urls.length)];

    const { error } = await supabase
      .from('users')
      .update({ character_avatar: avatarUrl })
      .eq('id', userId);

    if (error) return { error: '아바타 저장 중 오류가 발생했습니다.' };

    return { success: true, characterAvatarUrl: avatarUrl };
  } catch (e) {
    console.error('[avatar] randomizeAvatar error:', e.message);
    return { error: '아바타를 불러올 수 없습니다. 잠시 후 다시 시도해주세요.' };
  }
}

module.exports = { randomizeAvatar };
