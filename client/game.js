// Client game lớp học ảo Tiểu Tiểu — giai đoạn khung.
// Vẽ lớp học pixel bằng canvas, di chuyển nhân vật, đồng bộ người chơi khác qua Socket.io.

const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
// Kích thước thế giới lớp học (cố định, khớp với server); canvas có thể nhỏ hơn để làm camera.
const W = 960;
const H = 540;
const view = { zoom: 1, camX: 0, camY: 0, ready: false };

function updateView() {
  const narrow = window.innerWidth <= 700;
  const topbar = document.getElementById('topbar');
  if (topbar && topbar.offsetHeight) {
    document.documentElement.style.setProperty('--topbar-h', topbar.offsetHeight + 'px');
  }
  let width = 960;
  let height = 540;
  let zoom = 1;
  if (narrow) {
    // Fill the phone viewport with the classroom; the camera follows the player across it.
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || window.innerWidth;
    const cssH = canvas.clientHeight || Math.max(400, window.innerHeight - 100);
    width = Math.round(cssW * dpr);
    height = Math.round(cssH * dpr);
    zoom = Math.max(cssW / W, cssH / H) * 0.78 * dpr;
    canvas.style.aspectRatio = 'auto';
  } else {
    canvas.style.aspectRatio = '16 / 9';
  }
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  view.zoom = zoom;
  view.ready = false;
}
updateView();
window.addEventListener('resize', updateView);
window.addEventListener('orientationchange', updateView);
if (window.ResizeObserver) new ResizeObserver(updateView).observe(document.getElementById('topbar'));

let socket = null;
let me = null;                 // nhân vật của mình {id, name, x, y, color}
let worldUser = null;
let authMode = 'login';
let quizState = { status: 'idle' };
let hanziState = { status: 'idle' };
let importedQuizQuestions = [];
let importedHanziQuestions = [];
let quizAnswerLocked = false;
let displayedQuizQuestion = 0;
let gameCountdownTimer = null;
let lastExpiredRoundRequest = null;
let quizFallbackDeadline = null;
let hanziFallbackDeadline = null;
const others = new Map();      // id -> player
const bubbles = new Map();     // id -> {text, until}
const keys = {};
let lastSent = 0;

const SPEED = 170; // px/giây
const AVATAR_COLORS = {
  hairColor: { black: '#201b1a', brown: '#513624', chestnut: '#854c31', blonde: '#d8ad4c' },
  shirtColor: { blue: '#4d83b6', red: '#b94a42', green: '#53815b', yellow: '#d4a948', purple: '#785d98' },
  pantsColor: { gray: '#64676a', navy: '#293f62', brown: '#76533a', black: '#292b30' },
  backpack: { brown: '#70452c', red: '#a6362e', blue: '#345c8b' },
};

const AVATAR_OUTLINE = '#2a1a22';

function shadeColor(hex, amount) {
  const value = parseInt(String(hex).replace('#', ''), 16);
  if (Number.isNaN(value)) return hex;
  const target = amount < 0 ? 0 : 255;
  const mix = Math.abs(amount);
  const channel = (shift) => {
    const c = (value >> shift) & 255;
    return Math.round(c + (target - c) * mix);
  };
  return `rgb(${channel(16)}, ${channel(8)}, ${channel(0)})`;
}

