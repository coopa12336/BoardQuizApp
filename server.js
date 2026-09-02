// server.js
// 早押し・ボードクイズ用サーバー
// - Express: 静的ファイル配信 + 早押しテスト用API + 問題ファイルのアップロードAPI
// - Socket.io: 部屋管理、手書きボードのリアルタイム同期、早押し判定のブロードキャスト
// - Arduinoとのシリアル通信は、投影PCのブラウザ側(Web Serial API)で行う。
//   このサーバー自体はシリアルポートに一切触れないため、クラウドにそのまま
//   デプロイできる（ネイティブモジュール不要）。

const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const multer = require('multer');
const XLSX = require('xlsx');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  maxHttpBufferSize: 5e6 // 手書き画像(dataURL)送信のため上限を少し広げる
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ------------------------------------------------------------------
// 部屋(room)の状態管理（すべてメモリ上。サーバー再起動でリセットされます）
// ------------------------------------------------------------------
// rooms.get(roomName) => {
//   password: string,
//   judgeSocketId: string|null,
//   players: Map(socketId => { name, buzzerId, hasSubmitted, imageData, correct,
//                               score, lastDelta, appliedRuleId, pendingRuleId, locked, revealed }),
//   phase: 'idle' | 'writing' | 'locked',
//   buzzOrder: [{ buzzerId, playerId, name, ts }],
//   buzzAccepting: boolean,
//   display: { mode: 'grid' | 'single', selectedPlayerId: string|null },
//   scoreRules: [{ id, rank: number|null, correct: boolean, points: number, label }],
//   buzzEffect: { first: 'flash'|'light'|'none', others: 'flash'|'light'|'none' },
//   timer: { durationSec: number, remainingMs: number, running: boolean, endsAt: number|null },
//   _timerHandle: NodeJS.Timeout|null (公開状態には含めない)
//   questionBank: [{ no, question, answer, comment, author }] (判定者にのみ渡す。全体publicStateには含めない)
//   questionPanel: { visible: boolean, current: {no,question,answer,comment,author}|null,
//                     autoHideSeconds: number|null, hideAt: number|null }
//   _questionHideHandle: NodeJS.Timeout|null (公開状態には含めない)
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

