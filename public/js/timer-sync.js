// timer-sync.js
// 判定者画面・回答者画面・投影画面で共通して使う、制限時間タイマーの
// カウントダウン表示ロジック。サーバーから受け取る endsAt (終了時刻の
// タイムスタンプ)を基準に、各クライアントがローカルで残り時間を計算する。

const TimerSync = (() => {
  let intervalHandle = null;
  let currentEndsAt = null;

  function start(endsAt, onTick) {
    if (currentEndsAt === endsAt && intervalHandle) return; // 同じタイマーなら再スタートしない
    stop();
    currentEndsAt = endsAt;

    function tick() {
      const remainingMs = endsAt - Date.now();
      if (remainingMs <= 0) {
        onTick(0);
        stop();
        return;
      }
      onTick(Math.ceil(remainingMs / 1000));
    }
    tick();
    intervalHandle = setInterval(tick, 250);
  }

  function stop() {
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = null;
    }
    currentEndsAt = null;
  }

  function format(totalSeconds) {
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  return { start, stop, format };
})();