// Nhân vật pixel chibi có viền, đổ bóng, highlight và hỗ trợ đầy đủ trang bị cửa hàng.
function drawAvatar(context, character, fallbackColor, x, y, scale = 1, motion = null) {
  const avatar = character || {};
  const eq = (avatar.equipped && typeof avatar.equipped === 'object') ? avatar.equipped : {};
  const nowMs = (motion && typeof motion.now === 'number') ? motion.now : performance.now();
  const hair = AVATAR_COLORS.hairColor[avatar.hairColor] || AVATAR_COLORS.hairColor.black;
  const shirt = AVATAR_COLORS.shirtColor[avatar.shirtColor] || fallbackColor || AVATAR_COLORS.shirtColor.blue;
  const pants = AVATAR_COLORS.pantsColor[avatar.pantsColor] || AVATAR_COLORS.pantsColor.gray;
  const skin = '#ffdcb8';
  const skinShade = '#eeb68c';
  const hairLight = shadeColor(hair, 0.3);
  const hairDark = shadeColor(hair, -0.32);
  const shirtLight = shadeColor(shirt, 0.25);
  const shirtDark = shadeColor(shirt, -0.28);
  const pantsLight = shadeColor(pants, 0.22);
  const pantsDark = shadeColor(pants, -0.3);
  const OUT = AVATAR_OUTLINE;

  const rect = (rx, ry, w, h, color) => {
    context.fillStyle = color;
    context.fillRect(rx, ry, w, h);
  };
  const box = (rx, ry, w, h, color) => {
    rect(rx - 1, ry - 1, w + 2, h + 2, OUT);
    rect(rx, ry, w, h, color);
  };

  context.save();
  context.translate(x, y);
  context.scale(scale, scale);
  const stride = motion && motion.walking ? Math.sin(motion.phase) * 0.34 : 0;
  const armSwing = motion && motion.walking ? Math.sin(motion.phase) * 0.24 : 0;
  const flap = Math.sin(nowMs / 240);

  const longHair = avatar.hairStyle === 'long';
  const female = avatar.gender === 'female';
  const outfit = eq.outfit || null;
  const topItem = outfit ? null : (eq.top || null);
  const bottomItem = outfit ? null : (eq.bottom || null);
  const shoesItem = eq.shoes || null;
  const bagItem = eq.bag || null;
  const glassesItem = eq.glasses || null;
  const hatItem = eq.hat || null;
  const neckItem = eq.neck || null;
  const bowItem = eq.bow || null;
  const wingsItem = eq.wings || null;
  const petItem = eq.pet || null;

  // --- 0. CÁNH (WINGS) có hiệu ứng pixel nhẹ phía sau ---
  if (wingsItem) {
    const wy = Math.round(flap * 1.4);
    if (wingsItem === 'cloud-wings') {
      for (const s of [-1, 1]) {
        const bx = s < 0 ? -24 : 11;
        box(bx, -13 + wy, 13, 9, '#eef8ff');
        box(bx + (s < 0 ? 3 : -2), -7 + wy, 11, 7, '#d6eeff');
        rect(bx + 1, -12 + wy, 11, 3, '#ffffff');
        rect(bx + 2, -5 + wy, 8, 2, '#b3ddf8');
      }
      rect(-26, -15 - wy, 2, 2, 'rgba(255,255,255,0.85)');
      rect(24, -4 + wy, 2, 2, 'rgba(195,235,255,0.85)');
    } else if (wingsItem === 'butterfly-wings') {
      for (const s of [-1, 1]) {
        const uX = s < 0 ? -25 : 11;
        const lX = s < 0 ? -22 : 11;
        box(uX, -16 + wy, 14, 11, '#ff6fae');
        rect(uX + 2, -14 + wy, 10, 7, '#ffd25a');
        rect(uX + 4, -12 + wy, 6, 3, '#fff5b8');
        box(lX, -4 + wy, 11, 9, '#55d6ff');
        rect(lX + 2, -2 + wy, 7, 5, '#b8f2ff');
      }
      rect(-27, -18 - wy, 2, 2, '#ffe875');
      rect(25, -16 + wy, 2, 2, '#ff92c4');
    } else if (wingsItem === 'angel-wings') {
      for (const s of [-1, 1]) {
        const bx = s < 0 ? -26 : 11;
        box(bx, -16 + wy, 15, 8, '#fffdf7');
        box(bx + (s < 0 ? 2 : 0), -8 + wy, 13, 6, '#f6efe0');
        box(bx + (s < 0 ? 5 : 0), -2 + wy, 10, 5, '#eadbc0');
        rect(bx + 1, -16 + wy, 13, 2, '#f5c84c');
        rect(bx + 2, -14 + wy, 11, 3, '#ffffff');
      }
      rect(-5, -42 + Math.round(flap), 10, 2, '#ffe066');
      rect(-7, -41 + Math.round(flap), 2, 2, '#ffe066');
      rect(5, -41 + Math.round(flap), 2, 2, '#ffe066');
      rect(-28, -12 - wy, 2, 2, '#fff3a1');
      rect(26, -7 + wy, 2, 2, '#fff3a1');
    } else if (wingsItem === 'fairy-wings') {
      for (const s of [-1, 1]) {
        const bx = s < 0 ? -24 : 11;
        box(bx, -16 + wy, 13, 10, '#72f2ce');
        rect(bx + 1, -15 + wy, 11, 8, '#c4ffec');
        box(bx + (s < 0 ? 3 : 0), -5 + wy, 10, 8, '#48d1b5');
        rect(bx + (s < 0 ? 4 : 1), -4 + wy, 8, 6, '#a8ffea');
      }
      rect(-26, -9 + wy, 2, 2, '#a8ffea');
      rect(25, -15 - wy, 2, 2, '#a8ffea');
    } else if (wingsItem === 'astro-jet-wings') {
      for (const s of [-1, 1]) {
        const bx = s < 0 ? -26 : 11;
        box(bx, -14 + wy, 15, 6, '#2a3550');
        rect(bx + 1, -13 + wy, 13, 2, '#4df0ff');
        box(bx + (s < 0 ? 3 : 0), -7 + wy, 12, 5, '#3b4a6b');
        rect(bx + (s < 0 ? 4 : 1), -6 + wy, 10, 2, '#a864ff');
        rect(bx + (s < 0 ? 6 : 2), -1 + wy, 6, 4, '#38f6ff');
      }
      rect(-27, -4 - wy, 2, 2, '#4df0ff');
      rect(26, -12 + wy, 2, 2, '#a864ff');
    }
  }

  // --- 1. Tóc sau lưng (tóc dài) ---
  if (longHair) {
    box(-12, -27, 24, 27, hair);
    rect(-11, -26, 3, 25, hairLight);
    rect(8, -26, 3, 25, hairDark);
    rect(-12, -2, 24, 2, hairDark);
  }

  // --- 2. Balo / Túi đeo (equipped bag hoặc mặc định) ---
  if (bagItem === 'blue-backpack') {
    box(-18, -6, 9, 20, '#2e6eb5');
    rect(-17, -5, 2, 18, '#5ca0e8');
    box(-17, 6, 6, 6, '#1f4e84');
    rect(-16, 8, 4, 2, '#f5d469');
  } else if (bagItem === 'panda-backpack') {
    box(-19, -6, 10, 19, '#f7f7f9');
    box(-19, -9, 4, 4, '#201d24');
    box(-13, -9, 4, 4, '#201d24');
    rect(-17, -2, 3, 3, '#201d24');
    rect(-13, -2, 2, 3, '#201d24');
    rect(-18, 5, 8, 6, '#201d24');
  } else if (bagItem === 'bamboo-backpack') {
    box(-19, -5, 10, 19, '#9e7340');
    for (const by of [-2, 2, 6, 10]) rect(-18, by, 8, 1, '#c99c62');
    box(-17, -13, 3, 8, '#3b9447');
    box(-13, -11, 3, 6, '#4cb058');
    rect(-20, -12, 3, 2, '#68cc6e');
  } else if (bagItem === 'lantern-bag') {
    rect(-20, -14, 1, 14, '#7a3e18');
    box(-24, -6 + Math.round(flap), 11, 11, '#e62e2d');
    rect(-22, -4 + Math.round(flap), 7, 7, '#ffd447');
    rect(-20, -2 + Math.round(flap), 3, 3, '#fff9c4');
    rect(-20, 6 + Math.round(flap), 3, 5, '#e62e2d');
  } else if (bagItem === 'lixi-bag') {
    box(-19, -4, 10, 16, '#c81e24');
    rect(-18, -3, 8, 3, '#f5c542');
    rect(-16, 2, 4, 4, '#f5c542');
    rect(-15, 3, 2, 2, '#c81e24');
  } else if (bagItem === 'astro-jetpack') {
    box(-19, -7, 6, 18, '#d8e1eb');
    box(-13, -7, 5, 18, '#b0becc');
    rect(-18, -2, 10, 3, '#e03c3c');
    rect(-18, 11, 4, 4 + Math.round(Math.abs(flap) * 2), '#38f6ff');
    rect(-12, 11, 3, 4 + Math.round(Math.abs(flap) * 2), '#38f6ff');
  } else {
    const bagColor = AVATAR_COLORS.backpack[avatar.backpack];
    if (avatar.backpack && avatar.backpack !== 'none' && bagColor) {
      box(-18, -5, 9, 20, bagColor);
      rect(-17, -4, 2, 18, shadeColor(bagColor, 0.3));
      box(-17, 7, 6, 6, shadeColor(bagColor, -0.22));
      rect(-16, 9, 4, 1, shadeColor(bagColor, 0.2));
      box(-18, -7, 9, 3, shadeColor(bagColor, -0.12));
    }
  }

  // --- 3. Chân + Quần / Váy ---
  let legColor = pants;
  let legLight = pantsLight;
  let legDark = pantsDark;
  if (outfit === 'panda-suit') {
    legColor = '#201d24'; legLight = '#3c3742'; legDark = '#121015';
  } else if (outfit === 'astro-suit') {
    legColor = '#e2e8f0'; legLight = '#ffffff'; legDark = '#94a3b8';
  } else if (outfit === 'tet-aodai-red') {
    legColor = '#fff3d6'; legLight = '#ffffff'; legDark = '#dec492';
  } else if (outfit === 'tet-aodai-gold') {
    legColor = '#b81d24'; legLight = '#db3b42'; legDark = '#7d1116';
  } else if (outfit === 'festival-outfit' || outfit === 'trungthu-outfit') {
    legColor = '#2b2430'; legLight = '#463b4d'; legDark = '#18141b';
  } else if (bottomItem === 'jean-pants') {
    legColor = '#2b5b9e'; legLight = '#4c80c9'; legDark = '#1b3d6e';
  }

  for (const [lx, pivot, angle] of [[-8, -4.5, stride], [1, 4.5, -stride]]) {
    context.save();
    context.translate(pivot, 9);
    context.rotate(angle);
    context.translate(-pivot, -9);
    if (bottomItem === 'kaki-shorts' || bottomItem === 'plaid-skirt' || outfit === 'sailor-uniform') {
      box(lx, 9, 7, 11, skin);
      rect(lx + 4, 10, 2, 9, skinShade);
      if (bottomItem === 'kaki-shorts') {
        box(lx, 9, 7, 6, '#c8a878');
        rect(lx + 1, 10, 2, 4, '#dfc396');
      } else {
        // tất trắng học sinh
        rect(lx, 15, 7, 5, '#ffffff');
        rect(lx, 15, 7, 1, '#2b5b9e');
      }
    } else {
      box(lx, 9, 7, 11, legColor);
      rect(lx + 1, 10, 2, 9, legLight);
      rect(lx + 5, 10, 2, 9, legDark);
      if (bottomItem === 'jean-pants') {
        rect(lx, 18, 7, 2, '#78a9e6');
      }
    }
    context.restore();
  }

  // Chân váy (nếu mặc plaid-skirt hoặc sailor-uniform)
  if (bottomItem === 'plaid-skirt' || outfit === 'sailor-uniform') {
    const skColor = outfit === 'sailor-uniform' ? '#1e325c' : '#b82532';
    const skStripe = outfit === 'sailor-uniform' ? '#ffffff' : '#26232c';
    box(-10, 8, 20, 7, skColor);
    for (const sx of [-7, -3, 1, 5]) rect(sx, 8, 2, 7, skStripe);
    rect(-10, 13, 20, 1, '#f4d068');
  }

  // --- 4. Giày ---
  const effectiveShoes = shoesItem
    || (outfit === 'astro-suit' ? 'glow-shoes' : (outfit === 'panda-suit' ? 'panda-paws' : avatar.shoesStyle));

  if (effectiveShoes === 'red-sneakers') {
    for (const [bx, pivot, angle] of [[-9, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 19, 9, 5, '#d62828');
      rect(bx + 1, 19, 4, 2, '#ffffff');
      rect(bx, 22, 9, 2, '#f4f4f6');
      context.restore();
    }
  } else if (effectiveShoes === 'leather-boots' || effectiveShoes === 'boots') {
    for (const [bx, pivot, angle] of [[-8, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 14, 7, 8, '#6e4228');
      rect(bx + 1, 15, 2, 6, '#9c6340');
      rect(bx, 14, 7, 2, '#d4a24c');
      box(bx - 1, 20, 9, 4, '#3d2214');
      context.restore();
    }
  } else if (effectiveShoes === 'glow-shoes') {
    for (const [bx, pivot, angle] of [[-9, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 18, 9, 6, '#dce4ee');
      rect(bx + 1, 19, 7, 2, '#64748b');
      rect(bx, 22, 9, 2, '#38f6ff');
      context.restore();
    }
  } else if (effectiveShoes === 'panda-paws') {
    for (const [bx, pivot, angle] of [[-9, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 19, 9, 5, '#201d24');
      rect(bx + 2, 19, 5, 2, '#ffffff');
      context.restore();
    }
  } else if (effectiveShoes === 'sandals') {
    for (const [bx, pivot, angle] of [[-8, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 20, 7, 3, skin);
      rect(bx + 1, 20, 1, 3, '#b0703f');
      rect(bx + 4, 20, 1, 3, '#b0703f');
      rect(bx - 1, 23, 9, 1, '#b0703f');
      context.restore();
    }
  } else {
    for (const [bx, pivot, angle] of [[-9, -4.5, stride], [1, 4.5, -stride]]) {
      context.save();
      context.translate(pivot, 9);
      context.rotate(angle);
      context.translate(-pivot, -9);
      box(bx, 19, 9, 5, '#f4f4f6');
      rect(bx, 22, 9, 2, '#8d96ad');
      rect(bx + 1, 19, 3, 1, '#c9ccd8');
      rect(bx + (bx < 0 ? 5 : 3), 20, 3, 1, '#8d96ad');
      context.restore();
    }
  }

  // --- 5. Thân áo & Tay áo (theo outfit / topItem / mặc định) ---
  let bodyColor = shirt;
  let bodyLight = shirtLight;
  let bodyDark = shirtDark;
  let sleeveColor = shirt;
  const isHoodie = topItem === 'school-hoodie' || topItem === 'panda-hoodie' || (!topItem && !outfit && avatar.shirtStyle === 'hoodie');

  if (topItem === 'school-hoodie') {
    bodyColor = '#2563eb'; bodyLight = '#60a5fa'; bodyDark = '#1d4ed8'; sleeveColor = '#2563eb';
  } else if (topItem === 'white-school-shirt') {
    bodyColor = '#f8fafc'; bodyLight = '#ffffff'; bodyDark = '#cbd5e1'; sleeveColor = '#f8fafc';
  } else if (topItem === 'red-bomber') {
    bodyColor = '#c82829'; bodyLight = '#ef4444'; bodyDark = '#881313'; sleeveColor = '#f5ebd6';
  } else if (topItem === 'panda-hoodie') {
    bodyColor = '#f8fafc'; bodyLight = '#ffffff'; bodyDark = '#cbd5e1'; sleeveColor = '#201d24';
  } else if (outfit === 'sailor-uniform') {
    bodyColor = '#1e325c'; bodyLight = '#324e85'; bodyDark = '#121f3d'; sleeveColor = '#1e325c';
  } else if (outfit === 'panda-suit') {
    bodyColor = '#201d24'; bodyLight = '#3a3540'; bodyDark = '#120f16'; sleeveColor = '#201d24';
  } else if (outfit === 'festival-outfit') {
    bodyColor = '#c91f28'; bodyLight = '#e63e46'; bodyDark = '#871016'; sleeveColor = '#c91f28';
  } else if (outfit === 'tet-aodai-red') {
    bodyColor = '#d6242c'; bodyLight = '#f04850'; bodyDark = '#8f1117'; sleeveColor = '#d6242c';
  } else if (outfit === 'tet-aodai-gold') {
    bodyColor = '#eab338'; bodyLight = '#fde07b'; bodyDark = '#b37d14'; sleeveColor = '#eab338';
  } else if (outfit === 'trungthu-outfit') {
    bodyColor = '#1f8a70'; bodyLight = '#42b89b'; bodyDark = '#125947'; sleeveColor = '#1f8a70';
  } else if (outfit === 'astro-suit') {
    bodyColor = '#e2e8f0'; bodyLight = '#ffffff'; bodyDark = '#94a3b8'; sleeveColor = '#e2e8f0';
  }

  if (isHoodie) {
    box(-9, -12, 18, 6, topItem === 'panda-hoodie' ? '#201d24' : shadeColor(bodyColor, -0.15));
  }

  // Thân chính
  box(-10, -8, 20, 18, bodyColor);
  rect(-9, -7, 3, 16, bodyLight);
  rect(6, -7, 3, 16, bodyDark);
  rect(-10, 8, 20, 2, bodyDark);

  // Tà áo dài (nếu mặc Áo dài Tết)
  if (outfit === 'tet-aodai-red' || outfit === 'tet-aodai-gold') {
    box(-6, 7, 12, 10, bodyColor);
    rect(-5, 7, 10, 1, '#f5c542');
    // Hoa mai thêu trên tà áo
    rect(1, 11, 3, 3, outfit === 'tet-aodai-red' ? '#ffd447' : '#d6242c');
    rect(-3, 13, 2, 2, outfit === 'tet-aodai-red' ? '#ffd447' : '#d6242c');
  }

  // Hoạ tiết riêng cho từng loại áo/trang phục
  if (topItem === 'school-hoodie') {
    box(-6, 3, 12, 5, bodyDark);
    rect(-3, -7, 1, 7, '#ffd447');
    rect(2, -7, 1, 7, '#ffd447');
    rect(3, -4, 4, 3, '#ffd447');
  } else if (topItem === 'white-school-shirt') {
    rect(-5, -9, 4, 4, '#ffffff');
    rect(1, -9, 4, 4, '#ffffff');
    rect(-1, -7, 2, 11, '#c81e24');
    rect(-2, 2, 4, 3, '#c81e24');
    rect(3, -3, 4, 3, '#1e3a8a');
  } else if (topItem === 'red-bomber') {
    rect(-2, -8, 4, 18, '#f5ebd6');
    rect(0, -8, 1, 18, '#475569');
    rect(-10, 7, 20, 3, '#201d24');
    rect(-9, 8, 18, 1, '#ffffff');
    rect(3, -4, 4, 4, '#ffd447');
  } else if (topItem === 'panda-hoodie') {
    rect(-10, -8, 20, 4, '#201d24');
    box(-6, 2, 12, 6, '#201d24');
    rect(-4, 4, 8, 2, '#ffffff');
    rect(3, -3, 3, 3, '#4cb058');
  } else if (outfit === 'sailor-uniform') {
    rect(-8, -8, 16, 5, '#ffffff');
    rect(-8, -5, 16, 1, '#2563eb');
    rect(-3, -4, 6, 4, '#e11d48');
    rect(-1, 0, 2, 3, '#e11d48');
  } else if (outfit === 'panda-suit') {
    rect(-6, -4, 12, 11, '#ffffff');
    rect(-5, -3, 10, 9, '#f1f5f9');
  } else if (outfit === 'festival-outfit') {
    rect(-2, -8, 4, 18, '#f5c542');
    for (const by of [-5, -1, 3]) rect(-4, by, 8, 1, '#fff3b0');
    rect(-10, 6, 20, 3, '#f5c542');
  } else if (outfit === 'tet-aodai-red' || outfit === 'tet-aodai-gold') {
    const trim = outfit === 'tet-aodai-red' ? '#ffd447' : '#c81e24';
    rect(-4, -9, 8, 2, trim);
    for (let i = 0; i < 5; i += 1) rect(-2 + i, -7 + i, 2, 1, trim);
  } else if (outfit === 'trungthu-outfit') {
    rect(-4, -8, 8, 6, '#e11d48');
    rect(-10, 4, 20, 4, '#e11d48');
    rect(-3, 4, 6, 4, '#ffd447');
  } else if (outfit === 'astro-suit') {
    box(-5, -5, 10, 7, '#1e293b');
    rect(-4, -4, 3, 2, '#38f6ff');
    rect(1, -4, 3, 2, '#ef4444');
    rect(-4, -1, 8, 2, '#22c55e');
    rect(-10, 5, 20, 3, '#475569');
    rect(-2, 5, 4, 3, '#ffd447');
  } else if (avatar.shirtStyle === 'hoodie') {
    box(-6, 3, 12, 5, bodyDark);
    rect(-5, 4, 10, 1, shadeColor(bodyColor, -0.4));
    rect(-3, -7, 1, 7, '#f2f2f2');
    rect(2, -7, 1, 7, '#f2f2f2');
  } else {
    rect(-5, -9, 4, 4, '#ffffff');
    rect(1, -9, 4, 4, '#ffffff');
    for (const by of [-3, 1, 5]) rect(0, by, 1, 1, bodyDark);
  }

  // Tay trái & phải
  const slDark = shadeColor(sleeveColor, -0.25);
  context.save();
  context.translate(-12, -7);
  context.rotate(-armSwing);
  context.translate(12, 7);
  box(-14, -7, 5, 13, sleeveColor);
  rect(-14, 4, 5, 2, slDark);
  box(-14, 6, 5, 4, outfit === 'panda-suit' ? '#201d24' : skin);
  context.restore();

  context.save();
  context.translate(11, -7);
  context.rotate(armSwing);
  context.translate(-11, 7);
  box(9, -7, 5, 13, sleeveColor);
  rect(9, 4, 5, 2, slDark);
  box(9, 6, 5, 4, outfit === 'panda-suit' ? '#201d24' : skin);
  context.restore();

  // --- 6. Cổ & Khăn quàng (neckItem hoặc mặc định) ---
  rect(-3, -11, 6, 4, skin);
  rect(-3, -9, 6, 1, skinShade);

  if (neckItem === 'red-scarf') {
    box(-9, -10, 18, 4, '#e11d48');
    box(-4, -6, 4, 9, '#e11d48');
    box(0, -6, 4, 7, '#be123c');
    rect(-1, -7, 2, 2, '#ffd447');
  } else if (neckItem === 'winter-wool-scarf') {
    box(-9, -10, 18, 5, '#f59e0b');
    for (const sx of [-7, -2, 3]) rect(sx, -10, 2, 5, '#fef3c7');
    box(2, -5, 5, 12, '#f59e0b');
    rect(2, -2, 5, 2, '#fef3c7');
    rect(2, 3, 5, 2, '#fef3c7');
  } else if (!neckItem && avatar.accessory === 'scarf') {
    rect(-8, -10, 16, 6, OUT);
    rect(-7, -9, 14, 4, '#d94a3d');
    rect(-7, -7, 14, 1, '#f6d77f');
    rect(2, -4, 6, 14, OUT);
    rect(3, -4, 4, 13, '#d94a3d');
  }

  // --- 7. Tai & Đầu & Mắt ---
  box(-13, -22, 3, 5, skin);
  box(10, -22, 3, 5, skin);

  rect(-11, -29, 22, 18, OUT);
  rect(-9, -32, 18, 23, OUT);
  rect(-10, -28, 20, 16, skin);
  rect(-8, -31, 16, 21, skin);
  rect(-8, -11, 16, 1, skinShade);
  rect(6, -22, 3, 10, skinShade);
  rect(-8, -12, 16, 1, '#f6c9a2');

  const face = avatar.faceStyle;
  const brow = hairDark;
  if (face === 'B') {
    for (const ex of [-6, 3]) {
      rect(ex, -18, 1, 1, '#2a1a22');
      rect(ex + 1, -19, 2, 1, '#2a1a22');
      rect(ex + 3, -18, 1, 1, '#2a1a22');
    }
    rect(-8, -15, 3, 2, '#ff9aa5');
    rect(5, -15, 3, 2, '#ff9aa5');
    rect(-6, -22, 3, 1, brow);
    rect(3, -22, 3, 1, brow);
    rect(-1, -14, 3, 2, '#7a2a30');
    rect(0, -13, 1, 1, '#ff8a96');
  } else if (face === 'C') {
    for (const ex of [-6, 3]) {
      rect(ex, -20, 4, 4, '#ffffff');
      rect(ex + 1, -19, 3, 3, '#2a3a5a');
      rect(ex + 2, -18, 1, 1, '#9fc4f0');
      rect(ex, -21, 4, 1, '#2a1a22');
    }
    rect(-7, -24, 5, 1, brow);
    rect(2, -24, 5, 1, brow);
    rect(-1, -14, 3, 1, '#b0533f');
    rect(1, -15, 1, 1, '#b0533f');
  } else {
    for (const ex of [-6, 3]) {
      rect(ex, -21, 3, 5, '#2a1a22');
      rect(ex, -18, 3, 2, '#5b3d8a');
      rect(ex + 1, -21, 1, 2, '#ffffff');
      rect(ex + 2, -17, 1, 1, '#ffffff');
    }
    rect(-6, -24, 3, 1, brow);
    rect(3, -24, 3, 1, brow);
    rect(-2, -15, 1, 1, '#b0533f');
    rect(-1, -14, 2, 1, '#b0533f');
    rect(1, -15, 1, 1, '#b0533f');
    rect(-8, -15, 2, 1, '#ffb3a7');
    rect(6, -15, 2, 1, '#ffb3a7');
  }
  rect(0, -16, 1, 1, skinShade);

  // --- 8. Tóc trước ---
  rect(-12, -31, 24, 9, OUT);
  rect(-10, -35, 20, 13, OUT);
  rect(-12, -27, 4, 11, OUT);
  rect(8, -27, 4, 9, OUT);
  rect(-11, -30, 22, 7, hair);
  rect(-9, -34, 18, 11, hair);
  rect(-11, -27, 3, 10, hair);
  rect(8, -27, 3, 8, hair);
  rect(-8, -23, 5, 2, hair);
  rect(-3, -23, 4, 3, hair);
  rect(1, -23, 3, 2, hair);
  rect(4, -23, 4, 1, hair);
  rect(-7, -33, 8, 1, hairLight);
  rect(-8, -31, 3, 1, hairLight);
  rect(2, -32, 3, 1, hairLight);
  rect(-9, -24, 1, 6, hairLight);
  rect(9, -26, 1, 7, hairDark);
  rect(-8, -22, 16, 1, hairDark);

  if (longHair) {
    rect(-12, -18, 4, 14, OUT);
    rect(8, -18, 4, 14, OUT);
    rect(-11, -19, 3, 14, hair);
    rect(8, -19, 3, 14, hair);
    rect(-10, -15, 1, 8, hairLight);
    rect(10, -15, 1, 8, hairDark);
  } else if (female) {
    rect(10, -28, 6, 12, OUT);
    rect(11, -27, 4, 10, hair);
    rect(11, -27, 1, 8, hairLight);
    rect(10, -25, 6, 2, '#e8587a');
    rect(11, -17, 3, 3, hair);
  } else {
    rect(-4, -38, 4, 5, OUT);
    rect(1, -39, 5, 6, OUT);
    rect(-3, -37, 2, 4, hair);
    rect(2, -38, 3, 5, hair);
    rect(2, -38, 1, 3, hairLight);
  }

  // --- 9. Kính (glassesItem hoặc mặc định) ---
  const activeGlasses = glassesItem || (avatar.accessory === 'glasses' ? 'round-glasses' : null);
  if (activeGlasses === 'round-glasses') {
    const frame = '#3a2a24';
    for (const gx of [-9, 1]) {
      rect(gx, -23, 8, 1, frame);
      rect(gx, -17, 8, 1, frame);
      rect(gx, -23, 1, 7, frame);
      rect(gx + 7, -23, 1, 7, frame);
      rect(gx + 1, -22, 6, 5, 'rgba(190, 225, 255, .28)');
      rect(gx + 2, -21, 2, 1, 'rgba(255, 255, 255, .75)');
    }
    rect(-1, -20, 2, 1, frame);
  } else if (activeGlasses === 'star-glasses') {
    for (const gx of [-9, 1]) {
      box(gx, -23, 8, 6, '#ffd447');
      rect(gx + 1, -22, 6, 4, '#ff4d94');
      rect(gx + 2, -21, 2, 2, '#fff5b8');
    }
    rect(-1, -20, 2, 2, '#ffd447');
  } else if (activeGlasses === 'sun-glasses') {
    rect(-10, -22, 20, 2, '#111115');
    for (const gx of [-9, 1]) {
      rect(gx, -22, 8, 6, '#111115');
      rect(gx + 1, -21, 2, 1, '#ffffff');
      rect(gx + 3, -20, 2, 1, '#ffffff');
    }
  }

  // --- 10. Nơ cài tóc (bowItem hoặc mặc định) ---
  const activeBow = bowItem || (avatar.accessory === 'bow' ? 'silk-ribbon-bow' : null);
  if (activeBow === 'silk-ribbon-bow') {
    rect(3, -38, 12, 7, OUT);
    rect(4, -37, 4, 5, '#e11d48');
    rect(10, -37, 4, 5, '#e11d48');
    rect(8, -36, 2, 3, '#ffd447');
    rect(4, -37, 4, 1, '#ff8fa3');
    rect(10, -37, 4, 1, '#ff8fa3');
  } else if (activeBow === 'gold-hair-bow') {
    box(3, -39, 13, 7, '#ffd447');
    rect(4, -38, 5, 5, '#fff3b0');
    rect(10, -38, 5, 5, '#fff3b0');
    rect(8, -37, 3, 3, '#e11d48');
    rect(12, -31, 2, 6, '#ffd447');
  }

  // --- 11. Nón / Mũ (hatItem) ---
  if (hatItem === 'non-la') {
    // Nón lá hình chóp
    box(-18, -31, 36, 3, '#e8cfa0');
    box(-14, -35, 28, 4, '#f2deb6');
    box(-10, -39, 20, 4, '#e5c896');
    box(-5, -43, 10, 4, '#f2deb6');
    box(-2, -46, 4, 3, '#d4b27a');
    rect(-14, -32, 28, 1, '#b89258');
    rect(-10, -36, 20, 1, '#b89258');
    // Quai lụa hồng
    rect(-8, -14, 2, 3, '#ff6fae');
    rect(6, -14, 2, 3, '#ff6fae');
  } else if (hatItem === 'tet-khan-dong') {
    box(-12, -38, 24, 9, '#b81d24');
    rect(-11, -37, 22, 2, '#ffd447');
    rect(-11, -33, 22, 2, '#e63946');
    box(-3, -36, 6, 5, '#ffd447');
    rect(-1, -35, 2, 3, '#b81d24');
  } else if (hatItem === 'trungthu-rabbit-ears') {
    box(-9, -35, 18, 3, '#ffffff');
    box(-8, -48, 5, 13, '#ffffff');
    rect(-7, -46, 3, 9, '#ff9ebb');
    box(3, -48, 5, 13, '#ffffff');
    rect(4, -46, 3, 9, '#ff9ebb');
    rect(-2, -35, 4, 3, '#ffd447');
  } else if (hatItem === 'grad-cap') {
    box(-11, -36, 22, 5, '#1e293b');
    box(-16, -40, 32, 4, '#0f172a');
    rect(-15, -39, 30, 1, '#334155');
    rect(12, -36, 2, 9, '#ffd447');
    rect(11, -28, 4, 3, '#ffd447');
  } else if (hatItem === 'panda-ears-hat') {
    box(-12, -37, 24, 8, '#ffffff');
    box(-13, -43, 6, 6, '#201d24');
    box(7, -43, 6, 6, '#201d24');
    rect(-7, -35, 4, 3, '#201d24');
    rect(3, -35, 4, 3, '#201d24');
  } else if (hatItem === 'astro-helmet') {
    box(-13, -37, 26, 8, '#e2e8f0');
    rect(-12, -36, 24, 2, '#38f6ff');
    rect(-11, -28, 22, 16, 'rgba(120, 235, 255, 0.25)');
    rect(-9, -27, 5, 3, 'rgba(255, 255, 255, 0.75)');
    box(11, -43, 2, 7, '#94a3b8');
    rect(10, -45, 4, 3, '#38f6ff');
  }

  // --- 12. THÚ CƯNG (PET) đi theo bên cạnh nhân vật ---
  if (petItem) {
    const px = 21;
    const py = 10 + Math.round(Math.sin(nowMs / 190) * 1.6);
    context.fillStyle = 'rgba(0,0,0,0.22)';
    context.fillRect(px - 6, 20, 12, 3);

    if (petItem === 'panda-pet') {
      box(px - 6, py - 8, 12, 10, '#ffffff');
      box(px - 7, py - 11, 4, 4, '#201d24');
      box(px + 3, py - 11, 4, 4, '#201d24');
      rect(px - 4, py - 5, 3, 3, '#201d24');
      rect(px + 1, py - 5, 3, 3, '#201d24');
      rect(px - 1, py - 2, 2, 1, '#201d24');
      box(px - 5, py + 2, 10, 6, '#201d24');
      rect(px - 3, py + 3, 6, 4, '#ffffff');
      rect(px + 5, py - 2, 2, 7, '#4cb058');
    } else if (petItem === 'orange-cat-pet') {
      box(px - 6, py - 7, 12, 9, '#f59e0b');
      box(px - 6, py - 10, 3, 3, '#d97706');
      box(px + 3, py - 10, 3, 3, '#d97706');
      rect(px - 4, py - 4, 2, 2, '#201d24');
      rect(px + 2, py - 4, 2, 2, '#201d24');
      rect(px - 1, py - 2, 2, 1, '#ff8fa3');
      box(px - 5, py + 2, 10, 6, '#f59e0b');
      rect(px - 3, py + 3, 6, 4, '#fef3c7');
      box(px + 5, py - 1, 3, 7, '#d97706');
    } else if (petItem === 'jade-rabbit-pet') {
      box(px - 6, py - 7, 12, 9, '#ffffff');
      box(px - 5, py - 14, 3, 7, '#ffffff');
      rect(px - 4, py - 13, 1, 5, '#ff9ebb');
      box(px + 2, py - 14, 3, 7, '#ffffff');
      rect(px + 3, py - 13, 1, 5, '#ff9ebb');
      rect(px - 4, py - 4, 2, 2, '#e11d48');
      rect(px + 2, py - 4, 2, 2, '#e11d48');
      box(px - 5, py + 2, 10, 6, '#ffffff');
      box(px - 2, py + 3, 4, 4, '#f59e0b');
    } else if (petItem === 'shiba-dog-pet') {
      box(px - 6, py - 7, 12, 9, '#d97706');
      box(px - 6, py - 10, 3, 3, '#92400e');
      box(px + 3, py - 10, 3, 3, '#92400e');
      rect(px - 4, py - 3, 8, 4, '#fef3c7');
      rect(px - 4, py - 5, 2, 2, '#201d24');
      rect(px + 2, py - 5, 2, 2, '#201d24');
      box(px - 5, py + 2, 10, 6, '#d97706');
      rect(px - 5, py + 2, 10, 2, '#e11d48');
    } else if (petItem === 'golden-dragon-pet') {
      box(px - 6, py - 9, 12, 9, '#ffd447');
      box(px - 5, py - 13, 2, 4, '#f59e0b');
      box(px + 3, py - 13, 2, 4, '#f59e0b');
      rect(px - 4, py - 6, 2, 2, '#c81e24');
      rect(px + 2, py - 6, 2, 2, '#c81e24');
      box(px - 4, py, 8, 7, '#eab308');
      rect(px - 2, py + 1, 4, 5, '#fef08a');
      box(px + 4, py + 1, 4, 4, '#10b981');
    } else if (petItem === 'astro-drone-pet') {
      box(px - 6, py - 9, 12, 10, '#e2e8f0');
      rect(px - 4, py - 7, 8, 6, '#0f172a');
      rect(px - 2, py - 5, 4, 3, '#38f6ff');
      rect(px - 1, py - 13, 2, 4, '#94a3b8');
      rect(px - 2, py - 14, 4, 2, '#38f6ff');
      rect(px - 8, py - 4, 16, 2, '#64748b');
    }
  }

  context.restore();
}

// Vẽ icon pixel-art sắc nét cho từng vật phẩm trong Cửa hàng & Rương đồ
function drawShopItemSprite(canvasEl, item) {
  if (!canvasEl || !item) return;
  const c = canvasEl.getContext('2d');
  const w = canvasEl.width;
  const h = canvasEl.height;
  c.clearRect(0, 0, w, h);
  c.imageSmoothingEnabled = false;

  const rarityBg = {
    'Phổ thông': ['#f8ebd0', '#d8b98a'],
    'Hiếm': ['#dbeafe', '#60a5fa'],
    'Sử thi': ['#f3e8ff', '#a855f7'],
    'Huyền thoại': ['#fef3c7', '#f59e0b'],
  }[item.rarity] || ['#f8ebd0', '#d8b98a'];

  const grad = c.createRadialGradient(w / 2, h / 2, 4, w / 2, h / 2, w / 2);
  grad.addColorStop(0, rarityBg[0]);
  grad.addColorStop(1, rarityBg[1]);
  c.fillStyle = grad;
  c.fillRect(0, 0, w, h);
  c.strokeStyle = '#3a2214';
  c.lineWidth = 2;
  c.strokeRect(1, 1, w - 2, h - 2);

  // Tạo nhân vật mẫu hoặc vẽ trực tiếp vật phẩm nổi bật ở trung tâm canvas
  const dummy = {
    gender: 'female',
    hairStyle: 'short',
    faceStyle: 'A',
    hairColor: 'black',
    shirtStyle: 'shirt',
    shirtColor: 'blue',
    pantsColor: 'gray',
    shoesStyle: 'sneakers',
    backpack: 'none',
    accessory: 'none',
    equipped: {},
  };
  if (item.slot) {
    dummy.equipped[item.slot] = item.itemId;
  }

  c.save();
  if (item.slot === 'hat' || item.slot === 'glasses' || item.slot === 'bow') {
    drawAvatar(c, dummy, '#4d83b6', w / 2, h / 2 + 28, 1.45, { walking: false, phase: 0, now: 600 });
  } else if (item.slot === 'neck' || item.slot === 'top' || item.slot === 'outfit') {
    drawAvatar(c, dummy, '#4d83b6', w / 2, h / 2 + 6, 1.45, { walking: false, phase: 0, now: 600 });
  } else if (item.slot === 'bottom' || item.slot === 'shoes') {
    drawAvatar(c, dummy, '#4d83b6', w / 2, h / 2 - 10, 1.55, { walking: false, phase: 0, now: 600 });
  } else if (item.slot === 'bag') {
    drawAvatar(c, dummy, '#4d83b6', w / 2 + 12, h / 2 + 6, 1.5, { walking: false, phase: 0, now: 600 });
  } else if (item.slot === 'wings') {
    drawAvatar(c, dummy, '#4d83b6', w / 2, h / 2 + 8, 1.15, { walking: false, phase: 0, now: 600 });
  } else if (item.slot === 'pet') {
    drawAvatar(c, dummy, '#4d83b6', w / 2 - 34, h / 2 + 2, 1.65, { walking: false, phase: 0, now: 600 });
  } else {
    drawAvatar(c, dummy, '#4d83b6', w / 2, h / 2 + 10, 1.25, { walking: false, phase: 0, now: 600 });
  }
  c.restore();
}

// ---------- Vẽ lớp học ----------
// Phần tĩnh được vẽ một lần vào canvas ẩn; hiệu ứng ánh nắng, bụi sáng, đèn lồng vẽ mỗi khung hình.
let classroomLayer = null;

function classroomRect(c, x, y, w, h, color) {
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

function classroomBox(c, x, y, w, h, color, edge = '#2a1a22') {
  c.fillStyle = edge;
  c.fillRect(x - 2, y - 2, w + 4, h + 4);
  c.fillStyle = color;
  c.fillRect(x, y, w, h);
}

function buildClassroomLayer() {
  const layer = document.createElement('canvas');
  layer.width = W;
  layer.height = H;
  const c = layer.getContext('2d');
  const R = (x, y, w, h, color) => classroomRect(c, x, y, w, h, color);
  const B = (x, y, w, h, color, edge) => classroomBox(c, x, y, w, h, color, edge);

  // --- Sàn gỗ ---
  const WALL_H = 150;
  R(0, WALL_H, W, H - WALL_H, '#d9a566');
  for (let row = 0, y = WALL_H; y < H; row += 1, y += 38) {
    R(0, y, W, 38, row % 2 ? '#d29d5d' : '#dcab6e');
    R(0, y, W, 2, '#a9703c');
    for (let x = (row % 2) * 60 - 60; x < W; x += 120) {
      R(x, y, 2, 38, '#b27a45');
      R(x + 20, y + 12, 26, 2, 'rgba(150, 95, 50, .45)');
      R(x + 64, y + 24, 18, 2, 'rgba(150, 95, 50, .35)');
      R(x + 8, y + 30, 10, 2, 'rgba(255, 233, 190, .3)');
    }
  }

  // --- Tường + ốp gỗ ---
  R(0, 0, W, WALL_H, '#f2e0b8');
  for (let x = 0; x < W; x += 40) R(x, 0, 2, 104, 'rgba(210, 170, 110, .28)');
  R(0, 0, W, 10, '#7a2a20');
  R(0, 10, W, 4, '#c9923f');
  R(0, 100, W, 6, '#c9923f');
  R(0, 106, W, 44, '#8a4b2a');
  for (let x = 0; x < W; x += 60) {
    R(x, 112, 2, 38, '#5c2f18');
    R(x + 4, 114, 52, 2, '#a96a3c');
  }
  R(0, 146, W, 4, '#4a2412');
  R(0, 150, W, 8, 'rgba(60, 30, 10, .28)');

  // --- Cửa sổ ---
  for (const wx of [38, 782]) {
    B(wx, 28, 140, 78, '#aee0f5', '#4a2412');
    const sky = c.createLinearGradient(0, 28, 0, 106);
    sky.addColorStop(0, '#8fd0f0');
    sky.addColorStop(1, '#fbe6b0');
    c.fillStyle = sky;
    c.fillRect(wx, 28, 140, 78);
    R(wx, 78, 140, 28, '#9fc27a');
    R(wx + 10, 70, 36, 12, '#7da4b8');
    R(wx + 70, 64, 52, 18, '#8aaabd');
    R(wx + 90, 52, 18, 12, '#a8c0cf');
    R(wx + 14, 40, 24, 8, '#ffffff');
    R(wx + 94, 38, 30, 8, '#ffffff');
    R(wx + 68, 28, 4, 78, '#6b3b1d');
    R(wx, 64, 140, 4, '#6b3b1d');
    R(wx - 8, 104, 156, 8, '#6b3b1d');
    R(wx - 8, 112, 156, 3, 'rgba(0, 0, 0, .18)');
    R(wx + 6, 32, 6, 70, 'rgba(255, 255, 255, .28)');
    // rèm
    R(wx - 10, 22, 18, 84, '#b33a3a');
    R(wx + 132, 22, 18, 84, '#b33a3a');
    for (let i = 0; i < 4; i += 1) {
      R(wx - 10 + i * 5, 22, 2, 84, '#8c2828');
      R(wx + 132 + i * 5, 22, 2, 84, '#8c2828');
    }
    R(wx - 14, 18, 168, 6, '#c9923f');
  }

  // --- Giá sách ---
  for (const bx of [214, 700]) {
    B(bx, 34, 50, 84, '#7a4424');
    for (const sy of [60, 88]) R(bx, sy, 50, 5, '#4a2412');
    const colors = ['#c0392b', '#2980b9', '#27ae60', '#f1c40f', '#8e44ad', '#e67e22'];
    for (let shelf = 0; shelf < 3; shelf += 1) {
      let x = bx + 4;
      for (let i = 0; i < 6; i += 1) {
        const h = 16 + ((i * 7 + shelf * 5) % 10);
        const baseY = 34 + 26 + shelf * 28 - 1;
        R(x, baseY - h, 6, h, colors[(i + shelf * 2) % colors.length]);
        R(x, baseY - h, 2, h, 'rgba(255,255,255,.28)');
        x += 7;
      }
    }
  }

  // --- Bảng đen ---
  B(286, 14, 388, 100, '#8a5a2b');
  R(290, 18, 380, 92, '#6b3f1c');
  R(298, 26, 364, 76, '#1f5a3a');
  R(298, 26, 364, 4, '#17452c');
  R(298, 26, 4, 76, '#17452c');
  for (let i = 0; i < 40; i += 1) {
    R(300 + ((i * 53) % 358), 30 + ((i * 29) % 68), 14, 2, 'rgba(255, 255, 255, .05)');
  }
  R(298, 104, 364, 8, '#b98a52');
  R(330, 100, 22, 5, '#f5f5f0');
  R(360, 101, 14, 4, '#f4b6c2');
  R(560, 102, 40, 6, '#d7d3cc');

  c.textAlign = 'center';
  c.fillStyle = '#fdfaf0';
  c.font = 'bold 26px "Segoe UI", sans-serif';
  c.fillText('小小学堂 · Lớp K35', 480, 62);
  c.font = '15px "Segoe UI", sans-serif';
  c.fillStyle = '#fbe9a8';
  c.fillText('欢迎同学们!  Chào mừng các bạn!', 480, 88);
  // hoa vẽ phấn
  for (const [fx, fy] of [[322, 80], [638, 80]]) {
    R(fx, fy, 2, 12, '#9ed69a');
    R(fx - 4, fy - 4, 4, 4, '#f4b6c2');
    R(fx + 2, fy - 4, 4, 4, '#f4b6c2');
    R(fx - 1, fy - 7, 4, 4, '#f4b6c2');
    R(fx - 1, fy - 1, 4, 4, '#fbe9a8');
  }

  // --- Câu đối đỏ hai bên bảng ---
  for (const [sx, ch] of [[246, '学'], [706, '海']]) {
    B(sx, 20, 26, 76, '#c0392b', '#7a1d14');
    R(sx + 2, 22, 22, 2, '#f1c40f');
    R(sx + 2, 92, 22, 2, '#f1c40f');
    c.fillStyle = '#f7d56a';
    c.font = 'bold 20px serif';
    c.fillText(ch, sx + 13, 56);
  }

  // --- Đồng hồ ---
  c.fillStyle = '#2a1a22';
  c.beginPath();
  c.arc(480, 130, 15, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#fff7e0';
  c.beginPath();
  c.arc(480, 130, 12, 0, Math.PI * 2);
  c.fill();
  R(479, 120, 2, 10, '#2a1a22');
  R(480, 129, 8, 2, '#2a1a22');
  R(477, 117, 6, 2, '#c0392b');

  // --- Thảm trang trí ---
  const rugX = 250;
  const rugY = 320;
  const rugW = 460;
  const rugH = 190;
  R(rugX + 6, rugY + rugH, rugW - 12, 8, 'rgba(0, 0, 0, .18)');
  B(rugX, rugY, rugW, rugH, '#a8322d', '#5a1a16');
  R(rugX + 10, rugY + 10, rugW - 20, rugH - 20, '#d9a441');
  R(rugX + 16, rugY + 16, rugW - 32, rugH - 32, '#8f2723');
  R(rugX + 28, rugY + 28, rugW - 56, rugH - 56, '#b53a33');
  for (let x = rugX + 30; x < rugX + rugW - 30; x += 22) {
    R(x, rugY + 32, 10, 10, '#f1d58a');
    R(x, rugY + rugH - 42, 10, 10, '#f1d58a');
  }
  // hoa văn giữa thảm
  const cx = rugX + rugW / 2;
  const cy = rugY + rugH / 2;
  c.fillStyle = '#f1d58a';
  c.beginPath();
  c.arc(cx, cy, 40, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#8f2723';
  c.beginPath();
  c.arc(cx, cy, 33, 0, Math.PI * 2);
  c.fill();
  c.fillStyle = '#f7d56a';
  c.font = 'bold 38px serif';
  c.fillText('笑', cx, cy + 13);
  for (let i = 0; i < rugH - 12; i += 6) {
    R(rugX - 6, rugY + 6 + i, 6, 3, '#d9a441');
    R(rugX + rugW, rugY + 6 + i, 6, 3, '#d9a441');
  }

  // --- Bục giảng và bàn giáo viên ---
  R(318, 126, 324, 20, '#7a4424');
  R(318, 126, 324, 5, '#c28a52');
  R(318, 144, 324, 4, '#4a2412');
  drawClassDesk(c, 420, 160, '#7b4b21', true);

  // --- Bàn học sinh + ghế ---
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      drawClassDesk(c, 140 + col * 300, 250 + row * 90, '#a9743f', false, (row + col) % 3);
    }
  }

  // --- Chậu cây ---
  drawClassPlant(c, 22, 456, 1.35);
  drawClassPlant(c, 904, 456, 1.35);
  drawClassPlant(c, 204, 112, 0.8);
  drawClassPlant(c, 724, 112, 0.8);

  // --- Viền tối bốn góc ---
  const vignette = c.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 0.95);
  vignette.addColorStop(0, 'rgba(40, 18, 6, 0)');
  vignette.addColorStop(1, 'rgba(40, 18, 6, .34)');
  c.fillStyle = vignette;
  c.fillRect(0, 0, W, H);

  return layer;
}

function drawClassDesk(c, x, y, color, teacher, accent = 0) {
  const R = (rx, ry, w, h, col) => classroomRect(c, rx, ry, w, h, col);
  const dark = teacher ? '#4a2a10' : '#74491f';
  // bóng
  R(x + 4, y + 44, 100, 8, 'rgba(0, 0, 0, .16)');
  // chân bàn
  R(x + 8, y + 20, 8, 26, dark);
  R(x + 84, y + 20, 8, 26, dark);
  // mặt bàn
  classroomBox(c, x, y, 100, 16, color);
  R(x, y, 100, 4, 'rgba(255, 236, 190, .42)');
  R(x, y + 12, 100, 4, 'rgba(0, 0, 0, .2)');
  // đồ trên bàn
  if (teacher) {
    R(x + 10, y - 12, 18, 12, '#2f6fb5');
    R(x + 10, y - 12, 18, 3, '#7cb2e8');
    R(x + 64, y - 16, 10, 16, '#e7e0cc');
    R(x + 66, y - 20, 6, 4, '#c0392b');
    R(x + 80, y - 10, 12, 10, '#f1d58a');
  } else {
    const bookColors = ['#c0392b', '#2980b9', '#27ae60'];
    R(x + 12, y - 8, 24, 8, bookColors[accent]);
    R(x + 12, y - 8, 24, 2, 'rgba(255,255,255,.35)');
    R(x + 56, y - 6, 22, 3, '#f7e3a1');
    R(x + 60, y - 10, 2, 8, '#f39c12');
  }
  // ghế
  if (!teacher) {
    R(x + 30, y + 56, 40, 6, 'rgba(0, 0, 0, .14)');
    classroomBox(c, x + 28, y + 36, 44, 10, '#8f5a2b');
    R(x + 34, y + 46, 5, 14, '#5c3a1a');
    R(x + 61, y + 46, 5, 14, '#5c3a1a');
  } else {
    classroomBox(c, x + 24, y + 38, 52, 12, '#b0382d');
    R(x + 24, y + 38, 52, 3, '#d86a5c');
    R(x + 34, y + 50, 6, 12, '#4a2412');
    R(x + 60, y + 50, 6, 12, '#4a2412');
  }
}

function drawClassPlant(c, x, y, s = 1) {
  const R = (rx, ry, w, h, col) => classroomRect(c, x + rx * s, y + ry * s, w * s, h * s, col);
  R(2, 56, 38, 6, 'rgba(0, 0, 0, .18)');
  R(4, 30, 34, 28, '#7a2c1f');
  R(2, 28, 38, 7, '#b0422f');
  R(8, 38, 4, 18, '#a2503a');
  const leaves = [[-8, 6, 20, 14, '#2f8a4b'], [12, -6, 22, 18, '#3da35a'], [26, 8, 22, 14, '#2f8a4b'], [6, 14, 20, 12, '#48b866'], [16, 2, 12, 12, '#6ad483']];
  for (const [lx, ly, lw, lh, col] of leaves) {
    R(lx - 1, ly - 1, lw + 2, lh + 2, '#1c4a2a');
    R(lx, ly, lw, lh, col);
  }
}

function drawClassroom(now = performance.now()) {
  if (!classroomLayer) classroomLayer = buildClassroomLayer();
  ctx.drawImage(classroomLayer, 0, 0);
  ctx.textAlign = 'left';

  // đèn lồng đung đưa
  for (const lx of [330, 630]) {
    const sway = Math.sin(now / 900 + lx) * 3;
    ctx.fillStyle = '#4a2412';
    ctx.fillRect(lx - 1, 0, 2, 16);
    ctx.save();
    ctx.translate(lx + sway, 16);
    ctx.fillStyle = '#2a1a22';
    ctx.fillRect(-12, -2, 24, 4);
    ctx.fillRect(-14, 0, 28, 32);
    ctx.fillStyle = '#d6372b';
    ctx.fillRect(-12, 2, 24, 28);
    ctx.fillStyle = '#f0594a';
    ctx.fillRect(-9, 4, 6, 24);
    ctx.fillStyle = '#f7d56a';
    ctx.fillRect(-12, 14, 24, 3);
    ctx.fillRect(-2, 32, 4, 12);
    ctx.fillStyle = 'rgba(255, 200, 100, .18)';
    ctx.beginPath();
    ctx.arc(0, 16, 30 + Math.sin(now / 400) * 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // ánh nắng hắt từ cửa sổ
  const pulse = 0.55 + Math.sin(now / 1800) * 0.18;
  for (const [bx, dir] of [[108, 1], [852, -1]]) {
    ctx.save();
    ctx.globalAlpha = 0.17 * pulse;
    const grad = ctx.createLinearGradient(bx, 110, bx + dir * 180, 440);
    grad.addColorStop(0, '#fff2b8');
    grad.addColorStop(1, 'rgba(255, 242, 184, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(bx - 62, 108);
    ctx.lineTo(bx + 62, 108);
    ctx.lineTo(bx + dir * 250 + 90, 470);
    ctx.lineTo(bx + dir * 250 - 90, 470);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // bụi sáng bay lơ lửng
  for (let i = 0; i < 26; i += 1) {
    const phase = now / 6000 + i * 0.37;
    const px = (i * 97 + Math.sin(phase * 3 + i) * 18 + now * 0.004 * (1 + (i % 3))) % W;
    const py = 120 + ((i * 53 + now * 0.01 * (0.4 + (i % 4) * 0.2)) % (H - 140));
    const a = 0.25 + 0.35 * Math.abs(Math.sin(phase * 5));
    ctx.fillStyle = `rgba(255, 244, 200, ${a.toFixed(2)})`;
    ctx.fillRect(Math.round(px), Math.round(py), 2, 2);
  }
}

// ---------- Vẽ nhân vật pixel ----------
function drawPlayer(p, isMe, now) {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const walking = isMe ? p.walking : Boolean(p.lastMovedAt && now - p.lastMovedAt < 180);
  const phase = now / 105;
  const bob = walking ? -Math.abs(Math.sin(phase)) * 2 : Math.sin(now / 420) * 0.7;
  const visualY = y + bob;

  // Bóng
  ctx.fillStyle = 'rgba(0,0,0,.22)';
  ctx.beginPath();
  ctx.ellipse(x, y + 20, walking ? 14 + Math.abs(Math.sin(phase)) * 2 : 14, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  drawAvatar(ctx, p.character, p.color, x, visualY, 1, { walking, phase, now });

  if (isMe) {
    ctx.fillStyle = '#f1c40f';
    ctx.beginPath();
    ctx.moveTo(x, visualY - 58);
    ctx.lineTo(x - 6, visualY - 68);
    ctx.lineTo(x + 6, visualY - 68);
    ctx.closePath();
    ctx.fill();
  }

  // Tên
  ctx.font = 'bold 13px "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  const isTeacher = p.role === 'teacher';
  ctx.fillStyle = isTeacher ? 'rgba(219, 234, 254, .96)' : 'rgba(0,0,0,.55)';
  const label = p.name;
  const w = ctx.measureText(label).width + 10;
  ctx.fillRect(x - w / 2, visualY - 56, w, 16);
  ctx.fillStyle = isTeacher ? '#123f73' : '#fff';
  ctx.fillText(label, x, visualY - 44);

  // Bong bóng chat
  const bubble = bubbles.get(p.id);
  if (bubble && bubble.until > Date.now()) {
    ctx.font = '13px "Segoe UI", sans-serif';
    const bw = Math.min(ctx.measureText(bubble.text).width + 14, 220);
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.fillRect(x - bw / 2, visualY - 90, bw, 22);
    ctx.fillStyle = '#222';
    ctx.fillText(bubble.text, x, visualY - 75, 210);
  }
}

// ---------- Bản đồ khuôn viên ----------
const worldCanvas = document.getElementById('world-map-canvas');
const worldContext = worldCanvas.getContext('2d');
const MAP_WIDTH = worldCanvas.width;
const MAP_HEIGHT = worldCanvas.height;

function drawMapTree(context, x, y, size = 1, fruit = false) {
  context.fillStyle = 'rgba(36, 45, 28, .3)';
  context.fillRect(x - 13 * size, y + 13 * size, 32 * size, 8 * size);
  context.fillStyle = '#65452c';
  context.fillRect(x - 3 * size, y + 4 * size, 8 * size, 25 * size);
  context.fillRect(x - 10 * size, y + 10 * size, 7 * size, 4 * size);
  context.fillRect(x + 4 * size, y + 6 * size, 9 * size, 4 * size);
  const leaves = [
    [-10, -5, '#286345'], [3, -9, '#347b48'], [-1, 0, '#428c4c'],
    [-14, 4, '#367845'], [12, 2, '#4b914c'], [5, 9, '#397344'],
  ];
  for (const [dx, dy, color] of leaves) {
    context.fillStyle = '#234a39';
    context.fillRect(x + (dx - 1) * size, y + (dy + 2) * size, 16 * size, 13 * size);
    context.fillStyle = color;
    context.fillRect(x + dx * size, y + dy * size, 14 * size, 12 * size);
  }
  context.fillStyle = 'rgba(163, 201, 101, .7)';
  context.fillRect(x - 7 * size, y - 5 * size, 5 * size, 3 * size);
  context.fillRect(x + 7 * size, y + 4 * size, 3 * size, 3 * size);
  if (fruit) {
    context.fillStyle = '#cd4b39';
    context.fillRect(x - 9 * size, y + 2 * size, 4 * size, 4 * size);
    context.fillRect(x + 3 * size, y - 3 * size, 4 * size, 4 * size);
    context.fillRect(x + 8 * size, y + 7 * size, 4 * size, 4 * size);
  }
}

function drawMapFence(context, x, y, width, height, vertical = false) {
  context.fillStyle = '#6e4a2d';
  if (vertical) {
    for (let offset = 0; offset <= height; offset += 20) {
      context.fillRect(x + 2, y + offset, 5, 13);
      context.fillRect(x + width - 7, y + offset, 5, 13);
    }
    context.fillRect(x, y + 7, width, 4);
    context.fillRect(x, y + height - 8, width, 4);
  } else {
    for (let offset = 0; offset <= width; offset += 20) {
      context.fillRect(x + offset, y + 2, 5, 13);
      context.fillRect(x + offset, y + height - 15, 5, 13);
    }
    context.fillRect(x + 7, y, width - 14, 4);
    context.fillRect(x + 7, y + height - 4, width - 14, 4);
  }
}

function drawMapBuilding(context, x, y, width, height, kind) {
  const palette = kind === 'school'
    ? { wall: '#a65d4b', roof: '#674d49', trim: '#ead1a0', door: '#704532' }
    : kind === 'shop'
      ? { wall: '#d8b381', roof: '#8f5040', trim: '#fff0d0', door: '#5d4c3b' }
      : kind === 'barn'
        ? { wall: '#a83d35', roof: '#573c3a', trim: '#f0d7a7', door: '#762e2b' }
        : { wall: '#b9855c', roof: '#604946', trim: '#e9d1a7', door: '#68452f' };

  context.fillStyle = 'rgba(41, 38, 29, .3)';
  context.fillRect(x - 7, y + height - 3, width + 15, 12);
  context.fillStyle = '#88735b';
  context.fillRect(x - 7, y + height - 7, width + 14, 9);
  context.fillStyle = palette.wall;
  context.fillRect(x, y + height * .32, width, height * .68);
  context.strokeStyle = '#49382f';
  context.lineWidth = 4;
  context.strokeRect(x, y + height * .32, width, height * .68);

  context.fillStyle = palette.roof;
  context.beginPath();
  context.moveTo(x - 9, y + height * .36);
  context.lineTo(x + width * .08, y + height * .08);
  context.lineTo(x + width * .44, y - 2);
  context.lineTo(x + width * .92, y + height * .08);
  context.lineTo(x + width + 9, y + height * .36);
  context.lineTo(x + width + 4, y + height * .46);
  context.lineTo(x + width * .5, y + height * .18);
  context.lineTo(x - 4, y + height * .46);
  context.closePath();
  context.fill();
  context.strokeStyle = '#392e2b';
  context.lineWidth = 5;
  context.stroke();
  context.strokeStyle = 'rgba(224, 192, 154, .4)';
  context.lineWidth = 2;
  for (let line = 1; line <= 4; line++) {
    context.beginPath();
    context.moveTo(x + line * width / 5, y + height * .16);
    context.lineTo(x + line * width / 5, y + height * .35);
    context.stroke();
  }

  const windowSize = kind === 'barn' ? 0 : 17;
  if (windowSize) {
    for (const offset of [width * .14, width * .72]) {
      context.fillStyle = '#54372c';
      context.fillRect(x + offset - 2, y + height * .49 - 2, windowSize + 4, windowSize + 4);
      context.fillStyle = kind === 'shop' ? '#9ec6c2' : '#aed0ce';
      context.fillRect(x + offset, y + height * .49, windowSize, windowSize);
      context.fillStyle = '#f0dfb8';
      context.fillRect(x + offset + windowSize / 2 - 1, y + height * .49, 2, windowSize);
      context.fillRect(x + offset, y + height * .49 + windowSize / 2, windowSize, 2);
    }
  }

  context.fillStyle = palette.door;
  context.fillRect(x + width * .42, y + height * .53, width * .18, height * .47);
  context.strokeStyle = palette.trim;
  context.lineWidth = 3;
  context.strokeRect(x + width * .42, y + height * .53, width * .18, height * .47);
  context.fillStyle = '#e6c777';
  context.fillRect(x + width * .56, y + height * .75, 3, 4);

  if (kind === 'school') {
    context.fillStyle = '#674334';
    context.fillRect(x + width * .37, y - 17, width * .26, 22);
    context.fillStyle = '#d7bd85';
    context.beginPath();
    context.arc(x + width * .5, y - 6, 11, 0, Math.PI * 2);
    context.fill();
    context.strokeStyle = '#523629';
    context.lineWidth = 2;
    context.stroke();
    context.fillStyle = '#47362b';
    context.font = 'bold 12px Georgia, serif';
    context.textAlign = 'center';
    context.fillText('K35', x + width * .5, y - 2);
  }
  if (kind === 'shop') {
    context.fillStyle = '#b8523d';
    context.fillRect(x - 3, y + height * .4, width + 6, 12);
    for (let awning = 0; awning < 8; awning++) {
      context.fillStyle = awning % 2 ? '#f3e5c4' : '#c85843';
      context.fillRect(x + awning * width / 8, y + height * .4, width / 8 + 1, 16);
    }
  }
  if (kind === 'barn') {
    context.fillStyle = '#f1d8a5';
    context.fillRect(x + width * .2, y + height * .5, width * .6, height * .48);
    context.strokeStyle = '#762e2b';
    context.lineWidth = 3;
    context.strokeRect(x + width * .2, y + height * .5, width * .6, height * .48);
    context.beginPath();
    context.moveTo(x + width * .2, y + height * .5);
    context.lineTo(x + width * .5, y + height * .75);
    context.lineTo(x + width * .8, y + height * .5);
    context.moveTo(x + width * .5, y + height * .75);
    context.lineTo(x + width * .5, y + height * .98);
    context.stroke();
  }
}

function drawWorldMap() {
  const context = worldContext;
  context.fillStyle = '#64814a';
  context.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  for (let y = 8; y < MAP_HEIGHT; y += 24) {
    for (let x = 7; x < MAP_WIDTH; x += 24) {
      const shade = ((Math.floor(x / 24) * 7 + Math.floor(y / 24) * 11) % 5);
      context.fillStyle = ['#6c8c50', '#60804a', '#729050', '#637f48', '#759250'][shade];
      context.fillRect(x, y, 15, 14);
      if (shade === 2) {
        context.fillStyle = '#9eae67';
        context.fillRect(x + 4, y + 6, 2, 2);
      }
    }
  }

  context.lineCap = 'square';
  context.lineJoin = 'round';
  context.strokeStyle = '#786649';
  context.lineWidth = 82;
  context.beginPath();
  context.moveTo(244, -20);
  context.lineTo(244, 170);
  context.bezierCurveTo(244, 226, 204, 239, 177, 273);
  context.bezierCurveTo(140, 324, 196, 374, 219, 428);
  context.bezierCurveTo(242, 478, 193, 540, 193, 592);
  context.bezierCurveTo(193, 662, 245, 672, 266, 738);
  context.bezierCurveTo(281, 784, 245, 838, 230, 990);
  context.stroke();
  context.strokeStyle = '#c9aa72';
  context.lineWidth = 72;
  context.stroke();

  context.strokeStyle = '#655747';
  context.lineWidth = 48;
  context.beginPath();
  context.moveTo(-20, 404);
  context.lineTo(500, 404);
  context.stroke();
  context.strokeStyle = '#b9aa89';
  context.lineWidth = 40;
  context.stroke();

  context.fillStyle = '#d0c4a4';
  context.fillRect(216, 316, 65, 201);
  for (let y = 321; y < 514; y += 18) {
    context.fillStyle = '#a99b80';
    context.fillRect(218, y, 62, 2);
  }
  for (let x = 223; x < 280; x += 19) {
    context.fillStyle = 'rgba(127, 113, 90, .55)';
    context.fillRect(x, 319, 2, 198);
  }
  for (let y = 330; y < 508; y += 34) {
    context.fillStyle = '#e0d4b6';
    context.fillRect(225, y, 18, 12);
    context.fillRect(249, y + 13, 19, 13);
  }

  context.fillStyle = '#729a9c';
  context.beginPath();
  context.moveTo(0, 512);
  context.lineTo(47, 520);
  context.lineTo(63, 559);
  context.lineTo(40, 596);
  context.lineTo(0, 579);
  context.closePath();
  context.fill();
  context.fillStyle = '#a3c4a0';
  context.fillRect(6, 531, 20, 4);
  context.fillRect(31, 565, 19, 4);

  drawMapFence(context, 32, 41, 54, 74);
  drawMapFence(context, 194, 48, 34, 86, true);
  drawMapBuilding(context, 98, 48, 89, 107, 'barn');
  drawMapBuilding(context, 47, 276, 145, 105, 'school');
  drawMapBuilding(context, 294, 239, 137, 83, 'shop');
  drawMapBuilding(context, 287, 453, 129, 116, 'house');
  drawMapBuilding(context, 145, 704, 98, 110, 'barn');
  drawMapBuilding(context, 22, 678, 90, 85, 'house');
  drawMapBuilding(context, 344, 682, 92, 83, 'house');

  drawMapFence(context, 25, 389, 166, 42);
  drawMapFence(context, 158, 676, 118, 40);
  drawMapFence(context, 313, 667, 135, 117, true);
  drawMapFence(context, 33, 134, 185, 5);

  for (const [x, y, width, height, color] of [
    [42, 155, 40, 27, '#80623d'], [102, 166, 34, 32, '#638442'],
    [158, 165, 34, 32, '#8a7140'], [50, 440, 57, 34, '#9a7744'],
    [333, 789, 48, 31, '#936f42'], [242, 852, 55, 39, '#89683f'],
    [156, 829, 56, 32, '#9a7744'],
  ]) {
    context.fillStyle = '#65513a';
    context.fillRect(x - 3, y - 3, width + 6, height + 6);
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
    for (let row = y + 5; row < y + height; row += 10) {
      context.fillStyle = '#718f47';
      context.fillRect(x + 5, row, width - 10, 3);
      for (let crop = x + 7; crop < x + width - 5; crop += 13) {
        context.fillStyle = '#a8bd67';
        context.fillRect(crop, row - 3, 3, 5);
      }
    }
  }

  for (const [x, y, size, fruit] of [
    [61, 43, 1, false], [42, 236, 1.15, false], [221, 206, .85, false],
    [260, 182, 1.05, true], [316, 177, .95, true], [411, 187, 1.15, true],
    [29, 469, 1.25, false], [159, 470, 1, false], [448, 406, 1.2, false],
    [121, 536, 1.3, false], [82, 602, 1.35, false], [352, 411, .9, false],
    [30, 629, 1.1, false], [282, 634, 1.2, false], [319, 799, .95, true],
    [411, 821, 1.05, true], [362, 858, .9, true], [405, 886, 1, true],
    [55, 875, 1.2, false], [102, 918, 1.1, false],
  ]) drawMapTree(context, x, y, size, fruit);

  context.fillStyle = '#63462e';
  for (const [x, y] of [[267, 234], [266, 298], [222, 556], [264, 604], [211, 681], [280, 839]]) {
    context.fillRect(x, y, 5, 24);
    context.fillStyle = '#f5d485';
    context.fillRect(x - 3, y - 3, 11, 10);
    context.fillStyle = '#63462e';
  }

  context.strokeStyle = '#f0dfb4';
  context.lineWidth = 5;
  context.strokeRect(9, 9, MAP_WIDTH - 18, MAP_HEIGHT - 18);
  context.strokeStyle = 'rgba(58, 45, 34, .8)';
  context.lineWidth = 2;
  context.strokeRect(16, 16, MAP_WIDTH - 32, MAP_HEIGHT - 32);

  drawAvatar(context, worldUser && worldUser.character, '#4d83b6', 241, 571, 1.35);
}

function render() {
  const viewW = canvas.width / view.zoom;
  const viewH = canvas.height / view.zoom;
  const focusX = me ? me.x : W / 2;
  const focusY = me ? me.y - 10 : H / 2;
  const targetX = viewW >= W ? (W - viewW) / 2 : Math.max(0, Math.min(W - viewW, focusX - viewW / 2));
  const targetY = viewH >= H ? (H - viewH) / 2 : Math.max(0, Math.min(H - viewH, focusY - viewH / 2));
  if (!view.ready) {
    view.camX = targetX;
    view.camY = targetY;
    view.ready = true;
  } else {
    view.camX += (targetX - view.camX) * 0.14;
    view.camY += (targetY - view.camY) * 0.14;
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;
  ctx.save();
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-Math.round(view.camX * view.zoom) / view.zoom, -Math.round(view.camY * view.zoom) / view.zoom);
  drawClassroom();
  const all = [...others.values()];
  if (me) all.push(me);
  all.sort((a, b) => a.y - b.y);
  for (const p of all) drawPlayer(p, me && p.id === me.id, performance.now());
  ctx.restore();
}

// ---------- Vòng lặp di chuyển ----------
let lastTime = performance.now();
function loop(now) {
  const dt = Math.min((now - lastTime) / 1000, 0.05);
  lastTime = now;

  if (me) {
    let dx = 0, dy = 0;
    if (keys['arrowleft'] || keys['a'] || keys['dpad-left']) dx -= 1;
    if (keys['arrowright'] || keys['d'] || keys['dpad-right']) dx += 1;
    if (keys['arrowup'] || keys['w'] || keys['dpad-up']) dy -= 1;
    if (keys['arrowdown'] || keys['s'] || keys['dpad-down']) dy += 1;
    me.walking = Boolean(dx || dy);
    if (dx || dy) {
      const len = Math.hypot(dx, dy) || 1;
      me.x = Math.max(16, Math.min(W - 16, me.x + (dx / len) * SPEED * dt));
      me.y = Math.max(16, Math.min(H - 16, me.y + (dy / len) * SPEED * dt));
      if (now - lastSent > 50) {
        lastSent = now;
        socket.emit('move', { x: me.x, y: me.y });
      }
    }
  }

  render();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ---------- Bàn phím & D-pad ----------
window.addEventListener('keydown', (e) => {
  if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
  keys[e.key.toLowerCase()] = true;
  if (e.key.startsWith('Arrow')) e.preventDefault();
});
window.addEventListener('keyup', (e) => {
  keys[e.key.toLowerCase()] = false;
});

document.querySelectorAll('.dp').forEach((btn) => {
  const key = 'dpad-' + btn.dataset.dir;
  const on = (e) => { e.preventDefault(); keys[key] = true; };
  const off = (e) => { e.preventDefault(); keys[key] = false; };
  btn.addEventListener('touchstart', on, { passive: false });
  btn.addEventListener('touchend', off, { passive: false });
  btn.addEventListener('mousedown', on);
  btn.addEventListener('mouseup', off);
  btn.addEventListener('mouseleave', off);
});

// ---------- Đăng nhập và đăng ký ----------
const authForm = document.getElementById('auth-form');
const authMessage = document.getElementById('auth-message');
const authSubmit = document.getElementById('auth-submit');
const passwordInput = document.getElementById('password-input');
const confirmPasswordField = document.getElementById('confirm-password-field');
const confirmPasswordInput = document.getElementById('confirm-password-input');

function showAuthMessage(message, success = false) {
  authMessage.textContent = message;
  authMessage.classList.toggle('success', success);
}

function setAuthMode(mode) {
  authMode = mode;
  const registering = mode === 'register';
  document.getElementById('login-tab').classList.toggle('active', !registering);
  document.getElementById('register-tab').classList.toggle('active', registering);
  document.getElementById('login-tab').setAttribute('aria-selected', String(!registering));
  document.getElementById('register-tab').setAttribute('aria-selected', String(registering));
  confirmPasswordField.classList.toggle('hidden', !registering);
  const serverField = document.getElementById('server-field');
  if (serverField) serverField.classList.toggle('hidden', registering);
  const authTitle = document.getElementById('auth-title');
  if (authTitle) authTitle.textContent = registering ? 'đăng ký' : 'đăng nhập';
  confirmPasswordInput.required = registering;
  passwordInput.autocomplete = registering ? 'new-password' : 'current-password';
  authSubmit.textContent = registering ? 'Đăng ký' : 'đăng nhập';
  const authModeToggle = document.getElementById('auth-mode-toggle');
  if (authModeToggle) authModeToggle.textContent = registering ? 'đăng nhập' : 'Đăng ký';
  showAuthMessage('');
}

async function requestJson(url, payload, method) {
  const response = await fetch(url, {
    method: method || (payload ? 'POST' : 'GET'),
    credentials: 'same-origin',
    headers: payload ? { 'Content-Type': 'application/json' } : {},
    body: payload ? JSON.stringify(payload) : undefined,
  });
  if (response.status === 204) return {};
  const contentType = response.headers.get('content-type') || '';
  const result = contentType.includes('application/json')
    ? await response.json()
    : { error: `Máy chủ trả phản hồi không hợp lệ (${response.status}).` };
  if (!response.ok) throw new Error(result.error || 'Không thể thực hiện yêu cầu.');
  return result;
}

const characterForm = document.getElementById('character-form');
const characterMessage = document.getElementById('character-message');
const characterSubmit = document.getElementById('character-submit');
const defaultCharacter = {
  nickname: '',
  gender: 'male',
  hairStyle: 'short',
  faceStyle: 'A',
  hairColor: 'black',
  shirtStyle: 'shirt',
  shirtColor: 'blue',
  pantsColor: 'gray',
  shoesStyle: 'sneakers',
  backpack: 'brown',
  accessory: 'none',
};

function characterFormValues() {
  const formData = new FormData(characterForm);
  return Object.fromEntries(
    Object.keys(defaultCharacter).map((field) => [field, formData.get(field)]),
  );
}

function drawCharacterPreview() {
  const preview = document.getElementById('character-preview');
  const previewContext = preview.getContext('2d');
  const character = characterFormValues();
  previewContext.clearRect(0, 0, preview.width, preview.height);
  previewContext.fillStyle = '#604023';
  previewContext.fillRect(0, 265, preview.width, 35);
  previewContext.fillStyle = '#c49353';
  previewContext.fillRect(24, 263, preview.width - 48, 5);
  previewContext.fillStyle = 'rgba(0,0,0,.26)';
  previewContext.beginPath();
  previewContext.ellipse(120, 246, 40, 9, 0, 0, Math.PI * 2);
  previewContext.fill();
  drawAvatar(previewContext, character, '#4d83b6', 120, 203, 2.45);
  document.getElementById('preview-name').textContent =
    character.nickname.trim() || 'Nhân vật mới';
}

function showCharacterCreator(user) {
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.add('hidden');
  document.getElementById('character-screen').classList.remove('hidden');
  const character = { ...defaultCharacter, ...(user.character || {}) };
  character.nickname = character.nickname || user.username.slice(0, 16);
  for (const [field, value] of Object.entries(character)) {
    const input = characterForm.elements.namedItem(field);
    if (input) input.value = value;
  }
  characterMessage.textContent = '';
  drawCharacterPreview();
}

function showAuthenticatedUser(user) {
  if (!user.character) {
    showCharacterCreator(user);
    return;
  }
  showWorld(user);
}

function showWorld(user) {
  worldUser = user;
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('character-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.add('hidden');
  document.getElementById('world-screen').classList.remove('hidden');
  const roleNames = { student: 'Học sinh', teacher: 'Giáo viên', admin: 'Quản trị' };
  document.getElementById('world-account-label').textContent =
    `${user.character.nickname} · ${roleNames[user.role] || 'Tài khoản'}`;
  document.getElementById('world-message').textContent = 'Chọn Lớp học để vào phòng K35.';
  drawWorldMap();
}

function showGame(user) {
  worldUser = user;
  document.getElementById('world-screen').classList.add('hidden');
  document.getElementById('auth-screen').classList.add('hidden');
  document.getElementById('character-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  const roleNames = { student: 'Học sinh', teacher: 'Giáo viên', admin: 'Quản trị' };
  document.getElementById('account-label').textContent =
    `${user.username} · ${roleNames[user.role] || 'Tài khoản'}`;
  const adminPanel = document.getElementById('admin-panel');
  adminPanel.classList.toggle('hidden', user.role !== 'admin');
  if (user.role === 'admin') loadAdminUsers();
  document.getElementById('room-label').textContent = 'Phòng K35';
  document.getElementById('game-message').textContent = 'Đang kết nối phòng học...';

  const isLocalDevelopment = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  socket = io({
    reconnectionAttempts: 5,
    ...(isLocalDevelopment ? {} : {
      path: '/api/socket-io/socket.io',
      transports: ['websocket'],
    }),
  });
  socket.on('connect', () => {
    document.getElementById('game-message').textContent = '';
    socket.emit('join');
  });
  socket.on('connect_error', () => {
    document.getElementById('game-message').textContent =
      'Không thể kết nối phòng học. Vui lòng thử tải lại trang.';
  });

  socket.on('joined', ({ you, players }) => {
    me = you;
    others.clear();
    for (const player of players) {
      if (player.id !== me.id) others.set(player.id, player);
    }
    addChatLine('Hệ thống', 'Bạn đã vào phòng K35.');
    updateCount();
  });

  socket.on('playerJoined', (player) => {
    others.set(player.id, player);
    addChatLine('Hệ thống', player.name + ' vừa vào lớp.');
    updateCount();
  });

  socket.on('playerUpdated', ({ id, character, name }) => {
    if (me && id === me.id) {
      me.character = character;
      if (name) me.name = name;
    } else {
      const player = others.get(id);
      if (player) {
        player.character = character;
        if (name) player.name = name;
      }
    }
  });

  socket.on('playerMoved', ({ id, x, y }) => {
    const player = others.get(id);
    if (player) {
      player.x = x;
      player.y = y;
      player.lastMovedAt = performance.now();
    }
  });

  socket.on('playerLeft', ({ id }) => {
    const player = others.get(id);
    if (player) addChatLine('Hệ thống', player.name + ' đã rời lớp.');
    others.delete(id);
    bubbles.delete(id);
    updateCount();
  });

  socket.on('chat', ({ id, name, text }) => {
    addChatLine(name, text);
    bubbles.set(id, { text, until: Date.now() + 3000 });
  });

  socket.on('quiz:state', renderQuizState);
  socket.on('hanzi:state', renderHanziState);
  socket.on('hanzi:answer-result', handleHanziAnswerResult);
}

async function loadAdminUsers() {
  const message = document.getElementById('admin-message');
  const userList = document.getElementById('user-list');
  message.textContent = 'Đang tải tài khoản...';
  userList.replaceChildren();

  try {
    const { users } = await requestJson('/api/auth/admin/users');
    message.textContent = `Hiển thị tối đa 100 tài khoản · ${users.length} tài khoản`;
    for (const user of users) {
      const row = document.createElement('div');
      row.className = 'user-row';
      const label = document.createElement('span');
      const roleNames = { student: 'Học sinh', teacher: 'Giáo viên', admin: 'Quản trị' };
      label.textContent = `${user.username} · ${roleNames[user.role] || user.role}`;
      row.appendChild(label);

      if (user.role === 'student' || user.role === 'teacher') {
        const button = document.createElement('button');
        const nextRole = user.role === 'student' ? 'teacher' : 'student';
        button.type = 'button';
        button.textContent = nextRole === 'teacher' ? 'Cấp quyền giáo viên' : 'Chuyển về học sinh';
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await requestJson(
              `/api/auth/admin/users/${encodeURIComponent(user.id)}/role`,
              { role: nextRole },
              'PATCH',
            );
            await loadAdminUsers();
          } catch (error) {
            message.textContent = error.message || 'Không thể cập nhật quyền tài khoản.';
            button.disabled = false;
          }
        });
        row.appendChild(button);
      }

      userList.appendChild(row);
    }
    return true;
  } catch (error) {
    message.textContent = error.message || 'Không thể tải danh sách tài khoản.';
    return false;
  }
}

document.getElementById('login-tab').addEventListener('click', () => setAuthMode('login'));
document.getElementById('register-tab').addEventListener('click', () => setAuthMode('register'));
const authModeToggleBtn = document.getElementById('auth-mode-toggle');
if (authModeToggleBtn) {
  authModeToggleBtn.addEventListener('click', () => {
    setAuthMode(authMode === 'login' ? 'register' : 'login');
  });
}
document.getElementById('refresh-users').addEventListener('click', loadAdminUsers);
document.getElementById('admin-teacher-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const submitButton = form.querySelector('button[type="submit"]');
  const message = document.getElementById('admin-message');
  const credentials = new FormData(form);
  submitButton.disabled = true;
  message.textContent = 'Đang tạo tài khoản giáo viên...';

  try {
    const { user } = await requestJson('/api/auth/admin/teachers', {
      username: credentials.get('username'),
      password: credentials.get('password'),
    });
    form.reset();
    if (await loadAdminUsers()) {
      message.textContent = `Đã tạo tài khoản giáo viên "${user.username}".`;
    }
  } catch (error) {
    message.textContent = error.message || 'Không thể tạo tài khoản giáo viên.';
  } finally {
    submitButton.disabled = false;
  }
});

characterForm.addEventListener('input', drawCharacterPreview);
characterForm.addEventListener('change', drawCharacterPreview);
characterForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!characterForm.reportValidity()) return;

  characterSubmit.disabled = true;
  characterMessage.textContent = 'Đang lưu nhân vật...';
  try {
    const result = await requestJson('/api/auth/character', characterFormValues(), 'PUT');
    characterMessage.textContent = '';
    showWorld(result.user);
  } catch (error) {
    characterMessage.textContent = error.message || 'Không thể lưu nhân vật. Vui lòng thử lại.';
  } finally {
    characterSubmit.disabled = false;
  }
});

authForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!authForm.reportValidity()) return;

  if (authMode === 'register' && passwordInput.value !== confirmPasswordInput.value) {
    showAuthMessage('Mật khẩu nhập lại chưa khớp.');
    return;
  }

  authSubmit.disabled = true;
  showAuthMessage(authMode === 'register' ? 'Đang tạo tài khoản...' : 'Đang đăng nhập...');
  try {
    const result = await requestJson(`/api/auth/${authMode}`, {
      username: document.getElementById('username-input').value,
      password: passwordInput.value,
    });
    showAuthenticatedUser(result.user);
  } catch (error) {
    showAuthMessage(error.message || 'Không thể kết nối máy chủ. Vui lòng thử lại.');
  } finally {
    authSubmit.disabled = false;
  }
});

async function logout() {
  const logoutButton = document.activeElement;
  if (logoutButton instanceof HTMLButtonElement) logoutButton.disabled = true;
  try {
    await requestJson('/api/auth/logout', {});
    if (socket) socket.disconnect();
    socket = null;
    me = null;
    worldUser = null;
    others.clear();
    bubbles.clear();
    chatLog.replaceChildren();
    document.getElementById('world-screen').classList.add('hidden');
    document.getElementById('game-screen').classList.add('hidden');
    document.getElementById('character-screen').classList.add('hidden');
    document.getElementById('auth-screen').classList.remove('hidden');
    authForm.reset();
    setAuthMode('login');
    showAuthMessage('Bạn đã đăng xuất.', true);
  } catch (error) {
    document.getElementById('game-message').textContent =
      error.message || 'Không thể đăng xuất. Vui lòng thử lại.';
  } finally {
    if (logoutButton instanceof HTMLButtonElement) logoutButton.disabled = false;
  }
}

document.getElementById('logout-btn').addEventListener('click', logout);
document.getElementById('character-logout').addEventListener('click', logout);
document.getElementById('world-logout-btn').addEventListener('click', logout);

const playerMenuDialog = document.getElementById('player-menu-dialog');
const playerMenuMessage = document.getElementById('player-menu-message');
const profileTab = document.getElementById('profile-tab');
const inventoryTab = document.getElementById('inventory-tab');
const gamesTab = document.getElementById('games-tab');
const profilePanel = document.getElementById('profile-panel');
const inventoryPanel = document.getElementById('inventory-panel');
const gamesPanel = document.getElementById('games-panel');
const quizFileInput = document.getElementById('quiz-file');
const quizImportMessage = document.getElementById('quiz-import-message');
const quizStartButton = document.getElementById('quiz-start');
const quizNextButton = document.getElementById('quiz-next');
const quizEndButton = document.getElementById('quiz-end');
const hanziFileInput = document.getElementById('hanzi-file');
const hanziImportMessage = document.getElementById('hanzi-import-message');
const hanziStartButton = document.getElementById('hanzi-start');
const hanziEndButton = document.getElementById('hanzi-end');
const inventoryCategoryIcons = {
  accessory: '🎀',
  clothing: '👕',
  food: '🍎',
  furniture: '🪑',
  item: '🎁',
  pet: '🐾',
  tool: '🧰',
};

function updateQuizControls() {
  const active = quizState.status === 'active';
  const hanziActive = hanziState.status === 'active';
  quizStartButton.disabled = active || hanziActive || importedQuizQuestions.length === 0;
  quizNextButton.disabled = !active;
  quizEndButton.disabled = !active;
  hanziStartButton.disabled = hanziActive || active || importedHanziQuestions.length === 0;
  hanziEndButton.disabled = !hanziActive;
}

function renderQuizState(state) {
  quizState = state;
  if (state.status !== 'active') quizFallbackDeadline = null;
  updateQuizControls();
  if (hanziState.status === 'active') return;
  const stage = document.getElementById('quiz-stage');
  const questionElement = document.getElementById('quiz-question');
  const options = document.getElementById('quiz-answer-options');
  const winners = document.getElementById('hanzi-winners');
  const message = document.getElementById('quiz-stage-message');
  const progress = document.getElementById('quiz-progress');
  const title = document.getElementById('quiz-stage-title');
  stage.classList.toggle('hidden', state.status === 'idle');
  questionElement.classList.remove('hanzi-question');
  options.replaceChildren();
  winners.replaceChildren();
  winners.classList.toggle('hidden', state.status === 'idle');
  message.textContent = '';
  if (state.status === 'idle') {
    document.getElementById('chat-input').placeholder = 'Nhắn gì đó...';
    refreshGameCountdown();
    return;
  }
  if (state.status === 'finished') {
    title.textContent = 'Trò chơi đã kết thúc';
    progress.textContent = `${state.questionCount} câu hỏi`;
    questionElement.textContent = '';
    message.textContent = 'Đã hoàn thành bộ câu hỏi.';
    for (const winner of state.winners || []) {
      const entry = document.createElement('li');
      entry.textContent = `#${getWinnerRank(winner, winners.childElementCount + 1)} ${winner.name} · +20 EXP · +20 Xu`;
      winners.appendChild(entry);
    }
    winners.classList.toggle('hidden', winners.childElementCount === 0);
    refreshGameCountdown();
    return;
  }

  if (displayedQuizQuestion !== state.questionNumber) {
    displayedQuizQuestion = state.questionNumber;
    quizAnswerLocked = false;
  }

  winners.classList.remove('hidden');
  for (const [index, winner] of (state.winners || []).entries()) {
    const entry = document.createElement('li');
    entry.textContent = `#${getWinnerRank(winner, index + 1)} ${winner.name} · +20 EXP · +20 Xu`;
    winners.appendChild(entry);
  }
  if (winners.childElementCount === 0) {
    const entry = document.createElement('li');
    entry.textContent = 'Chưa có học sinh trả lời đúng câu này.';
    winners.appendChild(entry);
  }
  title.textContent = 'Đố từ vựng trắc nghiệm';
  questionElement.textContent = state.question.question;

  for (const key of ['A', 'B', 'C', 'D']) {
    const option = document.createElement('div');
    option.className = 'quiz-answer-option';
    option.textContent = `${key}. ${state.question.answers[key]}`;
    options.appendChild(option);
  }

  const chatInput = document.getElementById('chat-input');
  if (worldUser && worldUser.role === 'student') {
    message.textContent = quizAnswerLocked
      ? 'Bạn đã trả lời câu này. Chờ câu tiếp theo nhé!'
      : 'Nhập A, B, C hoặc D vào khung chat để trả lời. Mỗi câu chỉ được trả lời một lần.';
    chatInput.placeholder = 'Nhắn gì đó...';
  } else {
    message.textContent = '5 học sinh đúng nhanh nhất nhận 20 EXP và 20 Xu. Câu tự chuyển sau 30 giây.';
    chatInput.placeholder = 'Nhắn gì đó...';
  }
  refreshGameCountdown();
  if (!gameCountdownTimer) {
    gameCountdownTimer = window.setInterval(refreshGameCountdown, 250);
  }
}

function renderHanziState(state) {
  hanziState = state;
  if (state.status !== 'active') hanziFallbackDeadline = null;
  updateQuizControls();
  if (quizState.status === 'active') return;

  const stage = document.getElementById('quiz-stage');
  const questionElement = document.getElementById('quiz-question');
  const options = document.getElementById('quiz-answer-options');
  const winners = document.getElementById('hanzi-winners');
  const message = document.getElementById('quiz-stage-message');
  const progress = document.getElementById('quiz-progress');
  const title = document.getElementById('quiz-stage-title');
  const chatInput = document.getElementById('chat-input');
  stage.classList.toggle('hidden', state.status === 'idle');
  options.replaceChildren();
  winners.replaceChildren();
  winners.classList.toggle('hidden', state.status !== 'active');
  questionElement.classList.toggle('hanzi-question', state.status === 'active');

  if (state.status === 'idle') {
    if (quizState.status !== 'active') chatInput.placeholder = 'Nhắn gì đó...';
    refreshGameCountdown();
    return;
  }
  title.textContent = 'Đoán Nghĩa Hán Tự';
  if (state.status === 'finished') {
    progress.textContent = `${state.questionCount} câu hỏi`;
    questionElement.textContent = '';
    message.textContent = 'Trò chơi đã kết thúc. Giáo viên có thể bắt đầu bộ câu hỏi mới.';
    chatInput.placeholder = 'Nhắn gì đó...';
    for (const [index, winner] of (state.winners || []).entries()) {
      const entry = document.createElement('li');
      entry.textContent = `#${getWinnerRank(winner, index + 1)} ${winner.name} · +20 EXP · +20 Xu`;
      winners.appendChild(entry);
    }
    winners.classList.toggle('hidden', winners.childElementCount === 0);
    refreshGameCountdown();
    return;
  }

  questionElement.textContent = state.hanzi;
  questionElement.lang = 'zh';
  message.textContent = '';
  chatInput.placeholder = 'Gõ nghĩa tiếng Việt vào chat...';
  for (const [index, winner] of (state.winners || []).entries()) {
    const entry = document.createElement('li');
    entry.textContent = `#${getWinnerRank(winner, index + 1)} ${winner.name} · +20 EXP · +20 Xu`;
    winners.appendChild(entry);
  }
  refreshGameCountdown();
  if (!gameCountdownTimer) {
    gameCountdownTimer = window.setInterval(refreshGameCountdown, 250);
  }
}

function getWinnerRank(winner, fallbackRank) {
  return Number.isInteger(winner.rank) && winner.rank > 0 ? winner.rank : fallbackRank;
}

function getGameDeadline(state, game) {
  let deadline = Number.NaN;
  if (typeof state.endsAt === 'number') {
    deadline = state.endsAt;
  } else if (typeof state.endsAt === 'string') {
    deadline = /^\d+$/.test(state.endsAt) ? Number(state.endsAt) : Date.parse(state.endsAt);
  }
  if (Number.isFinite(deadline)) return deadline;

  const isHanzi = game === 'hanzi';
  const cachedDeadline = isHanzi ? hanziFallbackDeadline : quizFallbackDeadline;
  const question = isHanzi ? state.hanzi : state.question?.question;
  if (!cachedDeadline
    || cachedDeadline.questionNumber !== state.questionNumber
    || cachedDeadline.question !== question) {
    const fallback = { questionNumber: state.questionNumber, question, endsAt: Date.now() + 30_000 };
    if (isHanzi) hanziFallbackDeadline = fallback;
    else quizFallbackDeadline = fallback;
    return fallback.endsAt;
  }
  return cachedDeadline.endsAt;
}

function refreshGameCountdown() {
  if (quizState.status !== 'active' && hanziState.status !== 'active') {
    lastExpiredRoundRequest = null;
    if (gameCountdownTimer) {
      window.clearInterval(gameCountdownTimer);
      gameCountdownTimer = null;
    }
    return;
  }
  const isHanzi = hanziState.status === 'active';
  const state = isHanzi ? hanziState : quizState;
  const remaining = Math.max(0, Math.ceil((getGameDeadline(state, isHanzi ? 'hanzi' : 'quiz') - Date.now()) / 1000));
  document.getElementById('quiz-progress').textContent =
    `Câu ${state.questionNumber}/${state.questionCount} · ${remaining} giây`;
  if (remaining === 0) {
    document.getElementById('quiz-stage-message').textContent = 'Đang chuyển câu...';
    const roundKey = `${isHanzi ? 'hanzi' : 'quiz'}:${state.questionNumber}`;
    if (lastExpiredRoundRequest !== roundKey) {
      lastExpiredRoundRequest = roundKey;
      if (socket && socket.connected) socket.emit('game:tick');
    }
  }
}

function displayGameStats(stats) {
  if (!stats) return;
  const numberFormat = new Intl.NumberFormat('vi-VN');
  document.getElementById('profile-level').textContent = numberFormat.format(stats.level);
  document.getElementById('profile-exp').textContent = `${numberFormat.format(stats.exp)} EXP`;
  document.getElementById('profile-xu').textContent = numberFormat.format(stats.xu);
}

function handleHanziAnswerResult(result) {
  const message = document.getElementById('quiz-stage-message');
  if (!result || !result.ok) {
    if (result && result.error) message.textContent = result.error;
    return;
  }
  if (!result.correct) {
    message.textContent = 'Chưa đúng, hãy thử lại trước khi hết giờ.';
    return;
  }
  displayGameStats(result.stats);
  message.textContent = `Chính xác! Bạn đứng thứ ${result.rank}/5 và nhận 20 EXP, 20 Xu.`;
}

function submitQuizAnswer(answer) {
  if (!socket || !socket.connected || quizAnswerLocked) return;
  quizAnswerLocked = true;
  document.getElementById('quiz-stage-message').textContent = 'Đang gửi câu trả lời...';
  socket.emit('quiz:answer', { answer }, (result) => {
    if (!result || !result.ok) {
      quizAnswerLocked = result && result.code === 'already_answered';
      document.getElementById('quiz-stage-message').textContent =
        result && result.error ? result.error : 'Không thể gửi câu trả lời. Vui lòng thử lại.';
      return;
    }
    if (!result.correct) {
      document.getElementById('quiz-stage-message').textContent =
        'Chưa đúng. Bạn đã dùng lượt trả lời cho câu này.';
      return;
    }
    const winner = result.winner || result;
    const { stats } = winner;
    displayGameStats(stats);
    const rank = getWinnerRank(winner, result.rank);
    document.getElementById('quiz-stage-message').textContent = rank
      ? `Chính xác! Bạn xếp hạng #${rank}/5. +20 EXP, +20 Xu.`
      : 'Chính xác! Bạn nhận 20 EXP và 20 Xu.';
  });
}

function normalizeQuizHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

async function readQuizFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error('File tối đa 2 MB.');
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'csv'].includes(extension)) throw new Error('Chỉ nhận file .xlsx hoặc .csv.');
  if (typeof XLSX === 'undefined') throw new Error('Không tải được bộ đọc Excel. Hãy tải lại trang.');

  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    codepage: extension === 'csv' ? 65001 : undefined,
    sheetRows: 102,
    cellDates: false,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File không có trang tính.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  if (rows.length < 2) throw new Error('File cần có hàng tiêu đề và ít nhất một câu hỏi.');
  if (rows.length > 101) throw new Error('Mỗi file chỉ được có tối đa 100 câu hỏi.');

  const headers = rows[0].map(normalizeQuizHeader);
  const aliases = {
    question: ['cauhoi', 'question'],
    A: ['a', 'dapana', 'answera', 'optiona'],
    B: ['b', 'dapanb', 'answerb', 'optionb'],
    C: ['c', 'dapanc', 'answerc', 'optionc'],
    D: ['d', 'dapand', 'answerd', 'optiond'],
    correctAnswer: ['dapandung', 'correctanswer', 'correct'],
    explanation: ['giaithich', 'explanation'],
  };
  const columns = Object.fromEntries(Object.entries(aliases).map(([field, names]) => [
    field,
    headers.findIndex((header) => names.includes(header)),
  ]));
  const required = ['question', 'A', 'B', 'C', 'D', 'correctAnswer'];
  const missing = required.filter((field) => columns[field] < 0);
  if (missing.length) {
    throw new Error('Thiếu cột bắt buộc. Dùng mẫu CSV để xem đúng tên các cột.');
  }

  const questions = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every((cell) => String(cell).trim() === '')) continue;
    const value = (field) => String(row[columns[field]] || '').trim();
    const question = {
      question: value('question'),
      answers: {
        A: value('A'),
        B: value('B'),
        C: value('C'),
        D: value('D'),
      },
      correctAnswer: value('correctAnswer').toUpperCase(),
      explanation: columns.explanation < 0 ? '' : value('explanation'),
    };
    if (!question.question || Object.values(question.answers).some((answer) => !answer)
      || !['A', 'B', 'C', 'D'].includes(question.correctAnswer)) {
      throw new Error(`Dòng ${index + 1} chưa hợp lệ: cần câu hỏi, đủ 4 đáp án và đáp án đúng A/B/C/D.`);
    }
    questions.push(question);
  }
  if (questions.length === 0) throw new Error('Không tìm thấy câu hỏi hợp lệ trong file.');
  return questions;
}

