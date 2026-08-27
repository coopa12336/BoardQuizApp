// server.js
// 早押し・ボードクイズ用サーバー
// - Express: 静的ファイル配信 + 早押しテスト用API
// - Socket.io: 部屋管理、手書きボードのリアルタイム同期、早押し判定のブロードキャスト
// - Arduinoとのシリアル通信は、投影PCのブラウザ側(Web Serial API)で行う。
//   このサーバー自体はシリアルポートに一切触れないため、クラウドにそのまま
//   デプロイできる（ネイティブモジュール不要）。

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6 // 手書き画像(dataURL)送信のため上限を少し広げる
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// 部屋(room)の状態管理（すべてメモリ上。サーバー再起動でリセットされます）
// ------------------------------------------------------------------
// rooms.get(roomName) => {
//   password: string,
//   judgeSocketId: string|null,
//   players: Map(socketId => { name, buzzerId, hasSubmitted, imageData, correct, lastActive }),
//   phase: 'idle' | 'writing' | 'locked',
//   buzzOrder: [{ buzzerId, playerId, name, ts }],
//   buzzAccepting: boolean,
//   display: { mode: 'grid' | 'single', selectedPlayerId: string|null }
// }
const rooms = new Map();

function getRoomPublicState(roomName) {
  const room = rooms.get(roomName);
  if (!room) return null;
  return {
    roomName,
    phase: room.phase,
    buzzOrder: room.buzzOrder,
    buzzAccepting: room.buzzAccepting,
    display: room.display,
    hasJudge: !!room.judgeSocketId,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      buzzerId: p.buzzerId,
      hasSubmitted: p.hasSubmitted,
      imageData: p.imageData,
      correct: p.correct
    }))
  };
}

function broadcastRoomState(roomName) {
  const state = getRoomPublicState(roomName);
  if (state) io.to(roomName).emit('room_state', state);
}

// ------------------------------------------------------------------
// 早押し判定（Arduinoからの入力は投影PCのブラウザがWeb Serial APIで受け取り、
// Socket.ioの 'client_buzz' イベントとしてここに転送してくる。
// テスト用の /api/serial-simulate も同じロジックを共有する。）
// ------------------------------------------------------------------
function recordBuzz(buzzerId, roomName) {
  const room = rooms.get(roomName);
  if (!room || !room.buzzAccepting) return;

  // 既にこの問題で押し済みのbuzzerIdは無視
  if (room.buzzOrder.some((b) => b.buzzerId === buzzerId)) return;

  // buzzerIdに対応するプレイヤーを探す
  let matchedPlayer = null;
  for (const [id, p] of room.players.entries()) {
    if (p.buzzerId === buzzerId) { matchedPlayer = { id, ...p }; break; }
  }

  room.buzzOrder.push({
    buzzerId,
    playerId: matchedPlayer ? matchedPlayer.id : null,
    name: matchedPlayer ? matchedPlayer.name : `未割当(#${buzzerId})`,
    ts: Date.now()
  });

  broadcastRoomState(roomName);
}

// テスト用: Arduino実機がなくても早押しをシミュレートできるエンドポイント
app.post('/api/serial-simulate', (req, res) => {
  const { roomName, buzzerId } = req.body;
  if (!roomName || buzzerId === undefined) return res.status(400).json({ error: 'roomName と buzzerId は必須です' });
  if (!rooms.has(roomName)) return res.status(404).json({ error: '指定された部屋が存在しません' });
  recordBuzz(Number(buzzerId), roomName);
  res.json({ ok: true });
});

