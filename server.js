const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('采购大战 服务器运行中');
});

const wss = new WebSocket.Server({ server });

// rooms[roomId] = { players, gameState }
const rooms = {};

// ── 游戏常量 ──
const ROLES = {
  merchant: { name: '商人', emoji: '🧑‍💼', talent: '智慧', desc: '价格类竞拍出价上限+25%', bonus: { price: 0.25 } },
  driver:   { name: '司机', emoji: '🚗',    talent: '体力', desc: '交通类竞拍费用-15%',    bonus: { transport: -0.15 } },
  porter:   { name: '搬运工', emoji: '💪',  talent: '力量', desc: '运输类竞拍费用-15%',    bonus: { logistics: -0.15 } },
  broker:   { name: '掮客', emoji: '🕵️',   talent: '人脉', desc: '可看到最高出价',         bonus: { spy: true } },
  gambler:  { name: '赌徒', emoji: '🎲',    talent: '运气', desc: '每轮随机±10%加成',      bonus: { luck: true } },
  scholar:  { name: '学者', emoji: '📚',    talent: '分析', desc: '可预览次日物品',         bonus: { preview: true } },
};

const CATEGORIES = [
  { id: 'transport',  name: '🚗 交通',   desc: '运输货物所需的车辆' },
  { id: 'price',      name: '💰 货源',   desc: '采购原材料的供应商' },
  { id: 'logistics',  name: '📦 运输',   desc: '搬运和配送服务' },
];

const ITEMS_POOL = {
  transport: [
    { name: '普通货车', basePrice: 800, quality: 1 },
    { name: '冷链运输', basePrice: 1500, quality: 2 },
    { name: '高速快递', basePrice: 2200, quality: 3 },
    { name: '豪华专车', basePrice: 3000, quality: 4 },
  ],
  price: [
    { name: '散户供应商', basePrice: 600, quality: 1 },
    { name: '正规工厂',   basePrice: 1200, quality: 2 },
    { name: '品牌代理',   basePrice: 2000, quality: 3 },
    { name: '独家渠道',   basePrice: 3500, quality: 4 },
  ],
  logistics: [
    { name: '人力搬运', basePrice: 500, quality: 1 },
    { name: '机械装卸', basePrice: 1100, quality: 2 },
    { name: '专业团队', basePrice: 1800, quality: 3 },
    { name: '全程托管', basePrice: 2800, quality: 4 },
  ],
};

const TASK_REQUIREMENT = 10; // 每类任务需要的总质量点数（5天内完成）
const INITIAL_COINS = 10000;
const BID_DURATION = 20; // 竞拍倒计时秒数
const RENT_DURATION = 30; // 定租金倒计时秒数

// ── 工具函数 ──
function randomItem(category) {
  const pool = ITEMS_POOL[category];
  const item = pool[Math.floor(Math.random() * pool.length)];
  const variance = 0.85 + Math.random() * 0.3;
  return {
    ...item,
    category,
    actualPrice: Math.round(item.basePrice * variance),
    id: Date.now() + Math.random(),
  };
}

function generateDayItems() {
  return CATEGORIES.map(cat => randomItem(cat.id));
}

function applyRoleBonus(role, category, price) {
  const bonus = ROLES[role]?.bonus || {};
  let modifier = 1;
  if (category === 'price'     && bonus.price)     modifier += bonus.price;
  if (category === 'transport' && bonus.transport)  modifier += bonus.transport;
  if (category === 'logistics' && bonus.logistics)  modifier += bonus.logistics;
  if (bonus.luck) modifier += (Math.random() - 0.5) * 0.2;
  return Math.round(price * Math.max(0.5, modifier));
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws.readyState === WebSocket.OPEN) {
      p.ws.send(JSON.stringify(msg));
    }
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getRoomSummary(room) {
  return room.players.map(p => ({
    id: p.id,
    name: p.name,
    role: p.role,
    coins: p.coins,
    spent: INITIAL_COINS - p.coins,
    taskProgress: p.taskProgress,
    connected: p.ws.readyState === WebSocket.OPEN,
  }));
}

// ── 竞拍逻辑 ──
function startBidding(room) {
  const gs = room.gameState;
  if (gs.currentItemIndex >= gs.dayItems.length) {
    endDay(room);
    return;
  }

  const item = gs.dayItems[gs.currentItemIndex];
  gs.phase = 'bidding';
  gs.currentBid = item.actualPrice; // 起拍价
  gs.currentBidder = null;
  gs.bids = {};
  gs.timeLeft = BID_DURATION;

  broadcast(room, {
    type: 'BIDDING_START',
    item,
    timeLeft: gs.timeLeft,
    players: getRoomSummary(room),
  });

  clearInterval(gs.bidTimer);
  gs.bidTimer = setInterval(() => {
    gs.timeLeft--;
    broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'bidding' });
    if (gs.timeLeft <= 0) {
      clearInterval(gs.bidTimer);
      endBidding(room);
    }
  }, 1000);
}