async function readHanziFile(file) {
  if (!file) return;
  if (file.size > 2 * 1024 * 1024) throw new Error('File tối đa 2 MB.');
  const extension = file.name.split('.').pop().toLowerCase();
  if (!['xlsx', 'csv'].includes(extension)) throw new Error('Chỉ nhận file .xlsx hoặc .csv.');
  if (typeof XLSX === 'undefined') throw new Error('Không tải được bộ đọc Excel. Hãy tải lại trang.');

  const workbook = XLSX.read(await file.arrayBuffer(), {
    type: 'array',
    codepage: extension === 'csv' ? 65001 : undefined,
    sheetRows: 102,
    cellDates: false,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('File không có trang tính.');
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
    header: 1,
    raw: false,
    defval: '',
    blankrows: false,
  });
  if (rows.length < 2) throw new Error('File cần có hàng tiêu đề và ít nhất một câu hỏi.');
  if (rows.length > 101) throw new Error('Mỗi file chỉ được có tối đa 100 câu hỏi.');

  const headers = rows[0].map(normalizeQuizHeader);
  const hanziColumn = headers.findIndex((header) =>
    ['hanzi', 'chuhan', 'tiengtrung', 'tutrung', 'word', 'question'].includes(header));
  const meaningColumn = headers.findIndex((header) =>
    ['nghiatiengviet', 'nghia', 'meaning', 'translation', 'vietnamese'].includes(header));
  const aliasesColumn = headers.findIndex((header) =>
    ['chapnhan', 'nghiakhac', 'nghiachapnhankhac', 'nghiatiengvietkhac', 'synonyms', 'acceptedanswers'].includes(header));
  if (hanziColumn < 0 || meaningColumn < 0) {
    throw new Error('Thiếu cột Chữ Hán hoặc Nghĩa tiếng Việt. Hãy tải file mẫu CSV.');
  }

  const questions = [];
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.every((cell) => String(cell).trim() === '')) continue;
    const hanzi = String(row[hanziColumn] || '').trim();
    const meanings = [
      ...String(row[meaningColumn] || '').split(/[|;/]/),
      ...(aliasesColumn < 0 ? [] : String(row[aliasesColumn] || '').split(/[|;/]/)),
    ].map((meaning) => meaning.trim()).filter(Boolean);
    if (!hanzi || meanings.length === 0) {
      throw new Error(`Dòng ${index + 1} cần có chữ Hán và nghĩa tiếng Việt.`);
    }
    questions.push({ hanzi, meanings });
  }
  if (questions.length === 0) throw new Error('Không tìm thấy câu hỏi hợp lệ trong file.');
  return questions;
}

