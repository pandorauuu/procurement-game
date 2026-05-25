const WebSocket = require('ws');
const http = require('http');

const PORT = process.env.PORT || 8080;
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('采购大战 服务器运行中');
});

const wss = new WebSocket.Server({ server });
const rooms = {};
const clientMap = new Map(); // ws -> { roomId, playerId }

const ROLES = {
  merchant: { name: '商人', emoji: '🧑‍💼', talent: '智慧', desc: '价格类竞拍出价上限+25%', bonus: { price: 0.25 } },
  driver:   { name: '司机', emoji: '🚗',    talent: '体力', desc: '交通类竞拍费用-15%',    bonus: { transport: -0.15 } },
  porter:   { name: '搬运工', emoji: '💪',  talent: '力量', desc: '运输类竞拍费用-15%',    bonus: { logistics: -0.15 } },
  broker:   { name: '掮客', emoji: '🕵️',   talent: '人脉', desc: '可看到最高出价',         bonus: { spy: true } },
  gambler:  { name: '赌徒', emoji: '🎲',    talent: '运气', desc: '每轮随机±10%加成',      bonus: { luck: true } },
  scholar:  { name: '学者', emoji: '📚',    talent: '分析', desc: '可预览次日物品',         bonus: { preview: true } },
};

const CATEGORIES = [
  { id: 'transport', name: '🚗 交通', desc: '运输货物所需的车辆' },
  { id: 'price',     name: '💰 货源', desc: '采购原材料的供应商' },
  { id: 'logistics', name: '📦 运输', desc: '搬运和配送服务' },
];

const ITEMS_POOL = {
  transport: [
    { name: '普通货车', basePrice: 800,  quality: 1 },
    { name: '冷链运输', basePrice: 1500, quality: 2 },
    { name: '高速快递', basePrice: 2200, quality: 3 },
    { name: '豪华专车', basePrice: 3000, quality: 4 },
  ],
  price: [
    { name: '散户供应商', basePrice: 600,  quality: 1 },
    { name: '正规工厂',   basePrice: 1200, quality: 2 },
    { name: '品牌代理',   basePrice: 2000, quality: 3 },
    { name: '独家渠道',   basePrice: 3500, quality: 4 },
  ],
  logistics: [
    { name: '人力搬运', basePrice: 500,  quality: 1 },
    { name: '机械装卸', basePrice: 1100, quality: 2 },
    { name: '专业团队', basePrice: 1800, quality: 3 },
    { name: '全程托管', basePrice: 2800, quality: 4 },
  ],
};

const TASK_REQUIREMENT = 10;
const INITIAL_COINS = 10000;
const BID_DURATION = 20;
const RENT_DURATION = 30;

function randomItem(category) {
  const pool = ITEMS_POOL[category];
  const item = pool[Math.floor(Math.random() * pool.length)];
  const variance = 0.85 + Math.random() * 0.3;
  return {
    name: item.name,
    basePrice: item.basePrice,
    quality: item.quality,
    category: category,
    actualPrice: Math.round(item.basePrice * variance),
    id: Date.now() + Math.random(),
  };
}

function generateDayItems() {
  return CATEGORIES.map(function(cat) { return randomItem(cat.id); });
}