function endBidding(room) {
  const gs = room.gameState;
  const item = gs.dayItems[gs.currentItemIndex];

  if (!gs.currentBidder) {
    // 无人出价
    broadcast(room, { type: 'NO_WINNER', item, message: '无人竞拍，该物品流拍！' });
    gs.currentItemIndex++;
    gs.noWinCount = (gs.noWinCount || 0) + 1;
    setTimeout(() => startBidding(room), 2000);
    return;
  }

  const winner = room.players.find(p => p.id === gs.currentBidder);
  winner.coins -= gs.currentBid;
  winner.items = winner.items || [];
  winner.items.push({ ...item, paidPrice: gs.currentBid });

  gs.phase = 'renting';
  gs.rentItem = { ...item, paidPrice: gs.currentBid };
  gs.rentWinner = gs.currentBidder;
  gs.rentPrices = {};
  gs.timeLeft = RENT_DURATION;

  broadcast(room, {
    type: 'BIDDING_END',
    winner: { id: winner.id, name: winner.name },
    item,
    paidPrice: gs.currentBid,
    players: getRoomSummary(room),
    message: `${winner.name} 以 ${gs.currentBid} 金币拍下！现在设定租用价格...`,
  });

  // 给掮客发特殊信息
  room.players.forEach(p => {
    if (p.role === 'broker') {
      sendTo(p.ws, { type: 'SPY_INFO', bids: gs.bids });
    }
  });

  gs.rentTimer = setInterval(() => {
    gs.timeLeft--;
    broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'renting' });
    if (gs.timeLeft <= 0) {
      clearInterval(gs.rentTimer);
      // 自动设定最高租价
      if (!gs.rentPrices[gs.currentBidder]) {
        gs.rentPrices[gs.currentBidder] = gs.currentBid;
      }
      resolveRenting(room);
    }
  }, 1000);
}

function resolveRenting(room) {
  const gs = room.gameState;
  const winner = room.players.find(p => p.id === gs.rentWinner);
  const item = gs.rentItem;
  const rentPrice = gs.rentPrices[gs.rentWinner] || gs.currentBid;

  const results = [];
  room.players.forEach(p => {
    if (p.id === gs.rentWinner) return;
    const declined = gs.rentDeclined?.[p.id];
    if (!declined) {
      const effectivePrice = applyRoleBonus(p.role, item.category, rentPrice);
      p.coins -= effectivePrice;
      winner.coins += effectivePrice;
      // 任务进度
      p.taskProgress[item.category] = (p.taskProgress[item.category] || 0) + item.quality;
      results.push({ playerId: p.id, name: p.name, paid: effectivePrice, accepted: true });
    } else {
      results.push({ playerId: p.id, name: p.name, paid: 0, accepted: false });
    }
  });
  // 拍下者自己也完成任务
  winner.taskProgress[item.category] = (winner.taskProgress[item.category] || 0) + item.quality;

  broadcast(room, {
    type: 'RENT_RESOLVED',
    item,
    rentPrice,
    winner: { id: winner.id, name: winner.name },
    results,
    players: getRoomSummary(room),
  });

  gs.currentItemIndex++;
  setTimeout(() => startBidding(room), 3000);
}

function endDay(room) {
  const gs = room.gameState;
  gs.day++;

  if (gs.day > 5) {
    endGame(room);
    return;
  }

  // 学者预览
  const nextItems = generateDayItems();
  gs.dayItems = nextItems;
  gs.currentItemIndex = 0;
  gs.phase = 'day_start';

  broadcast(room, {
    type: 'DAY_END',
    day: gs.day,
    players: getRoomSummary(room),
    message: `第 ${gs.day - 1} 天结束！准备进入第 ${gs.day} 天...`,
  });

  room.players.forEach(p => {
    if (p.role === 'scholar') {
      sendTo(p.ws, {
        type: 'SCHOLAR_PREVIEW',
        nextItems: nextItems.map(i => ({ name: i.name, category: i.category })),
      });
    }
  });

  setTimeout(() => {
    gs.phase = 'bidding';
    broadcast(room, {
      type: 'DAY_START',
      day: gs.day,
      items: gs.dayItems,
      players: getRoomSummary(room),
    });
    startBidding(room);
  }, 4000);
}