function socketRequest(event, payload) {
  return new Promise((resolve, reject) => {
    if (!socket || !socket.connected) {
      reject(new Error('Phòng học chưa kết nối. Hãy thử tải lại trang.'));
      return;
    }
    const acknowledge = (result) => {
      if (!result || !result.ok) {
        reject(new Error(result && result.error ? result.error : 'Không thể thực hiện thao tác.'));
        return;
      }
      resolve(result);
    };
    if (payload === undefined) socket.emit(event, acknowledge);
    else socket.emit(event, payload, acknowledge);
  });
}

function setPlayerMenuTab(tab) {
  const tabs = [
    { name: 'profile', tab: profileTab, panel: profilePanel },
    { name: 'inventory', tab: inventoryTab, panel: inventoryPanel },
    { name: 'games', tab: gamesTab, panel: gamesPanel },
  ];
  for (const entry of tabs) {
    const selected = entry.name === tab;
    entry.tab.classList.toggle('active', selected);
    entry.tab.setAttribute('aria-selected', String(selected));
    entry.panel.classList.toggle('hidden', !selected);
  }
}

let currentEquipped = {};
let previewOverrideEquipped = null;

function getItemMeta(itemId) {
  return shopItems.find((candidate) => candidate.itemId === itemId) || null;
}

