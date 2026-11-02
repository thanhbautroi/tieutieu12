const express = require('express');
const { requireAuthentication } = require('./auth');

const SHOP_ITEMS = [
  // ================= QUẦN ÁO (CLOTHING) — 17 MÓN =================
  {
    itemId: 'school-hoodie',
    name: 'Áo hoodie K35',
    category: 'clothing',
    slot: 'top',
    collection: 'Trường học',
    price: 60,
    icon: '👕',
    rarity: 'Phổ thông',
    description: 'Áo hoodie ấm áp mang màu sắc lớp K35.',
  },
  {
    itemId: 'white-school-shirt',
    name: 'Áo sơ mi học đường K35',
    category: 'clothing',
    slot: 'top',
    collection: 'Trường học',
    price: 45,
    icon: '👔',
    rarity: 'Phổ thông',
    description: 'Áo sơ mi trắng kèm cà vạt đỏ thanh lịch của học viện Tiểu Tiểu.',
  },
  {
    itemId: 'sailor-uniform',
    name: 'Đồng phục thủy thủ K35',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Trường học',
    price: 95,
    icon: '🎽',
    rarity: 'Hiếm',
    description: 'Bộ đồng phục cổ thủy thủ xanh hải quân kèm nơ đỏ trẻ trung.',
  },
  {
    itemId: 'red-bomber',
    name: 'Áo khoác Bomber đỏ',
    category: 'clothing',
    slot: 'top',
    collection: 'Thời trang',
    price: 85,
    icon: '🧥',
    rarity: 'Phổ thông',
    description: 'Áo khoác bóng chày viền trắng cực năng động nơi sân trường.',
  },
  {
    itemId: 'panda-hoodie',
    name: 'Áo hoodie gấu trúc',
    category: 'clothing',
    slot: 'top',
    collection: 'Gấu trúc',
    price: 120,
    icon: '🐼',
    rarity: 'Hiếm',
    description: 'Chiếc hoodie gấu trúc đáng yêu cho ngày đến lớp.',
  },
  {
    itemId: 'panda-suit',
    name: 'Bộ đồ Gấu trúc bông',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Gấu trúc',
    price: 210,
    icon: '🐼',
    rarity: 'Sử thi',
    description: 'Bộ bodysuit gấu trúc mềm mịn nguyên cây thuộc bộ sưu tập Gấu trúc.',
  },
  {
    itemId: 'festival-outfit',
    name: 'Trang phục lễ hội',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Tết',
    price: 180,
    icon: '🧧',
    rarity: 'Hiếm',
    description: 'Bộ đồ đỏ rực rỡ lấy cảm hứng từ lễ hội mùa xuân.',
  },
  {
    itemId: 'tet-aodai-red',
    name: 'Áo dài gấm đỏ ngày Tết',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Tết',
    price: 195,
    icon: '🏮',
    rarity: 'Hiếm',
    description: 'Áo dài truyền thống thêu họa tiết hoa mai vàng rực rỡ đón xuân.',
  },
  {
    itemId: 'tet-aodai-gold',
    name: 'Áo dài Hoàng Kim Phúc Lộc',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Tết',
    price: 260,
    icon: '✨',
    rarity: 'Sử thi',
    description: 'Áo dài gấm vàng vương giả thêu vân mây cổ phong ngày Tết.',
  },
  {
    itemId: 'trungthu-outfit',
    name: 'Lễ phục đêm Trung thu',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Trung thu',
    price: 175,
    icon: '🥮',
    rarity: 'Hiếm',
    description: 'Trang phục cổ phong ngọc bích phối đai lụa đỏ dự hội rước đèn.',
  },
  {
    itemId: 'astro-suit',
    name: 'Bộ đồ Phi hành gia',
    category: 'clothing',
    slot: 'outfit',
    collection: 'Phi hành gia',
    price: 290,
    icon: '👩‍🚀',
    rarity: 'Sử thi',
    description: 'Bộ giáp du hành vũ trụ trắng bạc với bảng điều khiển trước ngực.',
  },
  {
    itemId: 'jean-pants',
    name: 'Quần jean xanh năng động',
    category: 'clothing',
    slot: 'bottom',
    collection: 'Trường học',
    price: 50,
    icon: '👖',
    rarity: 'Phổ thông',
    description: 'Quần bò xanh xắn gấu trẻ trung dễ phối với mọi loại áo.',
  },
  {
    itemId: 'plaid-skirt',
    name: 'Chân váy caro học đường',
    category: 'clothing',
    slot: 'bottom',
    collection: 'Trường học',
    price: 55,
    icon: '👗',
    rarity: 'Phổ thông',
    description: 'Chân váy xếp ly kẻ caro đỏ đen chuẩn phong cách học viện.',
  },
  {
    itemId: 'kaki-shorts',
    name: 'Quần short kaki dã ngoại',
    category: 'clothing',
    slot: 'bottom',
    collection: 'Thời trang',
    price: 45,
    icon: '🩳',
    rarity: 'Phổ thông',
    description: 'Quần short kaki kem thoáng mát cho những buổi ngoại khóa.',
  },
  {
    itemId: 'red-sneakers',
    name: 'Giày thể thao cổ đỏ',
    category: 'clothing',
    slot: 'shoes',
    collection: 'Trường học',
    price: 50,
    icon: '👟',
    rarity: 'Phổ thông',
    description: 'Giày sneaker trắng phối đỏ nổi bật trên từng bước chạy.',
  },
  {
    itemId: 'leather-boots',
    name: 'Giày bốt da cổ cao',
    category: 'clothing',
    slot: 'shoes',
    collection: 'Thời trang',
    price: 70,
    icon: '🥾',
    rarity: 'Hiếm',
    description: 'Đôi bốt da nâu khâu chỉ vàng cực chất và cá tính.',
  },
  {
    itemId: 'glow-shoes',
    name: 'Giày phản lực ánh sáng',
    category: 'clothing',
    slot: 'shoes',
    collection: 'Phi hành gia',
    price: 135,
    icon: '⚡',
    rarity: 'Sử thi',
    description: 'Giày công nghệ vũ trụ phát viền neon xanh lam dưới đế.',
  },

  // ================= PHỤ KIỆN (ACCESSORY) — 19 MÓN =================
  {
    itemId: 'blue-backpack',
    name: 'Balo học sinh xanh',
    category: 'accessory',
    slot: 'bag',
    collection: 'Trường học',
    price: 40,
    icon: '🎒',
    rarity: 'Phổ thông',
    description: 'Chiếc balo gọn nhẹ để mang theo sách vở.',
  },
  {
    itemId: 'panda-backpack',
    name: 'Balo gấu trúc',
    category: 'accessory',
    slot: 'bag',
    collection: 'Gấu trúc',
    price: 75,
    icon: '🐼',
    rarity: 'Phổ thông',
    description: 'Balo nhỏ với gương mặt gấu trúc thân thiện.',
  },
  {
    itemId: 'bamboo-backpack',
    name: 'Giỏ trúc đeo lưng',
    category: 'accessory',
    slot: 'bag',
    collection: 'Gấu trúc',
    price: 95,
    icon: '🎍',
    rarity: 'Hiếm',
    description: 'Giỏ mây đan đựng những nhánh trúc xanh mướt sau lưng.',
  },
  {
    itemId: 'lantern-bag',
    name: 'Đèn lồng ông sao Trung thu',
    category: 'accessory',
    slot: 'bag',
    collection: 'Trung thu',
    price: 110,
    icon: '🏮',
    rarity: 'Hiếm',
    description: 'Chiếc đèn ông sao năm cánh tỏa sáng ấm áp bên người.',
  },
  {
    itemId: 'lixi-bag',
    name: 'Túi gấm Lì xì đại cát',
    category: 'accessory',
    slot: 'bag',
    collection: 'Tết',
    price: 100,
    icon: '🧧',
    rarity: 'Hiếm',
    description: 'Túi gấm đỏ thêu chữ Phúc mang lại may mắn cả năm.',
  },
  {
    itemId: 'astro-jetpack',
    name: 'Balo tên lửa phản lực',
    category: 'accessory',
    slot: 'bag',
    collection: 'Phi hành gia',
    price: 195,
    icon: '🚀',
    rarity: 'Sử thi',
    description: 'Balo động cơ đôi phát tia lửa ion xanh thuộc bộ Phi hành gia.',
  },
  {
    itemId: 'round-glasses',
    name: 'Kính tròn',
    category: 'accessory',
    slot: 'glasses',
    collection: 'Trường học',
    price: 35,
    icon: '👓',
    rarity: 'Phổ thông',
    description: 'Kính tròn dành cho nhà thông thái của lớp.',
  },
  {
    itemId: 'star-glasses',
    name: 'Kính ngôi sao',
    category: 'accessory',
    slot: 'glasses',
    collection: 'Thời trang',
    price: 80,
    icon: '🕶️',
    rarity: 'Hiếm',
    description: 'Kính ngôi sao nổi bật trên sân trường.',
  },
  {
    itemId: 'sun-glasses',
    name: 'Kính râm Pixel ngầu',
    category: 'accessory',
    slot: 'glasses',
    collection: 'Thời trang',
    price: 65,
    icon: '😎',
    rarity: 'Phổ thông',
    description: 'Kính đen pixel phong cách chất chơi bậc nhất K35.',
  },
  {
    itemId: 'non-la',
    name: 'Nón lá quê hương',
    category: 'accessory',
    slot: 'hat',
    collection: 'Tết',
    price: 55,
    icon: '👒',
    rarity: 'Phổ thông',
    description: 'Chiếc nón lá mộc mạc duyên dáng với quai lụa hồng.',
  },
  {
    itemId: 'tet-khan-dong',
    name: 'Khăn đóng truyền thống',
    category: 'accessory',
    slot: 'hat',
    collection: 'Tết',
    price: 115,
    icon: '👑',
    rarity: 'Hiếm',
    description: 'Khăn xếp gấm đỏ viền kim tuyến sang trọng dịp lễ Tết.',
  },
  {
    itemId: 'trungthu-rabbit-ears',
    name: 'Mũ tai Thỏ Ngọc',
    category: 'accessory',
    slot: 'hat',
    collection: 'Trung thu',
    price: 90,
    icon: '🐰',
    rarity: 'Hiếm',
    description: 'Đôi tai thỏ trắng hồng mềm mại đón trăng rằm tháng Tám.',
  },
  {
    itemId: 'grad-cap',
    name: 'Mũ cử nhân thủ khoa K35',
    category: 'accessory',
    slot: 'hat',
    collection: 'Trường học',
    price: 85,
    icon: '🎓',
    rarity: 'Hiếm',
    description: 'Mũ tốt nghiệp đính tua rua vàng dành cho học sinh xuất sắc.',
  },
  {
    itemId: 'panda-ears-hat',
    name: 'Mũ trùm tai Gấu trúc',
    category: 'accessory',
    slot: 'hat',
    collection: 'Gấu trúc',
    price: 95,
    icon: '🐼',
    rarity: 'Hiếm',
    description: 'Mũ bông có đôi tai tròn đen trắng cực kỳ đáng yêu.',
  },
  {
    itemId: 'astro-helmet',
    name: 'Mũ kính Phi hành gia',
    category: 'accessory',
    slot: 'hat',
    collection: 'Phi hành gia',
    price: 185,
    icon: '🪐',
    rarity: 'Sử thi',
    description: 'Mũ bảo hộ không gian với mặt kính phản quang ánh xanh.',
  },
  {
    itemId: 'red-scarf',
    name: 'Khăn quàng đỏ học sinh',
    category: 'accessory',
    slot: 'neck',
    collection: 'Trường học',
    price: 30,
    icon: '🧣',
    rarity: 'Phổ thông',
    description: 'Chiếc khăn quàng đỏ thắm tung bay trên vai áo học trò.',
  },
  {
    itemId: 'winter-wool-scarf',
    name: 'Khăn len sọc ấm áp',
    category: 'accessory',
    slot: 'neck',
    collection: 'Thời trang',
    price: 50,
    icon: '🧣',
    rarity: 'Phổ thông',
    description: 'Khăn len đan sọc vàng kem giữ ấm ngày đông se lạnh.',
  },
  {
    itemId: 'silk-ribbon-bow',
    name: 'Nơ lụa đỏ cài tóc',
    category: 'accessory',
    slot: 'bow',
    collection: 'Trường học',
    price: 45,
    icon: '🎀',
    rarity: 'Phổ thông',
    description: 'Chiếc nơ lụa đỏ xinh xắn điểm tô mái tóc.',
  },
  {
    itemId: 'gold-hair-bow',
    name: 'Trâm nơ hồ điệp ánh kim',
    category: 'accessory',
    slot: 'bow',
    collection: 'Trung thu',
    price: 90,
    icon: '🎗️',
    rarity: 'Hiếm',
    description: 'Nơ cài tóc thêu kim tuyến vàng lấp lánh dưới ánh trăng.',
  },

  // ================= CÁNH (WINGS) — 5 MÓN =================
  {
    itemId: 'cloud-wings',
    name: 'Cánh mây',
    category: 'wings',
    slot: 'wings',
    collection: 'Thần thoại',
    price: 250,
    icon: '☁️',
    rarity: 'Sử thi',
    description: 'Đôi cánh mây nhẹ nhàng, chỉ dùng để trang trí.',
  },
  {
    itemId: 'butterfly-wings',
    name: 'Cánh bướm',
    category: 'wings',
    slot: 'wings',
    collection: 'Thần thoại',
    price: 300,
    icon: '🦋',
    rarity: 'Sử thi',
    description: 'Đôi cánh bướm rực rỡ, không tạo lợi thế khi chơi.',
  },
  {
    itemId: 'angel-wings',
    name: 'Cánh thiên thần ánh sáng',
    category: 'wings',
    slot: 'wings',
    collection: 'Thần thoại',
    price: 340,
    icon: '🪽',
    rarity: 'Huyền thoại',
    description: 'Đôi cánh lông vũ trắng thuần khiết có hạt sáng pixel bay nhẹ.',
  },
  {
    itemId: 'fairy-wings',
    name: 'Cánh tiên pha lê',
    category: 'wings',
    slot: 'wings',
    collection: 'Trung thu',
    price: 280,
    icon: '🧚',
    rarity: 'Sử thi',
    description: 'Cánh tiên trong suốt ánh ngọc lục bảo lung linh nhẹ nhàng.',
  },
  {
    itemId: 'astro-jet-wings',
    name: 'Cánh quang năng ngân hà',
    category: 'wings',
    slot: 'wings',
    collection: 'Phi hành gia',
    price: 380,
    icon: '🌌',
    rarity: 'Huyền thoại',
    description: 'Cánh năng lượng plasma xanh tím của đội trưởng Phi hành gia.',
  },

  // ================= THÚ CƯNG (PET) — 6 MÓN =================
  {
    itemId: 'panda-pet',
    name: 'Pet gấu trúc',
    category: 'pet',
    slot: 'pet',
    collection: 'Gấu trúc',
    price: 300,
    icon: '🐼',
    rarity: 'Sử thi',
    description: 'Người bạn gấu trúc đồng hành bên bạn.',
  },
  {
    itemId: 'orange-cat-pet',
    name: 'Pet mèo cam',
    category: 'pet',
    slot: 'pet',
    collection: 'Trường học',
    price: 280,
    icon: '🐈',
    rarity: 'Sử thi',
    description: 'Chú mèo cam tinh nghịch thích theo bạn đến lớp.',
  },
  {
    itemId: 'jade-rabbit-pet',
    name: 'Pet Thỏ Ngọc cung trăng',
    category: 'pet',
    slot: 'pet',
    collection: 'Trung thu',
    price: 310,
    icon: '🐇',
    rarity: 'Sử thi',
    description: 'Chú thỏ trắng ôm bánh nướng lon ton nhảy theo chân bạn.',
  },
  {
    itemId: 'shiba-dog-pet',
    name: 'Pet Cún Shiba đeo khăn',
    category: 'pet',
    slot: 'pet',
    collection: 'Trường học',
    price: 290,
    icon: '🐕',
    rarity: 'Sử thi',
    description: 'Chú cún Shiba mặt cười trung thành luôn chạy sát bên chủ.',
  },
  {
    itemId: 'golden-dragon-pet',
    name: 'Pet Tiểu Long Hoàng Kim',
    category: 'pet',
    slot: 'pet',
    collection: 'Tết',
    price: 420,
    icon: '🐉',
    rarity: 'Huyền thoại',
    description: 'Rồng nhỏ cát tường bay lơ lửng tỏa hào quang may mắn.',
  },
  {
    itemId: 'astro-drone-pet',
    name: 'Pet Robot Tinh Cầu',
    category: 'pet',
    slot: 'pet',
    collection: 'Phi hành gia',
    price: 350,
    icon: '🤖',
    rarity: 'Huyền thoại',
    description: 'Vệ tinh mini thông minh bay lượn quanh các nhà du hành vũ trụ.',
  },
];