function defaultQuestionPanel() {
  return { visible: false, current: null, autoHideSeconds: null, hideAt: null };
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
    // 問題パネルは非公開(visible:false)の間、本文を一切含めない
    // （判定者以外のクライアントに送信データとして渡らないようにするため）。
    questionPanel: room.questionPanel && room.questionPanel.visible
      ? {
          visible: true,
          current: room.questionPanel.current,
          autoHideSeconds: room.questionPanel.autoHideSeconds,
          hideAt: room.questionPanel.hideAt
        }
      : { visible: false, current: null, autoHideSeconds: room.questionPanel ? room.questionPanel.autoHideSeconds : null, hideAt: null },
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
      pendingRuleId: p.pendingRuleId || null,
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

// 問題パネルの自動非表示タイマーを止める
function clearQuestionHideTimer(room) {
  if (room._questionHideHandle) {
    clearTimeout(room._questionHideHandle);
    room._questionHideHandle = null;
  }
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
// 問題ファイル(Excel/CSV/スプレッドシート書き出し等)の読み込み
// ------------------------------------------------------------------
// 1行目に「問題文」「解答」などの見出しがあればそれを優先して使う。
// 見出しが認識できない場合（見出し行が無い、文言が独自など）は、
// 列の並び順（1列目:番号 2列目:問題文 3列目:解答 4列目:解説/コメント
// 5列目:作問者）で読み込む。どちらの場合も1行目はラベル行として読み飛ばす。
const QUESTION_HEADER_KEYWORDS = {
  no: ['no', 'no.', '№', '番号', '問題番号', '#'],
  question: ['問題', '問題文', 'question', 'q', '問'],
  answer: ['解答', '答え', '正解', 'answer', 'a'],
  comment: ['解説', 'コメント', '備考', 'comment', 'explanation', 'note', 'notes'],
  author: ['作問者', '出題者', '作成者', 'author', 'writer']
};

// 1行目の各セルを見出しキーワードと突き合わせ、列番号のマップを作る。
// どの列も見出しとして認識できなければ null を返す（＝列位置での読み込みに切り替える）。
function detectQuestionHeaderMap(headerCells) {
  const map = { no: -1, question: -1, answer: -1, comment: -1, author: -1 };
  let matchedAny = false;
  headerCells.forEach((cell, idx) => {
    const norm = String(cell ?? '').trim().toLowerCase();
    if (!norm) return;
    for (const field of Object.keys(QUESTION_HEADER_KEYWORDS)) {
      if (map[field] === -1 && QUESTION_HEADER_KEYWORDS[field].includes(norm)) {
        map[field] = idx;
        matchedAny = true;
      }
    }
  });
  return matchedAny ? map : null;
}

function cellToText(v) {
  return v === undefined || v === null ? '' : String(v).trim();
}

// Excel(.xlsx/.xls)・CSV・ODS等をまとめて受け付ける（xlsxライブラリが自動判別する）
app.post('/api/upload-questions', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが見つかりません' });
    const { roomName } = req.body;
    if (!roomName) return res.status(400).json({ error: 'roomName は必須です' });
    const room = rooms.get(roomName);
    if (!room) return res.status(404).json({ error: '指定された部屋が存在しません' });

    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    if (!sheetName) return res.status(400).json({ error: 'シートが見つかりませんでした' });
    const sheet = workbook.Sheets[sheetName];
    // header:1 で「配列の配列」として読み込み、見出し名に依存せず列位置でも扱えるようにする
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', blankrows: false });

    if (!rawRows.length) {
      return res.status(400).json({ error: 'シートにデータがありませんでした' });
    }

    const headerMap = detectQuestionHeaderMap(rawRows[0]);
    const dataRows = rawRows.slice(1); // 1行目は見出し/ラベル行として読み飛ばす

    let questions;
    if (headerMap && (headerMap.question >= 0 || headerMap.answer >= 0)) {
      // 見出しの列名を認識できた場合はその列番号を使う
      questions = dataRows.map((r, idx) => ({
        no: (headerMap.no >= 0 ? cellToText(r[headerMap.no]) : '') || String(idx + 1),
        question: headerMap.question >= 0 ? cellToText(r[headerMap.question]) : '',
        answer: headerMap.answer >= 0 ? cellToText(r[headerMap.answer]) : '',
        comment: headerMap.comment >= 0 ? cellToText(r[headerMap.comment]) : '',
        author: headerMap.author >= 0 ? cellToText(r[headerMap.author]) : ''
      }));
    } else {
      // 見出しが認識できない場合は列の並び順で読み込む
      // 1列目:番号 2列目:問題文 3列目:解答 4列目:解説/コメント 5列目:作問者
      questions = dataRows.map((r, idx) => ({
        no: cellToText(r[0]) || String(idx + 1),
        question: cellToText(r[1]),
        answer: cellToText(r[2]),
        comment: cellToText(r[3]),
        author: cellToText(r[4])
      }));
    }

    questions = questions.filter((q) => q.question || q.answer); // 完全な空行は除外

    if (questions.length === 0) {
      return res.status(400).json({
        error: '問題を読み取れませんでした。1行目を見出し（問題文・解答など）にするか、' +
          '1列目=番号・2列目=問題文・3列目=解答・4列目=解説の並びにしてください。'
      });
    }

    room.questionBank = questions;
    res.json({ ok: true, count: questions.length, questions });
  } catch (e) {
    res.status(500).json({ error: 'ファイルの読み込みに失敗しました: ' + e.message });
  }
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
      _timerHandle: null,
      questionBank: [],
      questionPanel: defaultQuestionPanel(),
      _questionHideHandle: null
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
        pendingRuleId: null,
        locked: room.phase !== 'writing',
        revealed: false
      });
      role = 'player';
    }

    joinedRoom = roomName;
    socket.join(roomName);
    cb({
      ok: true,
      role,
      state: getRoomPublicState(roomName),
      // 判定者が読み込んだ問題一覧は、判定者自身にだけ返す
      // （部屋の公開状態(getRoomPublicState)には含めず、他クライアントへは渡さない）
      questionBank: role === 'judge' ? (room.questionBank || []) : undefined
    });
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
      p.pendingRuleId = null; // 仮選択中の判定もリセット
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

  // 正誤判定ボタンは「即時反映」ではなく「仮選択」だけを行う。
  // 同じボタンをもう一度押すと仮選択を取り消せる（未選択に戻る）。
  // 実際にスコアへ反映され、投影画面の演出が発生するのは
  // 「正誤判定を確定する」(judge_confirm_scoring)が押されたタイミング。
  socket.on('judge_select_score_rule', ({ playerId, ruleId }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !room.players.has(playerId)) return;
    const player = room.players.get(playerId);
    player.pendingRuleId = (player.pendingRuleId === ruleId) ? null : ruleId;
    broadcastRoomState(joinedRoom);
  });

  // 仮選択済みの全員分をまとめて確定する。
  // ここで初めてスコアに反映され、投影画面へ「score_confirmed」イベントを送って
  // 正解/不正解ごとに異なる演出を一斉に再生させる。
  // やり直した場合（前回すでに確定済みの人を選び直した場合）は前回の加減点分を
  // 打ち消してから再計算するので、何度確定し直しても累計スコアはズレない。
  socket.on('judge_confirm_scoring', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;

    const results = [];
    for (const [playerId, player] of room.players.entries()) {
      if (!player.pendingRuleId) continue;
      const rule = (room.scoreRules || []).find((r) => r.id === player.pendingRuleId);
      if (!rule) { player.pendingRuleId = null; continue; }

      player.score = (player.score || 0) - (player.lastDelta || 0) + rule.points;
      player.lastDelta = rule.points;
      player.correct = rule.correct;
      player.appliedRuleId = rule.id;
      player.pendingRuleId = null;

      results.push({
        playerId,
        name: player.name,
        correct: rule.correct,
        points: rule.points,
        newScore: player.score
      });
    }

    if (results.length === 0) return; // 誰も仮選択していなければ何もしない
    broadcastRoomState(joinedRoom);
    io.to(joinedRoom).emit('score_confirmed', { results });
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
      p.pendingRuleId = null;
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

  // 問題文・解答・解説などを投影画面に送る（SEND）。
  // autoHideSecondsを指定すると、その秒数後に自動で非表示にする。
  socket.on('judge_send_question', ({ question, autoHideSeconds }) => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room || !question) return;

    clearQuestionHideTimer(room);
    const sec = Number(autoHideSeconds);
    const validSec = (Number.isFinite(sec) && sec > 0) ? Math.min(sec, 3600) : null;

    room.questionPanel = {
      visible: true,
      current: {
        no: String(question.no || '').slice(0, 30),
        question: String(question.question || '').slice(0, 4000),
        answer: String(question.answer || '').slice(0, 2000),
        comment: String(question.comment || '').slice(0, 4000),
        author: String(question.author || '').slice(0, 200)
      },
      autoHideSeconds: validSec,
      hideAt: validSec ? Date.now() + validSec * 1000 : null
    };

    if (validSec) {
      room._questionHideHandle = setTimeout(() => {
        const r = rooms.get(joinedRoom);
        if (!r) return;
        r._questionHideHandle = null;
        r.questionPanel = { ...r.questionPanel, visible: false, current: null, hideAt: null };
        broadcastRoomState(joinedRoom);
      }, validSec * 1000);
    }

    broadcastRoomState(joinedRoom);
  });

  // 投影画面から問題パネルを手動で消す
  socket.on('judge_hide_question', () => {
    if (role !== 'judge' || !joinedRoom) return;
    const room = rooms.get(joinedRoom);
    if (!room) return;
    clearQuestionHideTimer(room);
    room.questionPanel = { ...room.questionPanel, visible: false, current: null, hideAt: null };
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