function syncEquippedToCharacter(equipped) {
  currentEquipped = equipped || {};
  if (worldUser && worldUser.character) {
    worldUser.character.equipped = currentEquipped;
  }
  if (me && me.character) {
    me.character.equipped = currentEquipped;
  }
  drawWorldMap();
  drawShopFittingPreview();
  if (socket && socket.connected) {
    socket.emit('character:sync');
  }
}

async function toggleEquipItem(itemId, button, onDone) {
  if (button) button.disabled = true;
  try {
    const result = await requestJson('/api/shop/equip', { itemId });
    previewOverrideEquipped = null;
    syncEquippedToCharacter(result.equipped);
    shopItems = shopItems.map((entry) => ({
      ...entry,
      equipped: result.equipped[entry.slot] === entry.itemId,
    }));
    renderShopItems();
    if (typeof onDone === 'function') onDone(result);
  } catch (error) {
    if (shopMessage) shopMessage.textContent = error.message || 'Không thể thay đổi trang bị.';
    if (playerMenuMessage) playerMenuMessage.textContent = error.message || 'Không thể thay đổi trang bị.';
  } finally {
    if (button) button.disabled = false;
  }
}

function displayPlayerAccount(account, equippedFromServer) {
  if (equippedFromServer) {
    syncEquippedToCharacter(equippedFromServer);
  }
  const numberFormat = new Intl.NumberFormat('vi-VN');
  document.getElementById('profile-name').textContent =
    worldUser && worldUser.character ? worldUser.character.nickname : '';
  document.getElementById('profile-username').textContent =
    worldUser ? `@${worldUser.username}` : '';
  document.getElementById('profile-level').textContent = numberFormat.format(account.stats.level);
  document.getElementById('profile-exp').textContent = `${numberFormat.format(account.stats.exp)} EXP`;
  document.getElementById('profile-xu').textContent = numberFormat.format(account.stats.xu);

  const inventoryItems = document.getElementById('inventory-items');
  inventoryItems.replaceChildren();
  document.getElementById('inventory-count').textContent =
    `${numberFormat.format(account.inventory.reduce((total, item) => total + item.quantity, 0))} vật phẩm`;
  document.getElementById('inventory-empty').classList.toggle('hidden', account.inventory.length > 0);

  const eq = (worldUser && worldUser.character && worldUser.character.equipped) || currentEquipped || {};

  for (const item of account.inventory) {
    const meta = getItemMeta(item.itemId) || item;
    const isEquipped = meta.slot ? eq[meta.slot] === item.itemId : false;
    const card = document.createElement('article');
    card.className = 'inventory-item' + (isEquipped ? ' is-equipped' : '');

    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 56;
    spriteCanvas.height = 56;
    spriteCanvas.className = 'inventory-item-canvas';
    drawShopItemSprite(spriteCanvas, meta.slot ? meta : { ...meta, slot: 'top', rarity: 'Phổ thông' });

    const name = document.createElement('span');
    name.className = 'inventory-item-name';
    name.textContent = item.name;

    const equipBtn = document.createElement('button');
    equipBtn.type = 'button';
    equipBtn.className = 'inventory-equip-btn' + (isEquipped ? ' active' : '');
    equipBtn.textContent = isEquipped ? 'Đang mặc ✓' : 'Mặc';
    equipBtn.addEventListener('click', () => {
      toggleEquipItem(item.itemId, equipBtn, (res) => {
        displayPlayerAccount(account, res.equipped);
        playerMenuMessage.textContent = res.equipped[meta.slot] === item.itemId
          ? `Đã trang bị ${item.name}!`
          : `Đã tháo ${item.name}.`;
      });
    });

    card.append(spriteCanvas, name, equipBtn);
    inventoryItems.appendChild(card);
  }
}

