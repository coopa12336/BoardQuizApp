/*
  buzzer_sketch.ino
  早押しクイズ用 多人数ボタン読み取りスケッチ

  配線:
    各ボタンの片足をArduinoのデジタルピン(下記 BUTTON_PINS)へ、
    もう片足をGNDへ接続してください（内部プルアップを使うため
    ボタンを押すとLOWになります。抵抗の追加は不要です）。

  通信仕様:
    ボタンが押されたら "BUZZ,<番号>\n" をシリアルへ送信します。
    番号は BUTTON_PINS 配列のインデックス+1 (1始まり) です。
    サーバー側(server.js)はこの番号を、参加者が入室時に入力した
    「早押しボタン番号」と突き合わせて誰が押したかを判定します。

  ボーレート: 9600 (judge.html のシリアル接続画面と合わせてください)
*/

const int BUTTON_PINS[] = {2, 3, 4, 5, 6, 7, 8, 9}; // 最大8人分。増やす場合は配列とピン数を調整
const int NUM_BUTTONS = sizeof(BUTTON_PINS) / sizeof(BUTTON_PINS[0]);
const unsigned long DEBOUNCE_MS = 40;

bool lastState[NUM_BUTTONS];
unsigned long lastChangeAt[NUM_BUTTONS];

void setup() {
  Serial.begin(9600);
  for (int i = 0; i < NUM_BUTTONS; i++) {
    pinMode(BUTTON_PINS[i], INPUT_PULLUP);
    lastState[i] = HIGH; // 未押下
    lastChangeAt[i] = 0;
  }
}

void loop() {
  unsigned long now = millis();
  for (int i = 0; i < NUM_BUTTONS; i++) {
    bool current = digitalRead(BUTTON_PINS[i]);
    if (current != lastState[i] && (now - lastChangeAt[i]) > DEBOUNCE_MS) {
      lastChangeAt[i] = now;
      lastState[i] = current;
      if (current == LOW) { // 押された瞬間
        Serial.print("BUZZ,");
        Serial.println(i + 1);
      }
    }
  }
}