function createShopRouter(auth) {
  const router = express.Router();
  router.use(requireAuthentication(auth));

  router.get('/', async (request, response, next) => {
    try {
      const account = await auth.getAccountData(request.authUser._id);
      if (!account) return response.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      const ownedItems = new Set(account.inventory.map((item) => item.itemId));
      const equipped = (request.authUser.character && request.authUser.character.equipped) || {};
      return response.json({
        balance: account.stats.xu,
        equipped,
        items: SHOP_ITEMS.map((item) => ({
          ...item,
          owned: ownedItems.has(item.itemId),
          equipped: equipped[item.slot] === item.itemId,
        })),
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/purchase', async (request, response, next) => {
    const itemId = request.body && request.body.itemId;
    const item = typeof itemId === 'string'
      ? SHOP_ITEMS.find((candidate) => candidate.itemId === itemId)
      : null;
    if (!item) return response.status(400).json({ error: 'Vật phẩm cửa hàng không hợp lệ.' });

    try {
      const account = await auth.getAccountData(request.authUser._id);
      if (!account) return response.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      if (account.inventory.some((ownedItem) => ownedItem.itemId === item.itemId)) {
        return response.status(409).json({ error: 'Bạn đã sở hữu vật phẩm này rồi.' });
      }

      const result = await auth.users.updateOne(
        {
          _id: request.authUser._id,
          status: 'active',
          'gameStats.xu': { $gte: item.price },
          inventory: { $not: { $elemMatch: { itemId: item.itemId } } },
        },
        {
          $inc: { 'gameStats.xu': -item.price },
          $push: {
            inventory: {
              itemId: item.itemId,
              name: item.name,
              category: item.category,
              quantity: 1,
              description: item.description,
            },
          },
          $set: { updatedAt: new Date() },
        },
      );
      if (result.matchedCount !== 1) {
        const latest = await auth.getAccountData(request.authUser._id);
        if (!latest) return response.status(404).json({ error: 'Không tìm thấy tài khoản.' });
        if (latest.inventory.some((ownedItem) => ownedItem.itemId === item.itemId)) {
          return response.status(409).json({ error: 'Bạn đã sở hữu vật phẩm này rồi.' });
        }
        return response.status(409).json({ error: 'Bạn chưa đủ Xu để mua vật phẩm này.' });
      }

      const updatedAccount = await auth.getAccountData(request.authUser._id);
      if (!updatedAccount) return response.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      return response.status(201).json({
        item,
        balance: updatedAccount.stats.xu,
        inventory: updatedAccount.inventory,
      });
    } catch (error) {
      return next(error);
    }
  });

  router.post('/equip', async (request, response, next) => {
    const itemId = request.body && request.body.itemId;
    const item = typeof itemId === 'string'
      ? SHOP_ITEMS.find((candidate) => candidate.itemId === itemId)
      : null;
    if (!item || !item.slot) {
      return response.status(400).json({ error: 'Vật phẩm trang bị không hợp lệ.' });
    }
    if (!request.authUser.character) {
      return response.status(400).json({ error: 'Hãy tạo nhân vật trước khi mặc trang phục.' });
    }

    try {
      const account = await auth.getAccountData(request.authUser._id);
      if (!account) return response.status(404).json({ error: 'Không tìm thấy tài khoản.' });
      const ownsItem = account.inventory.some((owned) => owned.itemId === item.itemId);
      if (!ownsItem) {
        return response.status(403).json({ error: 'Bạn cần sở hữu vật phẩm này trước khi trang bị.' });
      }

      const currentEquipped = {
        ...((request.authUser.character && request.authUser.character.equipped) || {}),
      };
      const isAlreadyEquipped = currentEquipped[item.slot] === item.itemId;

      if (isAlreadyEquipped) {
        delete currentEquipped[item.slot];
      } else {
        currentEquipped[item.slot] = item.itemId;
        if (item.slot === 'outfit') {
          delete currentEquipped.top;
          delete currentEquipped.bottom;
        } else if (item.slot === 'top' || item.slot === 'bottom') {
          delete currentEquipped.outfit;
        }
      }

      const nextCharacter = {
        ...request.authUser.character,
        equipped: currentEquipped,
      };

      await auth.users.updateOne(
        { _id: request.authUser._id, status: 'active' },
        { $set: { character: nextCharacter, updatedAt: new Date() } },
      );

      return response.json({
        equipped: currentEquipped,
        character: nextCharacter,
      });
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

module.exports = { SHOP_ITEMS, createShopRouter };