async function openPlayerMenu() {
  const inClassroom = !document.getElementById('game-screen').classList.contains('hidden');
  const canManageGames = inClassroom && worldUser
    && ['teacher', 'admin'].includes(worldUser.role);
  gamesTab.classList.toggle('hidden', !canManageGames);
  setPlayerMenuTab('profile');
  playerMenuMessage.textContent = 'Đang tải hồ sơ...';
  playerMenuDialog.showModal();
  try {
    if (shopItems.length === 0) {
      const shopData = await requestJson('/api/shop');
      shopItems = shopData.items || [];
      if (shopData.equipped) syncEquippedToCharacter(shopData.equipped);
    }
    const { account, equipped } = await requestJson('/api/auth/account');
    displayPlayerAccount(account, equipped);
    playerMenuMessage.textContent = '';
  } catch (error) {
    playerMenuMessage.textContent = error.message || 'Không thể tải thông tin tài khoản.';
  }
}

document.querySelectorAll('[data-open-player-menu]').forEach((button) => {
  button.addEventListener('click', openPlayerMenu);
});
document.getElementById('close-player-menu').addEventListener('click', () => playerMenuDialog.close());
profileTab.addEventListener('click', () => setPlayerMenuTab('profile'));
inventoryTab.addEventListener('click', () => setPlayerMenuTab('inventory'));
gamesTab.addEventListener('click', () => setPlayerMenuTab('games'));
quizFileInput.addEventListener('change', async () => {
  importedQuizQuestions = [];
  updateQuizControls();
  const [file] = quizFileInput.files;
  if (!file) {
    quizImportMessage.textContent = '';
    return;
  }
  quizImportMessage.textContent = 'Đang đọc file...';
  try {
    importedQuizQuestions = await readQuizFile(file);
    quizImportMessage.textContent = `Đã nhập ${importedQuizQuestions.length} câu hỏi.`;
  } catch (error) {
    quizImportMessage.textContent = error.message || 'Không thể đọc file câu hỏi.';
  }
  updateQuizControls();
});
hanziFileInput.addEventListener('change', async () => {
  importedHanziQuestions = [];
  updateQuizControls();
  const [file] = hanziFileInput.files;
  if (!file) {
    hanziImportMessage.textContent = '';
    return;
  }
  hanziImportMessage.textContent = 'Đang đọc file...';
  try {
    importedHanziQuestions = await readHanziFile(file);
    hanziImportMessage.textContent = `Đã nhập ${importedHanziQuestions.length} chữ Hán.`;
  } catch (error) {
    hanziImportMessage.textContent = error.message || 'Không thể đọc bộ câu hỏi.';
  }
  updateQuizControls();
});
document.getElementById('quiz-template').addEventListener('click', () => {
  const csv = '\uFEFFCâu hỏi,Đáp án A,Đáp án B,Đáp án C,Đáp án D,Đáp án đúng,Giải thích\n'
    + '"你好 nghĩa là gì?","Xin chào","Tạm biệt","Cảm ơn","Xin lỗi","A","你好 có nghĩa là xin chào."\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mau-cau-hoi-tieu-tieu.csv';
  link.click();
  URL.revokeObjectURL(url);
});
document.getElementById('hanzi-template').addEventListener('click', () => {
  const csv = '\uFEFFChữ Hán,Nghĩa tiếng Việt,Nghĩa chấp nhận khác\n'
    + '"你好","xin chào","chào bạn|hello"\n'
    + '"谢谢","cảm ơn","cám ơn|thanks"\n';
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'mau-doan-nghia-han-tu.csv';
  link.click();
  URL.revokeObjectURL(url);
});
quizStartButton.addEventListener('click', async () => {
  quizStartButton.disabled = true;
  try {
    const result = await socketRequest('quiz:start', { questions: importedQuizQuestions });
    quizImportMessage.textContent = `Đã khởi động trò chơi với ${result.state.questionCount} câu hỏi.`;
  } catch (error) {
    quizImportMessage.textContent = error.message;
    updateQuizControls();
  }
});
hanziStartButton.addEventListener('click', async () => {
  hanziStartButton.disabled = true;
  try {
    const result = await socketRequest('hanzi:start', { questions: importedHanziQuestions });
    hanziImportMessage.textContent = `Đã bắt đầu game với ${result.state.questionCount} câu. Mỗi câu có 30 giây.`;
  } catch (error) {
    hanziImportMessage.textContent = error.message;
    updateQuizControls();
  }
});
hanziEndButton.addEventListener('click', async () => {
  hanziEndButton.disabled = true;
  try {
    await socketRequest('hanzi:end');
    hanziImportMessage.textContent = 'Đã kết thúc Đoán Nghĩa Hán Tự.';
  } catch (error) {
    hanziImportMessage.textContent = error.message;
    updateQuizControls();
  }
});
quizNextButton.addEventListener('click', async () => {
  quizNextButton.disabled = true;
  try {
    const result = await socketRequest('quiz:next');
    quizImportMessage.textContent = result.state.status === 'finished'
      ? 'Đã hoàn thành bộ câu hỏi.'
      : `Đang ở câu ${result.state.questionNumber}/${result.state.questionCount}.`;
  } catch (error) {
    quizImportMessage.textContent = error.message;
    updateQuizControls();
  }
});
quizEndButton.addEventListener('click', async () => {
  quizEndButton.disabled = true;
  try {
    await socketRequest('quiz:end');
    quizImportMessage.textContent = 'Đã kết thúc trò chơi.';
  } catch (error) {
    quizImportMessage.textContent = error.message;
    updateQuizControls();
  }
});
playerMenuDialog.addEventListener('click', (event) => {
  if (event.target === playerMenuDialog) playerMenuDialog.close();
});