// ------------------------------------------------------------------
// Socket.io イベント
// ------------------------------------------------------------------
io.on('connection', (socket) => {
  let joinedRoom = null;
  let role = null; // 'judge' | 'player'

  socket.on('create_room', ({ roomName, password }, cb) => {
    if (!roomName || !roomName.trim()) return cb({ error: '部屋名を入力してください' });
    if (rooms.has(roomName)) return cb({ error: 'その部屋名は既に使用されています' });
    rooms.set(roomName, {
      password: password || '',
      judgeSocketId: null,
      players: new Map(),
      phase: 'idle',
      buzzOrder: [],
      buzzAccepting: false,
      display: { mode: 'grid', selectedPlayerId: null }
    });
    cb({ ok: true });
  });

  socket.on('join_room', ({ roomName, password, role: reqRole, playerName, buzzerId }, cb) => {
    const room = rooms.get(roomName);
    if (!room) return cb({ error: '部屋が見つかりません' });
    if (room.password && room.password !== password) return cb({ error: 'パスワードが違います' });

    if (reqRole === 'judge') {
      room.judgeSocketId = socket.id;
      role = 'judge';
    } else {
      if (!playerName || !playerName.trim()) return cb({ error: '名前を入力してください' });
      room.players.set(socket.id, {
        name: playerName.trim(),
        buzzerId: buzzerId !== undefined && buzzerId !== '' ? Number(buzzerId) : null,
        hasSubmitted: false,
        imageData: null,
        correct: null
      });
      role = 'player';
    }

    joinedRoom = roomName;
    socket.join(roomName);
    cb({ ok: true, role, state: getRoomPublicState(roomName) });
    broadcastRoomState(roomName);
  });

  // 投影用画面など「観客」としての入室（判定も回答もしない、閲覧のみ）
  socket.on('spectate_room', ({ roomName }, cb) => {
    const room = rooms.get(roomName);
    if (!room) return cb({ error: '部屋が見つかりません' });
    joinedRoom = roomName;
    role = 'spectator';
    socket.join(roomName);
    cb({ ok: true, state: getRoomPublicState(roomName) });
    socket.emit('room_state', getRoomPublicState(roomName));
  });

  // プレイヤーの手書きストローク（リアルタイム描画同期）
  socket.on('draw_stroke', (data) => {
    if (!joinedRoom || role !== 'player') return;
    // data: { phase: 'start'|'move'|'end', x, y } 座標は0-1の正規化値
    socket.to(joinedRoom).emit('draw_stroke', { playerId: socket.id, ...data });
  });

  socket.on('clear_canvas', () => {
    if (!joinedRoom || role !== 'player') return;
    socket.to(joinedRoom).emit('clear_canvas', { playerId: socket.id });
    const room = rooms.get(joinedRoom);
    if (room && room.players.has(socket.id)) {
      room.players.get(socket.id).imageData = null;
      room.players.get(socket.id).hasSubmitted = false;
    }
  });

  // 解答確定（最終画像を保存して判定者・表示画面に送る）
  socket.on('submit_answer', ({ imageData }) => {
    if (!joinedRoom || role !== 'player') return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(socket.id)) return;
    const p = room.players.get(socket.id);
    p.imageData = imageData;
    p.hasSubmitted = true;
    broadcastRoomState(joinedRoom);
  });

  // 判定者操作
  socket.on('judge_new_question', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.phase = 'writing';
    room.buzzOrder = [];
    room.buzzAccepting = true;
    for (const p of room.players.values()) {
      p.hasSubmitted = false;
      p.imageData = null;
      p.correct = null;
    }
    io.to(joinedRoom).emit('reset_canvases');
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_lock', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.phase = 'locked';
    room.buzzAccepting = false;
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_mark', ({ playerId, correct }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    room.players.get(playerId).correct = correct;
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_set_display', ({ mode, selectedPlayerId }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.display = { mode, selectedPlayerId: selectedPlayerId || null };
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_reset_buzzer', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.buzzOrder = [];
    room.buzzAccepting = true;
    broadcastRoomState(joinedRoom);
  });

  // 投影PCのブラウザがWeb Serial APIで受信したArduinoの早押し信号を転送してくる
  socket.on('client_buzz', ({ buzzerId }) => {
    if (!joinedRoom) return;
    if (role !== 'spectator' && role !== 'judge') return; // 回答者からの送信は無視（不正防止）
    if (buzzerId === undefined || buzzerId === null) return;
    recordBuzz(Number(buzzerId), joinedRoom);
  });

  socket.on('disconnect', () => {
    if (!joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    if (role === 'judge' && room.judgeSocketId === socket.id) {
      room.judgeSocketId = null;
    } else if (role === 'player') {
      room.players.delete(socket.id);
    }
    broadcastRoomState(joinedRoom);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`早押し・ボードクイズサーバー起動: http://localhost:${PORT}`);
  console.log('同じネットワーク内の他端末からは、このPCのIPアドレスでアクセスしてください（例: http://192.168.x.x:3000）');
});