function applyRoleBonus(role, category, price) {
  const bonus = (ROLES[role] && ROLES[role].bonus) || {};
  let modifier = 1;
  if (category === 'price'     && bonus.price)     modifier += bonus.price;
  if (category === 'transport' && bonus.transport)  modifier += bonus.transport;
  if (category === 'logistics' && bonus.logistics)  modifier += bonus.logistics;
  if (bonus.luck) modifier += (Math.random() - 0.5) * 0.2;
  return Math.round(price * Math.max(0.5, modifier));
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  room.players.forEach(function(p) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function getRoomSummary(room) {
  return room.players.map(function(p) {
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      coins: p.coins,
      spent: INITIAL_COINS - p.coins,
      taskProgress: p.taskProgress,
      connected: p.ws.readyState === WebSocket.OPEN,
    };
  });
}

function startBidding(room) {
  const gs = room.gameState;
  if (gs.currentItemIndex >= gs.dayItems.length) {
    endDay(room);
    return;
  }
  const item = gs.dayItems[gs.currentItemIndex];
  gs.phase = 'bidding';
  gs.currentBid = item.actualPrice;
  gs.currentBidder = null;
  gs.bids = {};
  gs.timeLeft = BID_DURATION;

  broadcast(room, { type: 'BIDDING_START', item: item, timeLeft: gs.timeLeft, players: getRoomSummary(room) });

  clearInterval(gs.bidTimer);
  gs.bidTimer = setInterval(function() {
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
    broadcast(room, { type: 'NO_WINNER', item: item, message: '无人竞拍，该物品流拍！' });
    gs.currentItemIndex++;
    setTimeout(function() { startBidding(room); }, 2000);
    return;
  }

  const winner = room.players.find(function(p) { return p.id === gs.currentBidder; });
  winner.coins -= gs.currentBid;
  winner.items = winner.items || [];
  winner.items.push({ name: item.name, category: item.category, quality: item.quality, paidPrice: gs.currentBid });

  gs.phase = 'renting';
  gs.rentItem = { name: item.name, category: item.category, quality: item.quality, actualPrice: item.actualPrice, paidPrice: gs.currentBid };
  gs.rentWinner = gs.currentBidder;
  gs.rentPrices = {};
  gs.rentDeclined = {};
  gs.timeLeft = RENT_DURATION;

  broadcast(room, {
    type: 'BIDDING_END',
    winner: { id: winner.id, name: winner.name },
    item: item,
    paidPrice: gs.currentBid,
    players: getRoomSummary(room),
    message: winner.name + ' 以 ' + gs.currentBid + ' 金币拍下！现在设定租用价格...',
  });

  room.players.forEach(function(p) {
    if (p.role === 'broker') {
      sendTo(p.ws, { type: 'SPY_INFO', bids: gs.bids });
    }
  });

  gs.rentTimer = setInterval(function() {
    gs.timeLeft--;
    broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'renting' });
    if (gs.timeLeft <= 0) {
      clearInterval(gs.rentTimer);
      if (!gs.rentPrices[gs.rentWinner]) gs.rentPrices[gs.rentWinner] = gs.currentBid;
      resolveRenting(room);
    }
  }, 1000);
}

function resolveRenting(room) {
  const gs = room.gameState;
  const winner = room.players.find(function(p) { return p.id === gs.rentWinner; });
  const item = gs.rentItem;
  const rentPrice = gs.rentPrices[gs.rentWinner] || gs.currentBid;
  const results = [];

  room.players.forEach(function(p) {
    if (p.id === gs.rentWinner) return;
    const declined = gs.rentDeclined && gs.rentDeclined[p.id];
    if (!declined) {
      const effectivePrice = applyRoleBonus(p.role, item.category, rentPrice);
      p.coins -= effectivePrice;
      winner.coins += effectivePrice;
      p.taskProgress[item.category] = (p.taskProgress[item.category] || 0) + item.quality;
      results.push({ playerId: p.id, name: p.name, paid: effectivePrice, accepted: true });
    } else {
      results.push({ playerId: p.id, name: p.name, paid: 0, accepted: false });
    }
  });

  winner.taskProgress[item.category] = (winner.taskProgress[item.category] || 0) + item.quality;

  broadcast(room, {
    type: 'RENT_RESOLVED',
    item: item,
    rentPrice: rentPrice,
    winner: { id: winner.id, name: winner.name },
    results: results,
    players: getRoomSummary(room),
  });

  gs.currentItemIndex++;
  setTimeout(function() { startBidding(room); }, 3000);
}

function endDay(room) {
  const gs = room.gameState;
  gs.day++;
  if (gs.day > 5) { endGame(room); return; }

  const nextItems = generateDayItems();
  gs.dayItems = nextItems;
  gs.currentItemIndex = 0;
  gs.phase = 'day_start';

  broadcast(room, {
    type: 'DAY_END',
    day: gs.day,
    players: getRoomSummary(room),
    message: '第 ' + (gs.day - 1) + ' 天结束！准备进入第 ' + gs.day + ' 天...',
  });

  room.players.forEach(function(p) {
    if (p.role === 'scholar') {
      sendTo(p.ws, {
        type: 'SCHOLAR_PREVIEW',
        nextItems: nextItems.map(function(i) { return { name: i.name, category: i.category }; }),
      });
    }
  });

  setTimeout(function() {
    gs.phase = 'bidding';
    broadcast(room, { type: 'DAY_START', day: gs.day, items: gs.dayItems, players: getRoomSummary(room) });
    startBidding(room);
  }, 4000);
}

