// question-text.js
// 問題文中の最初の "/" を境目として、それより前を黄色、後ろを白色で表示するための
// 共通ヘルパー。「/」は早押しボタンが押された位置（＝そこまで読み上げた位置）を
// 表すマーカーとして使う想定で、表示上は「/」自体は出さない。
// 判定者画面（編集プレビュー）・投影画面（問題パネル）・回答者画面（履歴）で共通利用する。

function renderSplitQuestionHTML(text, escapeHtmlFn) {
  const esc = escapeHtmlFn || ((s) => String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c])));

  const raw = text || '';
  const idx = raw.indexOf('/');
  if (idx === -1) return esc(raw);

  const before = raw.slice(0, idx);
  const after = raw.slice(idx + 1);
  return `<span style="color:var(--gold);">${esc(before)}</span><span style="color:#fff;">${esc(after)}</span>`;
}
