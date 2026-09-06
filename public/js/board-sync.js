// board-sync.js
// 判定者画面・プロジェクター表示画面が共通で使う「回答者ごとの手書きボード」の
// リアルタイム再現ロジック。draw_stroke イベントを受けて各プレイヤーの
// ミニキャンバスに線を再現する。

const BoardSync = (() => {
  const canvases = new Map(); // playerId -> { canvas, ctx }

  function ensure(playerId, w = 800, h = 600) {
    if (canvases.has(playerId)) return canvases.get(playerId);
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = '#111';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const entry = { canvas, ctx };
    canvases.set(playerId, entry);
    return entry;
  }

  function clear(playerId) {
    const entry = canvases.get(playerId);
    if (!entry) return;
    entry.ctx.fillStyle = '#fff';
    entry.ctx.fillRect(0, 0, entry.canvas.width, entry.canvas.height);
  }

  function stroke(playerId, { phase, x, y, color, lineWidth }) {
    const entry = ensure(playerId);
    const { ctx, canvas } = entry;
    const cx = x * canvas.width;
    const cy = y * canvas.height;
    if (phase === 'start') {
      // 色・太さは各ストロークの開始時に送られてくる（回答者側でペンの色や
      // 消しゴムを切り替えた場合も、ここで正しく反映される）。省略時は
      // 黒ペンとして扱う（後方互換のため）。
      ctx.strokeStyle = color || '#111';
      ctx.lineWidth = lineWidth || 6;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
    } else if (phase === 'move') {
      ctx.lineTo(cx, cy);
      ctx.stroke();
    }
  }

  function getCanvas(playerId) {
    return ensure(playerId).canvas;
  }

  function remove(playerId) {
    canvases.delete(playerId);
  }

  return { stroke, clear, getCanvas, remove };
})();