function endGame(room) {
  const gs = room.gameState;
  gs.phase = 'ended';

  const results = room.players.map(function(p) {
    const taskComplete = CATEGORIES.every(function(cat) {
      return (p.taskProgress[cat.id] || 0) >= TASK_REQUIREMENT;
    });
    const penalty = taskComplete ? 0 : CATEGORIES.reduce(function(sum, cat) {
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
      taskComplete: taskComplete,
      penalty: penalty,
      finalScore: p.coins - penalty,
    };
  }).sort(function(a, b) { return b.finalScore - a.finalScore; });

  broadcast(room, {
    type: 'GAME_OVER',
    results: results,
    winner: results[0],
    message: '游戏结束！' + results[0].name + ' 以最少花费获胜！',
  });
}

wss.on('connection', function(ws) {
  clientMap.set(ws, { roomId: null, playerId: null });

  ws.on('message', function(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch(e) { return; }

    const client = clientMap.get(ws);
    const type = msg.type;

    if (type === 'CREATE_ROOM') {
      const id = msg.roomId || Math.random().toString(36).slice(2, 7).toUpperCase();
      if (!rooms[id]) {
        rooms[id] = {
          id: id,
          players: [],
          gameState: {
            phase: 'lobby', day: 1, currentItemIndex: 0,
            dayItems: [], currentBid: 0, currentBidder: null,
            bids: {}, rentPrices: {}, rentDeclined: {},
          },
        };
      }
      client.roomId = id;
      client.playerId = msg.playerId;
      sendTo(ws, { type: 'ROOM_CREATED', roomId: id });

    } else if (type === 'JOIN_ROOM') {
      const room = rooms[msg.roomId];
      if (!room) { sendTo(ws, { type: 'ERROR', message: '房间不存在！' }); return; }
      if (room.gameState.phase !== 'lobby') { sendTo(ws, { type: 'ERROR', message: '游戏已开始！' }); return; }
      if (room.players.length >= 6) { sendTo(ws, { type: 'ERROR', message: '房间已满！' }); return; }

      const playerId = msg.playerId || Math.random().toString(36).slice(2, 9);
      const player = {
        id: playerId,
        name: msg.name || '玩家',
        role: null,
        coins: INITIAL_COINS,
        items: [],
        taskProgress: { transport: 0, price: 0, logistics: 0 },
        ws: ws,
      };
      client.roomId = msg.roomId;
      client.playerId = playerId;
      room.players.push(player);
      sendTo(ws, { type: 'JOINED', playerId: playerId, roomId: msg.roomId });
      broadcast(room, { type: 'PLAYER_LIST', players: getRoomSummary(room), roles: ROLES });

    } else if (type === 'SELECT_ROLE') {
      const room = rooms[client.roomId];
      if (!room) return;
      const player = room.players.find(function(p) { return p.id === client.playerId; });
      if (!player) return;
      const taken = room.players.some(function(p) { return p.role === msg.role && p.id !== player.id; });
      if (taken) { sendTo(ws, { type: 'ERROR', message: '该角色已被选择！' }); return; }
      player.role = msg.role;
      player.name = msg.name || player.name;
      broadcast(room, { type: 'PLAYER_LIST', players: getRoomSummary(room), roles: ROLES });

    } else if (type === 'START_GAME') {
      const room = rooms[client.roomId];
      if (!room) return;
      if (room.players.length < 2) { sendTo(ws, { type: 'ERROR', message: '至少需要2名玩家！' }); return; }
      const unready = room.players.some(function(p) { return !p.role; });
      if (unready) { sendTo(ws, { type: 'ERROR', message: '还有玩家未选择角色！' }); return; }
      const gs = room.gameState;
      gs.phase = 'playing';
      gs.day = 1;
      gs.dayItems = generateDayItems();
      gs.currentItemIndex = 0;
      broadcast(room, { type: 'GAME_START', day: 1, items: gs.dayItems, players: getRoomSummary(room), taskRequirement: TASK_REQUIREMENT });
      setTimeout(function() { startBidding(room); }, 2000);

    } else if (type === 'PLACE_BID') {
      const room = rooms[client.roomId];
      if (!room) return;
      const gs = room.gameState;
      if (gs.phase !== 'bidding') return;
      const player = room.players.find(function(p) { return p.id === client.playerId; });
      if (!player) return;
      const bidAmount = parseInt(msg.amount);
      if (isNaN(bidAmount) || bidAmount <= gs.currentBid) {
        sendTo(ws, { type: 'ERROR', message: '出价必须高于当前最高价 ' + gs.currentBid + '！' });
        return;
      }
      if (bidAmount > player.coins) { sendTo(ws, { type: 'ERROR', message: '金币不足！' }); return; }
      gs.currentBid = bidAmount;
      gs.currentBidder = player.id;
      gs.bids[player.id] = bidAmount;
      broadcast(room, { type: 'BID_UPDATE', playerId: player.id, playerName: player.name, amount: bidAmount });

    } else if (type === 'SET_RENT') {
      const room = rooms[client.roomId];
      if (!room) return;
      const gs = room.gameState;
      if (gs.phase !== 'renting') return;
      if (client.playerId !== gs.rentWinner) return;
      const rentPrice = parseInt(msg.price);
      if (isNaN(rentPrice) || rentPrice > gs.currentBid || rentPrice < 0) {
        sendTo(ws, { type: 'ERROR', message: '租价必须在 0 ~ ' + gs.currentBid + ' 之间！' });
        return;
      }
      clearInterval(gs.rentTimer);
      gs.rentPrices[gs.rentWinner] = rentPrice;
      const winnerPlayer = room.players.find(function(p) { return p.id === client.playerId; });
      broadcast(room, { type: 'RENT_SET', rentPrice: rentPrice, winner: { id: client.playerId, name: winnerPlayer && winnerPlayer.name }, timeLeft: 15 });
      gs.rentDeclined = {};
      gs.timeLeft = 15;
      gs.rentTimer = setInterval(function() {
        gs.timeLeft--;
        broadcast(room, { type: 'TIMER', timeLeft: gs.timeLeft, phase: 'accepting' });
        if (gs.timeLeft <= 0) { clearInterval(gs.rentTimer); resolveRenting(room); }
      }, 1000);

    } else if (type === 'DECLINE_RENT') {
      const room = rooms[client.roomId];
      if (!room) return;
      const gs = room.gameState;
      if (gs.phase !== 'renting') return;
      gs.rentDeclined = gs.rentDeclined || {};
      gs.rentDeclined[client.playerId] = true;
      const player = room.players.find(function(p) { return p.id === client.playerId; });
      broadcast(room, { type: 'RENT_DECLINED', playerId: client.playerId, playerName: player && player.name });
      const others = room.players.filter(function(p) { return p.id !== gs.rentWinner; });
      if (others.every(function(p) { return gs.rentDeclined[p.id]; })) {
        clearInterval(gs.rentTimer);
        resolveRenting(room);
      }

    } else if (type === 'CHAT') {
      const room = rooms[client.roomId];
      if (!room) return;
      const player = room.players.find(function(p) { return p.id === client.playerId; });
      broadcast(room, { type: 'CHAT', name: (player && player.name) || '匿名', message: (msg.message || '').slice(0, 100) });
    }
  });

  ws.on('close', function() {
    const client = clientMap.get(ws);
    if (client && client.roomId) {
      const room = rooms[client.roomId];
      if (room) {
        const player = room.players.find(function(p) { return p.id === client.playerId; });
        if (player) {
          broadcast(room, { type: 'PLAYER_DISCONNECTED', playerId: client.playerId, name: player.name, players: getRoomSummary(room) });
        }
      }
    }
    clientMap.delete(ws);
  });
});

server.listen(PORT, function() { console.log('服务器启动：port ' + PORT); });