function endGame(room) {
  const gs = room.gameState;
  gs.phase = 'ended';

  const results = room.players.map(p => {
    const taskComplete = CATEGORIES.every(cat =>
      (p.taskProgress[cat.id] || 0) >= TASK_REQUIREMENT
    );
    const penalty = taskComplete ? 0 : CATEGORIES.reduce((sum, cat) => {
      const shortage = Math.max(0, TASK_REQUIREMENT - (p.taskProgress[cat.id] || 0));
      return sum + shortage * 200;
    }, 0);
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      coins: p.coins,
      spent: INITIAL_COINS - p.coins,
      taskProgress: p.taskProgress,
      taskComplete,
      penalty,
      finalScore: p.coins - penalty,
    };
  }).sort((a, b) => b.finalScore - a.finalScore);

  broadcast(room, {
    type: 'GAME_OVER',
    results,
    winner: results[0],
    message: `游戏结束！${results[0].name} 以最少花费获胜！`,
  });
}

// ── WebSocket 消息处理 ──
wss.on('connection', ws => {
  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    const { type, roomId, playerId } = msg;

    switch (type) {

      case 'CREATE_ROOM': {
        const id = roomId || Math.random().toString(36).slice(2, 7).toUpperCase();
        if (!rooms[id]) {
          rooms[id] = {
            id,
            players: [],
            gameState: {
              phase: 'lobby',
              day: 1,
              currentItemIndex: 0,
              dayItems: [],
              currentBid: 0,
              currentBidder: null,
              bids: {},
              rentPrices: {},
              rentDeclined: {},
            },
          };
        }
        ws._roomId = id;
        ws._playerId = playerId;
        sendTo(ws, { type: 'ROOM_CREATED', roomId: id });
        break;
      }

      case 'JOIN_ROOM': {
        const room = rooms[roomId];
        if (!room) { sendTo(ws, { type: 'ERROR', message: '房间不存在！' }); return; }
        if (room.gameState.phase !== 'lobby') { sendTo(ws, { type: 'ERROR', message: '游戏已开始！' }); return; }
        if (room.players.length >= 6) { sendTo(ws, { type: 'ERROR', message: '房间已满！' }); return; }

        const player = {
          id: playerId || Math.random().toString(36).slice(2, 9),
          name: msg.name || '玩家',
          role: null,
          coins: INITIAL_COINS,
          items: [],
          taskProgress: { transport: 0, price: 0, logistics: 0 },
          ws,
        };
        ws._roomId = roomId;
        ws._playerId = player.id;
        room.players.push(player);

        sendTo(ws, { type: 'JOINED', playerId: player.id, roomId });
        broadcast(room, {broadcast(room, {
          type: 'PLAYER_LIST',
          players: getRoomSummary(room),
          roles: ROLES,
        });
        break;break;
      }

      case 'SELECT_ROLE': {
        const room = rooms[ws._roomId];const room = rooms[ws._roomId];
        if (!room) return;if (!room) return;
        const player = room.players.find(p => p.id === ws._playerId);const player = room.players.find(p => p.id === ws._playerId);
        if (!player) return;
        const taken = room.players.some(p => p.role === msg.role && p.id !== player.id);
        if (taken) { sendTo(ws, { type: 'ERROR', message: '该角色已被选择！' }); return; }
        player.role = msg.role;
        player.name = msg.name || player.name;
        broadcast(room, {
          type: 'PLAYER_LIST',
          players: getRoomSummary(room),
          roles: ROLES,
        });
        break;
      }

      case 'START_GAME': {
        const room = rooms[ws._roomId];
        if (!room) return;
        if (room.players.length < 2) { sendTo(ws, { type: 'ERROR', message: '至少需要2名玩家！' }); return; }
        const unready = room.players.some(p => !p.role);
        if (unready) { sendTo(ws, { type: 'ERROR', message: '还有玩家未选择角色！' }); return; }

        const gs = room.gameState;
        gs.phase = 'playing';
        gs.day = 1;
        gs.dayItems = generateDayItems();
        gs.currentItemIndex = 0;

        broadcast(room, {
          type: 'GAME_START',
          day: 1,
          items: gs.dayItems,
          players: getRoomSummary(room),
          taskRequirement: TASK_REQUIREMENT,
        });

        setTimeout(() => startBidding(room), 2000);
        break;
      }

      case 'PLACE_BID': {
        const room = rooms[ws._roomId];
        if (!room) return;
        const gs = room.gameState;
        if (gs.phase !== 'bidding') return;
        const player = room.players.find(p => p.id === ws._playerId);
        if (!player) return;

        const bidAmount = parseInt(msg.amount);
        if (isNaN(bidAmount) || bidAmount <= gs.currentBid) {
          sendTo(ws, { type: 'ERROR', message: `出价必须高于当前最高价 ${gs.currentBid}！` });
          return;
        }
        if (bidAmount > player.coins) {
          sendTo(ws, { type: 'ERROR', message: '金币不足！' });
          return;
        }

        gs.currentBid = bidAmount;
        gs.currentBidder = player.id;
        gs.bids[player.id] = bidAmount;

        broadcast(room, {
          type: 'BID_UPDATE',
          playerId: player.id,
          playerName: player.name,
          amount: bidAmount,
          // 掮客才能看到所有出价，其他人只看最高
        });
        break;
      }

      case 'SET_RENT': {
        const room = rooms[ws._roomId];
        if (!room) return;
        const gs = room.gameState;
        if (gs.phase !== 'renting') return;
        if (ws._playerId !== gs.rentWinner) return;

        const rentPrice = parseInt(msg.price);
        if (isNaN(rentPrice) || rentPrice > gs.currentBid || rentPrice < 0) {
          sendTo(ws, { type: 'ERROR', message: `租价必须在 0 ~ ${gs.currentBid} 之间！` });
          return;
        }

        clearInterval(gs.rentTimer);clearInterval(gs.rentTimer);
        gs.rentPrices[gs.rentWinner] = rentPrice;gs.rentPrices[gs.rentWinner] = rentPrice;

        broadcast(room, {broadcast(room, {
          type: 'RENT_SET',type: 'RENT_SET',
          rentPrice,rentPrice,
          winner: { id: ws._playerId, name: room.players.find(p => p.id === ws._playerId)?.name },winner: { id: ws._playerId, name: room.players.find(p => p.id === ws._playerId)?.name },
          timeLeft: 15,timeLeft: 15,
        });

        // 给其他玩家15秒决定是否接受// 给其他玩家15秒决定是否接受
        gs.rentDeclined = {};gs.rentDeclined = {};
        gs.timeLeft = 15;gs.timeLeft = 15;
        gs.rentTimer = setInterval(() => {gs.rentTimer = setInterval(() => {
          gs.timeLeft--;gs.timeLeft--;
          broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'accepting' });broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'accepting' });
          if (gs.timeLeft <= 0) {if (gs.timeLeft <= 0) {
            clearInterval(gs.rentTimer);clearInterval(gs.rentTimer);
            resolveRenting(room);resolveRenting(room);
          }
        }, 1000);
        break;break;
      }

      case 'DECLINE_RENT': {case 'DECLINE_RENT': {
        const room = rooms[ws._roomId];const room = rooms[ws._roomId];
        if (!room) return;if (!room) return;
        const gs = room.gameState;const gs = room.gameState;
        if (gs.phase !== 'renting') return;if (gs.phase !== 'renting') return;
        gs.rentDeclined = gs.rentDeclined || {};gs.rentDeclined = gs.rentDeclined || {};
        gs.rentDeclined[ws._playerId] = true;gs.rentDeclined[ws._playerId] = true;
        const player = room.players.find(p => p.id === ws._playerId);const player = room.players.find(p => p.id === ws._playerId);
        broadcast(room, {broadcast(room, {
          type: 'RENT_DECLINED',type: 'RENT_DECLINED',
          playerId: ws._playerId,playerId: ws._playerId,
          playerName: player?.name,playerName: player?.name,
        });
        // 如果所有非获胜玩家都拒绝了，立刻结算// 如果所有非获胜玩家都拒绝了，立刻结算
        const others = room.players.filter(p => p.id !== gs.rentWinner);const others = room.players.filter(p => p.id !== gs.rentWinner);
        if (others.every(p => gs.rentDeclined[p.id])) {if (others.every(p => gs.rentDeclined[p.id])) {
          clearInterval(gs.rentTimer);clearInterval(gs.rentTimer);
          resolveRenting(room);resolveRenting(room);
        }
        break;break;
      }

      case 'CHAT': {case 'CHAT': {
        const room = rooms[ws._roomId];const room = rooms[ws._roomId];
        if (!room) return;if (!room) return;
        const player = room.players.find(p => p.id === ws._playerId);const player = room.players.find(p => p.id === ws._playerId);
        broadcast(room, {broadcast(room, {
          type: 'CHAT',type: 'CHAT',
          name: player?.name || '匿名',name: player?.name || '匿名',
          message: msg.message?.slice(0, 100),message: msg.message?.slice(0, 100),
        });
        break;break;
      }
    }
  });

  ws.on('close', () => {ws.on('close', () => {
    const room = rooms[ws._roomId];const room = rooms[ws._roomId];
    if (!room) return;if (!room) return;
    const player = room.players.find(p => p.id === ws._playerId);const player = room.players.find(p => p.id === ws._playerId);
    if (player) {if (player) {
      broadcast(room, {broadcast(room, {
        type: 'PLAYER_DISCONNECTED',type: 'PLAYER_DISCONNECTED',
        playerId: ws._playerId,playerId: ws._playerId,
        name: player.name,name: player.name,
        players: getRoomSummary(room),players: getRoomSummary(room),
      });
    }
  });
});

server.listen(PORT, () => console.log(`服务器启动：port ${PORT}`));
