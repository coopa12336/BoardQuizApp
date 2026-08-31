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
//   players: Map(socketId => { name, buzzerId, hasSubmitted, imageData, correct,
//                               score, lastDelta, appliedRuleId, locked, revealed }),
//   phase: 'idle' | 'writing' | 'locked',
//   buzzOrder: [{ buzzerId, playerId, name, ts }],
//   buzzAccepting: boolean,
//   display: { mode: 'grid' | 'single', selectedPlayerId: string|null },
//   scoreRules: [{ id, rank: number|null, correct: boolean, points: number, label }],
//   buzzEffect: { first: 'flash'|'light'|'none', others: 'flash'|'light'|'none' },
//   timer: { durationSec: number, remainingMs: number, running: boolean, endsAt: number|null },
//   _timerHandle: NodeJS.Timeout|null (公開状態には含めない)
// }
const rooms = new Map();

// 得点ルールの初期値（6パターン）。rank:null は「ボタンを押さずに解答」を表す。
function defaultScoreRules() {
  return [
    { id: 'rank-1-correct',   rank: 1,    correct: true,  points: 10, label: '押して正解（1着）' },
    { id: 'rank-1-incorrect', rank: 1,    correct: false, points: -5, label: '押して不正解（1着）' },
    { id: 'rank-2-correct',   rank: 2,    correct: true,  points: 5,  label: '押して正解（2着）' },
    { id: 'rank-2-incorrect', rank: 2,    correct: false, points: -3, label: '押して不正解（2着）' },
    { id: 'nobuzz-correct',   rank: null, correct: true,  points: 5,  label: '押さずに正解' },
    { id: 'nobuzz-incorrect', rank: null, correct: false, points: 0,  label: '押さずに不正解' }
  ];
}

// 投影画面での早押し演出の初期値。「1着」と「2着以降」をそれぞれ設定できる。
function defaultBuzzEffect() {
  return { first: 'flash', others: 'light' };
}

const VALID_BUZZ_EFFECTS = new Set(['flash', 'light', 'none']);

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
    scoreRules: room.scoreRules,
    buzzEffect: room.buzzEffect,
    timer: room.timer ? { durationSec: room.timer.durationSec, endsAt: room.timer.endsAt } : null,
    players: Array.from(room.players.entries()).map(([id, p]) => ({
      id,
      name: p.name,
      buzzerId: p.buzzerId,
      hasSubmitted: p.hasSubmitted,
      imageData: p.imageData,
      correct: p.correct,
      score: p.score || 0,
      lastDelta: p.lastDelta || 0,
      appliedRuleId: p.appliedRuleId || null,
      locked: !!p.locked,
      revealed: !!p.revealed
    }))
  };
}

function broadcastRoomState(roomName) {
  const state = getRoomPublicState(roomName);
  if (state) io.to(roomName).emit('room_state', state);
}

// 全員のボードを一括ロックする（「回答をロックする」ボタン・タイマー終了時に共通で使用）
function lockAllPlayers(room) {
  room.phase = 'locked';
  room.buzzAccepting = false;
  for (const p of room.players.values()) {
    p.locked = true;
  }
}