const shopDialog = document.getElementById('shop-dialog');
const shopItemsElement = document.getElementById('shop-items');
const shopBalanceElement = document.getElementById('shop-balance');
const shopMessage = document.getElementById('shop-message');
const shopPreviewCanvas = document.getElementById('shop-preview-canvas');
const shopPreviewLabel = document.getElementById('shop-preview-label');
const shopResetPreviewBtn = document.getElementById('shop-reset-preview');
const shopEquippedList = document.getElementById('shop-equipped-list');
const shopCategoryLabels = {
  clothing: 'Quần áo',
  accessory: 'Phụ kiện',
  wings: 'Cánh',
  pet: 'Pet',
};
let shopItems = [];
let shopBalance = 0;
let shopCategory = 'all';

function drawShopFittingPreview() {
  if (!shopPreviewCanvas) return;
  const c = shopPreviewCanvas.getContext('2d');
  const w = shopPreviewCanvas.width;
  const h = shopPreviewCanvas.height;
  c.clearRect(0, 0, w, h);
  c.imageSmoothingEnabled = false;

  // Nền phòng thử đồ cổ phong
  const bg = c.createLinearGradient(0, 0, 0, h);
  bg.addColorStop(0, '#4a1512');
  bg.addColorStop(1, '#260a09');
  c.fillStyle = bg;
  c.fillRect(0, 0, w, h);

  // Sàn gỗ + bục tròn
  c.fillStyle = '#5c341d';
  c.fillRect(0, h - 42, w, 42);
  c.fillStyle = '#c89246';
  c.fillRect(14, h - 44, w - 28, 4);

  c.fillStyle = 'rgba(0,0,0,0.35)';
  c.beginPath();
  c.ellipse(w / 2, h - 28, 46, 11, 0, 0, Math.PI * 2);
  c.fill();

  const baseChar = (worldUser && worldUser.character) || defaultCharacter;
  const activeEq = previewOverrideEquipped || baseChar.equipped || currentEquipped || {};
  const previewChar = {
    ...baseChar,
    equipped: activeEq,
  };

  drawAvatar(c, previewChar, '#4d83b6', w / 2 - 4, h - 62, 2.2, {
    walking: false,
    phase: 0,
    now: performance.now(),
  });

  if (shopEquippedList) {
    shopEquippedList.replaceChildren();
    const entries = Object.values(activeEq)
      .map((id) => shopItems.find((it) => it.itemId === id))
      .filter(Boolean);
    if (entries.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'shop-equipped-chip empty';
      empty.textContent = 'Chưa mang phụ kiện/trang phục cửa hàng';
      shopEquippedList.appendChild(empty);
    } else {
      for (const eqItem of entries) {
        const chip = document.createElement('span');
        chip.className = 'shop-equipped-chip';
        chip.textContent = eqItem.name;
        shopEquippedList.appendChild(chip);
      }
    }
  }
}

function previewShopItem(item) {
  const baseEq = { ...((worldUser && worldUser.character && worldUser.character.equipped) || currentEquipped || {}) };
  if (item.slot) {
    baseEq[item.slot] = item.itemId;
    if (item.slot === 'outfit') {
      delete baseEq.top;
      delete baseEq.bottom;
    } else if (item.slot === 'top' || item.slot === 'bottom') {
      delete baseEq.outfit;
    }
  }
  previewOverrideEquipped = baseEq;
  if (shopPreviewLabel) shopPreviewLabel.textContent = `Đang thử: ${item.name}`;
  if (shopResetPreviewBtn) shopResetPreviewBtn.classList.remove('hidden');
  drawShopFittingPreview();
}

if (shopResetPreviewBtn) {
  shopResetPreviewBtn.addEventListener('click', () => {
    previewOverrideEquipped = null;
    if (shopPreviewLabel) shopPreviewLabel.textContent = 'Đang mặc trang phục hiện tại';
    shopResetPreviewBtn.classList.add('hidden');
    drawShopFittingPreview();
  });
}

function filterShopItemsList() {
  if (shopCategory === 'all') return shopItems;
  if (shopCategory.startsWith('collection:')) {
    const col = shopCategory.slice('collection:'.length);
    if (col === 'Lễ hội') {
      return shopItems.filter((item) => item.collection === 'Tết' || item.collection === 'Trung thu');
    }
    return shopItems.filter((item) => item.collection === col);
  }
  return shopItems.filter((item) => item.category === shopCategory);
}

function renderShopItems() {
  shopItemsElement.replaceChildren();
  shopBalanceElement.textContent = `${new Intl.NumberFormat('vi-VN').format(shopBalance)} Xu`;
  const visibleItems = filterShopItemsList();
  const eq = (worldUser && worldUser.character && worldUser.character.equipped) || currentEquipped || {};

  for (const item of visibleItems) {
    const isEquipped = item.slot ? eq[item.slot] === item.itemId : Boolean(item.equipped);
    const raritySlug = {
      'Phổ thông': 'common',
      'Hiếm': 'rare',
      'Sử thi': 'epic',
      'Huyền thoại': 'legendary',
    }[item.rarity] || 'common';

    const card = document.createElement('article');
    card.className = `shop-item-card rarity-${raritySlug}` + (isEquipped ? ' is-equipped' : '');

    const topMeta = document.createElement('div');
    topMeta.className = 'shop-item-topmeta';
    const rarityBadge = document.createElement('span');
    rarityBadge.className = `shop-rarity-badge rarity-${raritySlug}`;
    rarityBadge.textContent = item.rarity;
    const collectionBadge = document.createElement('span');
    collectionBadge.className = 'shop-collection-badge';
    collectionBadge.textContent = item.collection || shopCategoryLabels[item.category];
    topMeta.append(rarityBadge, collectionBadge);

    const spriteWrap = document.createElement('div');
    spriteWrap.className = 'shop-item-sprite-wrap';
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = 68;
    spriteCanvas.height = 68;
    spriteCanvas.className = 'shop-item-canvas';
    drawShopItemSprite(spriteCanvas, item);
    spriteWrap.appendChild(spriteCanvas);

    // Keep hidden .shop-item-icon for screen-reader/legacy compatibility
    const icon = document.createElement('span');
    icon.className = 'shop-item-icon sr-only';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = item.icon;

    const category = document.createElement('span');
    category.className = 'shop-item-category';
    category.textContent = `${shopCategoryLabels[item.category]} · ${item.collection || 'K35'}`;

    const name = document.createElement('h3');
    name.textContent = item.name;
    const description = document.createElement('p');
    description.textContent = item.description;

    const footer = document.createElement('div');
    footer.className = 'shop-item-footer';
    const price = document.createElement('strong');
    price.className = 'shop-item-price';
    price.textContent = `🪙 ${new Intl.NumberFormat('vi-VN').format(item.price)}`;

    const actions = document.createElement('div');
    actions.className = 'shop-item-actions';

    const tryButton = document.createElement('button');
    tryButton.type = 'button';
    tryButton.className = 'shop-try-button';
    tryButton.textContent = 'Thử';
    tryButton.addEventListener('click', () => previewShopItem(item));

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'shop-buy-button' + (item.owned ? (isEquipped ? ' equipped' : ' equip-ready') : '');

    if (item.owned) {
      button.textContent = isEquipped ? 'Đang mặc ✓' : 'Mặc ngay';
      button.disabled = false;
      button.addEventListener('click', () => {
        toggleEquipItem(item.itemId, button, (res) => {
          const nowOn = res.equipped[item.slot] === item.itemId;
          shopMessage.textContent = nowOn
            ? `Đã mặc "${item.name}" lên nhân vật!`
            : `Đã tháo "${item.name}".`;
        });
      });
    } else {
      button.textContent = shopBalance < item.price ? 'Chưa đủ Xu' : 'Mua';
      button.disabled = shopBalance < item.price;
      button.addEventListener('click', () => purchaseShopItem(item, button));
    }

    actions.append(tryButton, button);
    footer.append(price, actions);
    card.append(topMeta, spriteWrap, icon, category, name, description, footer);
    shopItemsElement.appendChild(card);
  }
  drawShopFittingPreview();
}

async function openShop() {
  shopCategory = 'all';
  previewOverrideEquipped = null;
  if (shopPreviewLabel) shopPreviewLabel.textContent = 'Đang mặc trang phục hiện tại';
  if (shopResetPreviewBtn) shopResetPreviewBtn.classList.add('hidden');
  document.querySelectorAll('.shop-category').forEach((button) => {
    const selected = button.dataset.category === shopCategory;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  shopItemsElement.replaceChildren();
  shopMessage.textContent = 'Đang tải cửa hàng...';
  shopDialog.showModal();
  drawShopFittingPreview();
  try {
    const result = await requestJson('/api/shop');
    shopItems = result.items;
    shopBalance = result.balance;
    if (result.equipped) {
      syncEquippedToCharacter(result.equipped);
    }
    renderShopItems();
    shopMessage.textContent = `Có ${shopItems.length} vật phẩm · Bấm "Thử" để xem trước hoặc "Mặc ngay" với món đã mua!`;
  } catch (error) {
    shopMessage.textContent = error.message || 'Không thể tải cửa hàng.';
  }
}

async function purchaseShopItem(item, button) {
  button.disabled = true;
  shopMessage.textContent = `Đang mua ${item.name}...`;
  let purchase;
  try {
    purchase = await requestJson('/api/shop/purchase', { itemId: item.itemId });
  } catch (error) {
    shopMessage.textContent = error.message || 'Không thể mua vật phẩm.';
    button.disabled = item.owned || shopBalance < item.price;
    return;
  }

  shopBalance = purchase.balance;
  shopItems = shopItems.map((shopItem) => (
    shopItem.itemId === item.itemId ? { ...shopItem, owned: true } : shopItem
  ));
  renderShopItems();

  try {
    const equipRes = await requestJson('/api/shop/equip', { itemId: item.itemId });
    syncEquippedToCharacter(equipRes.equipped);
    shopItems = shopItems.map((shopItem) => (
      { ...shopItem, equipped: equipRes.equipped[shopItem.slot] === shopItem.itemId }
    ));
    renderShopItems();
    shopMessage.textContent = `Đã mua và mặc ngay "${item.name}"! Bạn có thể đổi đồ bất cứ lúc nào.`;
  } catch (error) {
    shopMessage.textContent =
      `Đã mua "${item.name}" và cất vào rương, nhưng chưa thể tự mặc: ${error.message || 'lỗi không xác định'}. Bạn có thể thử mặc lại trong rương đồ.`;
  }
}

document.querySelectorAll('.shop-category').forEach((button) => {
  button.addEventListener('click', () => {
    shopCategory = button.dataset.category;
    document.querySelectorAll('.shop-category').forEach((categoryButton) => {
      const selected = categoryButton === button;
      categoryButton.classList.toggle('active', selected);
      categoryButton.setAttribute('aria-pressed', String(selected));
    });
    renderShopItems();
  });
});
document.getElementById('close-shop').addEventListener('click', () => shopDialog.close());
shopDialog.addEventListener('click', (event) => {
  if (event.target === shopDialog) shopDialog.close();
});

document.querySelectorAll('.map-hotspot').forEach((hotspot) => {
  hotspot.addEventListener('click', () => {
    const destination = hotspot.dataset.destination;
    if (destination === 'school') {
      showGame(worldUser);
      return;
    }
    if (destination === 'shop') {
      openShop();
      return;
    }

    const places = {
      campus: ['Khuôn viên', 'Bạn đang ở khuôn viên Tiểu Tiểu. Các khu vực tham quan sẽ được mở dần.'],
      house: ['Nhà', 'Khu nhà riêng và tùy chỉnh không gian sẽ được mở trong bản cập nhật sau.'],
      farm: ['Trang trại', 'Trang trại và các hoạt động trồng trọt đang được phát triển.'],
    };
    const [title, description] = places[destination] || ['Khu vực', 'Khu vực này chưa mở.'];
    document.getElementById('destination-title').textContent = title;
    document.getElementById('destination-description').textContent = description;
    document.getElementById('destination-dialog').showModal();
  });
});

document.getElementById('back-to-world').addEventListener('click', () => {
  if (socket) socket.disconnect();
  socket = null;
  me = null;
  others.clear();
  bubbles.clear();
  chatLog.replaceChildren();
  showWorld(worldUser);
});

requestJson('/api/auth/me')
  .then(({ user }) => showAuthenticatedUser(user))
  .catch((error) => {
    if (error.message !== 'Vui lòng đăng nhập.' && error.message !== 'Phiên đăng nhập đã hết hạn.') {
      showAuthMessage(error.message || 'Không thể kết nối máy chủ. Vui lòng thử lại.');
    }
  });

drawWorldMap();

// ---------- Chat ----------
const chatLog = document.getElementById('chat-log');
function addChatLine(name, text) {
  const div = document.createElement('div');
  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = name + ': ';
  div.appendChild(who);
  div.appendChild(document.createTextNode(text));
  chatLog.appendChild(div);
  chatLog.scrollTop = chatLog.scrollHeight;
}

function sendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text || !socket) return;
  socket.emit('chat', { text });
  if (quizState.status === 'active' && worldUser && worldUser.role === 'student'
    && /^[A-D]$/i.test(text)) {
    if (quizAnswerLocked) {
      document.getElementById('quiz-stage-message').textContent =
        'Bạn đã trả lời câu này. Hãy chờ giáo viên chuyển sang câu tiếp theo.';
    } else {
      submitQuizAnswer(text.toUpperCase());
    }
    input.value = '';
    return;
  }
  input.value = '';
}
document.getElementById('chat-row').addEventListener('submit', (event) => {
  event.preventDefault();
  sendChat();
});

// ---------- Vào lớp ----------
function updateCount() {
  const n = others.size + (me ? 1 : 0);
  document.getElementById('count-label').textContent = n + ' người';
}


// ---------- Hiệu ứng nền khuôn viên: cánh hoa rơi + đom đóm ----------
(function createWorldEffects() {
  const screen = document.getElementById('world-screen');
  if (!screen || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const layer = document.createElement('div');
  layer.className = 'world-fx';
  layer.setAttribute('aria-hidden', 'true');
  const small = window.innerWidth < 600;
  for (let i = 0; i < (small ? 14 : 26); i += 1) {
    const petal = document.createElement('span');
    petal.className = 'petal';
    petal.style.left = `${Math.random() * 100}%`;
    petal.style.setProperty('--dur', `${9 + Math.random() * 8}s`);
    petal.style.setProperty('--delay', `${-Math.random() * 14}s`);
    petal.style.setProperty('--drift', `${40 + Math.random() * 90}px`);
    petal.style.transform = `scale(${0.7 + Math.random() * 0.8})`;
    layer.appendChild(petal);
  }
  for (let i = 0; i < (small ? 8 : 14); i += 1) {
    const fly = document.createElement('span');
    fly.className = 'firefly';
    fly.style.setProperty('--x', `${Math.random() * 100}%`);
    fly.style.setProperty('--y', `${5 + Math.random() * 45}%`);
    fly.style.setProperty('--dur', `${4 + Math.random() * 5}s`);
    fly.style.setProperty('--delay', `${-Math.random() * 8}s`);
    layer.appendChild(fly);
  }
  screen.prepend(layer);
})();