// タイマーを止める（タイマー終了・手動停止・次の問題への移行時に共通で使用）
function clearRoomTimer(room) {
  if (room._timerHandle) {
    clearTimeout(room._timerHandle);
    room._timerHandle = null;
  }
  room.timer = null;
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
      display: { mode: 'grid', selectedPlayerId: null },
      scoreRules: defaultScoreRules(),
      buzzEffect: defaultBuzzEffect(),
      timer: null,
      _timerHandle: null
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
        correct: null,
        score: 0,
        lastDelta: 0,
        appliedRuleId: null,
        locked: room.phase !== 'writing',
        revealed: false
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
    clearRoomTimer(room);
    room.phase = 'writing';
    room.buzzOrder = [];
    room.buzzAccepting = true;
    for (const p of room.players.values()) {
      p.hasSubmitted = false;
      p.imageData = null;
      p.correct = null;
      p.lastDelta = 0; // 前の問題の加減点効果はリセット（累計スコア自体は維持）
      p.appliedRuleId = null; // 前の問題でどのルールを選んだかの記録もリセット
      p.locked = false; // 個別ロックも含めて全員分を解除
      p.revealed = false; // 投影画面への公開状態もリセット（次の問題は非公開から開始）
    }
    io.to(joinedRoom).emit('reset_canvases');
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_lock', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    clearRoomTimer(room);
    lockAllPlayers(room);
    broadcastRoomState(joinedRoom);
  });

  // 回答者ごとに個別でロック/ロック解除する
  socket.on('judge_set_player_lock', ({ playerId, locked }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    room.players.get(playerId).locked = !!locked;
    broadcastRoomState(joinedRoom);
  });

  // 投影画面への公開（見せる/見せない）。個別に切り替える。
  socket.on('judge_set_reveal', ({ playerId, revealed }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    room.players.get(playerId).revealed = !!revealed;
    broadcastRoomState(joinedRoom);
  });

  // 投影画面への公開を全員一括で切り替える
  socket.on('judge_set_reveal_all', ({ revealed }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    for (const p of room.players.values()) {
      p.revealed = !!revealed;
    }
    broadcastRoomState(joinedRoom);
  });

  // 制限時間タイマーを開始する。時間になると自動で全員をロックする。
  socket.on('judge_start_timer', ({ seconds }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const durationSec = Math.round(Number(seconds));
    if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 3600) return;

    clearRoomTimer(room);
    const endsAt = Date.now() + durationSec * 1000;
    room.timer = { durationSec, endsAt };
    room._timerHandle = setTimeout(() => {
      const r = rooms.get(joinedRoom);
      if (!r) return;
      r._timerHandle = null;
      r.timer = null;
      lockAllPlayers(r);
      broadcastRoomState(joinedRoom);
    }, durationSec * 1000);

    broadcastRoomState(joinedRoom);
  });

  // タイマーを手動で停止する（自動ロックは行わない）
  socket.on('judge_stop_timer', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    clearRoomTimer(room);
    broadcastRoomState(joinedRoom);
  });

  // 正誤判定。「正解/不正解」の2択ではなく、設定済みの得点ルールの中から
  // 判定者が直接どれに該当するかを選ぶ（例: 押して1着で正解、押さずに不正解、など）。
  // やり直した場合は前回の加減点分を打ち消してから再計算するので、
  // 何度選び直しても累計スコアはズレない。
  socket.on('judge_apply_score_rule', ({ playerId, ruleId }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    const rule = (room.scoreRules || []).find((r) => r.id === ruleId);
    if (!rule) return;
    const player = room.players.get(playerId);

    player.score = (player.score || 0) - (player.lastDelta || 0) + rule.points;
    player.lastDelta = rule.points;
    player.correct = rule.correct;
    player.appliedRuleId = ruleId;

    broadcastRoomState(joinedRoom);
  });

  // 得点ルールの編集（判定者画面から数値・ラベルをまとめて上書き保存）
  socket.on('judge_update_score_rules', ({ rules }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !Array.isArray(rules)) return;
    room.scoreRules = rules
      .filter((r) => r && typeof r.id === 'string')
      .map((r) => ({
        id: r.id,
        rank: r.rank === null || r.rank === undefined || r.rank === '' ? null : Number(r.rank),
        correct: !!r.correct,
        points: Number(r.points) || 0,
        label: String(r.label || '').slice(0, 60)
      }));
    broadcastRoomState(joinedRoom);
  });

  // 新しい順位のルール（正解/不正解の2行）を追加する
  socket.on('judge_add_rank_rule', ({ rank }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    const n = Number(rank);
    if (!Number.isInteger(n) || n < 1 || n > 99) return;
    const existing = new Set(room.scoreRules.map((r) => r.id));
    if (!existing.has(`rank-${n}-correct`)) {
      room.scoreRules.push({ id: `rank-${n}-correct`, rank: n, correct: true, points: 0, label: `押して正解（${n}着）` });
    }
    if (!existing.has(`rank-${n}-incorrect`)) {
      room.scoreRules.push({ id: `rank-${n}-incorrect`, rank: n, correct: false, points: 0, label: `押して不正解（${n}着）` });
    }
    broadcastRoomState(joinedRoom);
  });

  socket.on('judge_remove_score_rule', ({ id }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    room.scoreRules = room.scoreRules.filter((r) => r.id !== id);
    broadcastRoomState(joinedRoom);
  });

  // 全員のスコアを0に戻す（問題ごとのリセットとは別操作）
  socket.on('judge_reset_scores', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    for (const p of room.players.values()) {
      p.score = 0;
      p.lastDelta = 0;
      p.appliedRuleId = null;
    }
    broadcastRoomState(joinedRoom);
  });

  // 正解/不正解の自動加減点とは別に、任意の点数を手動で加減する
  // （ボーナス点や独自ルールでの加点など、正解/不正解だけでは表現できないケース向け）
  socket.on('judge_adjust_score', ({ playerId, amount }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    const n = Number(amount);
    if (!Number.isFinite(n) || n === 0) return;
    const p = room.players.get(playerId);
    p.score = (p.score || 0) + n;
    broadcastRoomState(joinedRoom);
  });

  // 投影画面での早押し演出（1着/2着以降それぞれ「点滅」「点灯」「なし」）の設定
  socket.on('judge_update_buzz_effect', ({ config }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !config) return;
    const first = VALID_BUZZ_EFFECTS.has(config.first) ? config.first : room.buzzEffect.first;
    const others = VALID_BUZZ_EFFECTS.has(config.others) ? config.others : room.buzzEffect.others;
    room.buzzEffect = { first, others };
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
