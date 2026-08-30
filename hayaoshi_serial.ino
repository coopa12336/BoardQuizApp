/**************************************************************************
RP2040マイコンボードキット早押し機【10~12端子早押し機】
**************************************************************************/

const int button_number = 10;                                                 //ボタンの数
int sw[button_number] = { 100, 100, 100, 100, 100, 100, 100, 100, 100, 100 };  ///押しボタン格納
int osippa[button_number] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
const int inpin[button_number] = { 16, 17, 18, 19, 20, 21, 22, 23, 24, 25 };
const int ledpin[button_number] = { 14, 13, 12, 11, 10, 9, 8, 7, 6, 5 };
int SW_delay[button_number] = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };

int handicap = 0;
unsigned long delaytime = 0;
unsigned long stoptime = 0;
int var = 0;
int zantei = 0;
int a = 0;
int b = 0;

int ButtonSerialNumber1 = 0;
int ButtonSerialNumber2 = 0;

int GotouKaisuu = 0;

bool SerialNumberCount = true;

const int TRUE = 28;   ///正解ボタン
const int FALSE = 29;  ///不正解ボタン
const int speakerpin = 0;  ///tone関数で音を鳴らすピン

int sound_state = 0;

int state = 0;
int i = 0;
int ledpin1 = 0;
int ledpin2 = 0;
int rule = 0;

unsigned long ms = 0;
unsigned long mc = 0;
unsigned long tenmetu_time_before = 0;
unsigned long tenmetu_time_after = 0;
unsigned long music_time_before = 0;
unsigned long music_time_after = 0;

void reset(void);
void tenmetu(void);
void osippa_set1(void);
void music(void);

// ★ シリアル通信で着順とボタン番号を送るヘルパー関数
void sendButtonRank(int rank, int button_idx) {
  Serial.print("ButtonRank");
  Serial.print(rank);
  Serial.print(":");
  Serial.println(button_idx + 1); // インデックス(0~)を1スタートのボタン番号に変換
}

void setup() {
  Serial.begin(9600);

  delay(1000);

  pinMode(TRUE, INPUT_PULLUP);
  pinMode(FALSE, INPUT_PULLUP);

  for (i = 0; i < button_number; i++) {
    pinMode(inpin[i], INPUT_PULLUP);
  }
  for (i = 0; i < button_number; i++) {
    pinMode(ledpin[i], OUTPUT);
  }

  if ((digitalRead(TRUE) == LOW) && (digitalRead(FALSE) == LOW)) {
    rule = 3;
    delaytime = millis();
    while ((digitalRead(TRUE) == LOW) && (digitalRead(FALSE) == LOW)) {

      for (i = 0; i < button_number; i++) {
        if ((digitalRead(inpin[i]) == LOW) && (SW_delay[i] == 0)) {
          SW_delay[i] = 1;
          digitalWrite(ledpin[i], HIGH);
          delay(100);
          digitalWrite(ledpin[i], LOW);
        }
      }
      delay(20);  ///チャタリング対策
    }
    if (millis() - delaytime <= 1500) {  ///0~1500
      handicap = 1000;

      for (i = 0; i < button_number; i++) {
        if (SW_delay[i] == 1) {
          SW_delay[i] = handicap;
        }
      }

    } else if (millis() - delaytime <= 2500) {  ///1501~2500
      handicap = 2000;

      for (i = 0; i < button_number; i++) {
        if (SW_delay[i] == 1) {
          SW_delay[i] = handicap;
        }
      }
    } else if (millis() - delaytime <= 3500) {  ///2501~3500
      handicap = 3000;

      for (i = 0; i < button_number; i++) {
        if (SW_delay[i] == 1) {
          SW_delay[i] = handicap;
        }
      }
    } else if (millis() - delaytime <= 4500) {  ///3501~4500
      handicap = 4000;

      for (i = 0; i < button_number; i++) {
        if (SW_delay[i] == 1) {
          SW_delay[i] = handicap;
        }
      }
    } else if (millis() - delaytime > 4500) {  ///4501~
      handicap = 5000;

      for (i = 0; i < button_number; i++) {
        if (SW_delay[i] == 1) {
          SW_delay[i] = handicap;
        }
      }
    }

    for (i = 0; i < handicap / 1000; i++) {
      tone(speakerpin, 1319, 100);
      delay(100);
      tone(speakerpin, 1047, 350);
      delay(350);
    }

  } else if (digitalRead(TRUE) == LOW) {
    rule = 1;
    tone(speakerpin, 1000, 100);  ///エンドレスチャンスの音を鳴らす。
    delay(100);
    tone(speakerpin, 2000, 100);
    delay(600);
  } else if (digitalRead(FALSE) == LOW) {
    rule = 2;
    tone(speakerpin, 1000, 200);  ///ダブルチャンスの音を鳴らす。
    delay(100);
    tone(speakerpin, 2000, 200);
    delay(100);
    tone(speakerpin, 1000, 200);  ///ダブルチャンスの音を鳴らす。
    delay(100);
    tone(speakerpin, 2000, 200);
    delay(600);
  } else {
    rule = 0;
    tone(speakerpin, 2000, 100);  ///シングルチャンスの音を鳴らす
    delay(100);
    tone(speakerpin, 1000, 100);
    delay(600);
  }
}



void loop() {
  if (rule == 0 || rule == 1) {
    for (i = 0; i < button_number; i++) {
      if ((digitalRead(inpin[i]) == LOW) && (sw[i] > 50) && osippa[i] == 0) {
        state = (state + 1);
        sw[i] = state;

        // ★ 着順とボタン番号をシリアル出力
        sendButtonRank(state, i);

        if (state == 1) {
          ledpin1 = ledpin[i];
          digitalWrite(ledpin1, HIGH);
          noTone(speakerpin);
          tenmetu_time_before = millis();
          music_time_before = millis();

          sound_state = 0;
          music();

          ButtonSerialNumber1 = i + 1;
        }
        if (rule == 1) {
          if (state == 2) {
            ledpin2 = ledpin[i];
            digitalWrite(ledpin2, HIGH);
          }
        }
      }
    }
  } else if (rule == 3) {
    for (i = 0; i < button_number; i++) {
      if ((digitalRead(inpin[i]) == LOW) && (sw[i] > 50) && (osippa[i] == 0)) {
        state = (state + 1);
        sw[i] = state;

        // ★ 着順とボタン番号をシリアル出力（ハンディキャップルール用）
        sendButtonRank(state, i);

        if (state == 1) {
          if (SW_delay[i] == 0) {
            var = 1;
            ButtonSerialNumber1 = i + 1;

          } else if (SW_delay[i] > 0)
            var = 2;
          zantei = i;
          stoptime = millis();
        }

        switch (var) {
          case 0:

            break;

          case 1:
            ledpin1 = ledpin[i];
            digitalWrite(ledpin1, HIGH);
            noTone(speakerpin);
            tenmetu_time_before = millis();
            music_time_before = millis();

            sound_state = 0;
            music();
            var = 0;

            break;

          case 2:
            while (handicap > millis() - stoptime) {
              for (b = 0; b < button_number; b++) {
                if ((digitalRead(inpin[b]) == LOW) && (SW_delay[b] == 0) && (sw[b] > 50) && (osippa[b] == 0)) {
                  zantei = b;
                  ButtonSerialNumber1 = b + 1;

                  state = (state + 1);
                  sw[b] = state;

                  // ★ 割り込みボタン押下時のシリアル出力
                  sendButtonRank(state, b);

                  goto bailout;
                }
              }
            }
bailout:
            if (state == 1 || state == 2) {
              ledpin1 = ledpin[zantei];
              digitalWrite(ledpin1, HIGH);
              noTone(speakerpin);
              tenmetu_time_before = millis();
              music_time_before = millis();

              sound_state = 0;
              music();
              var = 0;
            }
            break;

          default:
            var = 0;
            break;
        }
      }
    }
  } else if (rule == 2) /*ダブルチャンスルール*/ {
    for (i = 0; i < button_number; i++) {
      if ((digitalRead(inpin[i]) == LOW) && (sw[i] > 50) && osippa[i] == 0 && state < 2) {
        state = (state + 1);
        sw[i] = state;

        // ★ ダブルチャンスでの着順とボタン番号を出力
        sendButtonRank(state, i);

        if (state == 1) {
          ledpin1 = ledpin[i];
          digitalWrite(ledpin1, HIGH);
          noTone(speakerpin);
          tenmetu_time_before = millis();
          music_time_before = millis();
          sound_state = 0;
          music();
          ButtonSerialNumber1 = i + 1;
        }
        if (state == 2 && (GotouKaisuu == 0)) {
          ledpin2 = ledpin[i];
          digitalWrite(ledpin2, HIGH);  // 1番目が点滅している間だけ点灯
        }
      }
    }
  }

  tenmetu();
  music();

  if (digitalRead(TRUE) == LOW) {  //TRUEとFALSEのボタンは冒頭で定義する
    reset();
    noTone(speakerpin);

    tone(speakerpin, 1319, 50);
    delay(50);
    tone(speakerpin, 1047, 50);
    delay(50);
    tone(speakerpin, 1319, 50);
    delay(50);
    tone(speakerpin, 1047, 50);
    delay(50);
    tone(speakerpin, 1319, 50);
    delay(50);
    tone(speakerpin, 1047, 250);
    delay(250);

    osippa_set1();

  } else if (digitalRead(FALSE) == LOW) {
    if (rule == 0) {
      reset();
      noTone(speakerpin);
      tone(speakerpin, 230);
      while (digitalRead(FALSE) == LOW) {
      }
      noTone(speakerpin);
      osippa_set1();
    }
    if (rule == 3) {
      reset();
      noTone(speakerpin);
      tone(speakerpin, 230);
      while (digitalRead(FALSE) == LOW) {
      }
      noTone(speakerpin);
      osippa_set1();
    }
    if (rule == 1) {
      noTone(speakerpin);
      tone(speakerpin, 230);

      for (unsigned long before = millis(), after = millis(); (after - before) < 100;) {
        tenmetu();
        after = millis();
      }
      while (digitalRead(FALSE) == LOW) {
        tenmetu();
      }
      noTone(speakerpin);
      for (unsigned long before = millis(), after = millis(); (after - before) < 300;) {
        tenmetu();
        after = millis();
      }
      osippa_set1();

      digitalWrite(ledpin1, LOW);
      digitalWrite(ledpin2, LOW);
      if (state > 0) {
        ledpin1 = 0;
        ledpin2 = 0;
        state--;
        for (i = 0; i < button_number; i++) {
          sw[i]--;
          if (sw[i] == 1) {
            ledpin1 = ledpin[i];
            digitalWrite(ledpin1, HIGH);
            tenmetu_time_before = millis();
            music_time_before = millis();
            music();
            ButtonSerialNumber1 = i + 1;
          }
          if (sw[i] == 2) {
            ledpin2 = ledpin[i];
            digitalWrite(ledpin2, HIGH);
          }
        }
      }
    }



    if (rule == 2) {
      if (state > 0) {
        GotouKaisuu = GotouKaisuu + 1;

        if (GotouKaisuu == 2) {  // 2回目の誤答（2人目の誤答）
          reset();
          noTone(speakerpin);

          tone(speakerpin, 230, 150);
          delay(200);
          tone(speakerpin, 230, 150);
          delay(200);
          tone(speakerpin, 230, 150);
          delay(200);
          tone(speakerpin, 230, 500);
          delay(700);
          noTone(speakerpin);
          osippa_set1();

          GotouKaisuu = 0;

        } else {  // 1回目の誤答（1人目の誤答）
          noTone(speakerpin);
          tone(speakerpin, 230);

          for (unsigned long before = millis(), after = millis(); (after - before) < 100;) {
            tenmetu();
            after = millis();
          }
          while (digitalRead(FALSE) == LOW) { tenmetu(); }
          noTone(speakerpin);
          for (unsigned long before = millis(), after = millis(); (after - before) < 300;) {
            tenmetu();
            after = millis();
          }
          osippa_set1();

          int wrong_answer_index = -1;
          for (i = 0; i < button_number; i++) {
            if (ledpin[i] == ledpin1) {
              wrong_answer_index = i;
              break;
            }
          }

          if (ledpin2 != 0) {
            digitalWrite(ledpin1, LOW);  
            ledpin2 = 0;
            state = 1;  

            for (i = 0; i < button_number; i++) {
              if (i == wrong_answer_index) {
                sw[i] = 0;  
              } else if (sw[i] == 2) {
                sw[i] = 1;  
                ledpin1 = ledpin[i];
                digitalWrite(ledpin1, HIGH);
                tenmetu_time_before = millis();
                music_time_before = millis();
                sound_state = 0;
                music();
                ButtonSerialNumber1 = i + 1;
              } else {
                sw[i] = 100;  
              }
            }
          } else {
            if (ledpin1 != 0) {
              digitalWrite(ledpin1, LOW);  
            }
            ledpin1 = 0;
            ledpin2 = 0;
            ButtonSerialNumber1 = 0;
            ButtonSerialNumber2 = 0;
            sound_state = 0;
            state = 0;  

            for (i = 0; i < button_number; i++) {
              if (i == wrong_answer_index) {
                sw[i] = 0;  
              } else {
                sw[i] = 100;  
              }
            }
          }
        }
      } else {
        noTone(speakerpin);
        tone(speakerpin, 230);
        while (digitalRead(FALSE) == LOW) {
        }
        noTone(speakerpin);
        osippa_set1();
      }
    }
  }

  for (i = 0; i < button_number; i++) {
    if (digitalRead(inpin[i]) == HIGH) {
      osippa[i] = 0;
    }
  }
}



void reset() {
  state = 0;
  ledpin1 = 0;
  ledpin2 = 0;
  ButtonSerialNumber1 = 0;
  ButtonSerialNumber2 = 0;
  sound_state = 0;
  GotouKaisuu = 0;


  for (i = 0; i < button_number; i++) {
    digitalWrite(ledpin[i], LOW);
    sw[i] = 100;
  }
}


void tenmetu() {
  if (state == 0) return;

  tenmetu_time_after = millis();
  ms = tenmetu_time_after - tenmetu_time_before;
  if (ms < 150) {
    digitalWrite(ledpin1, HIGH);
  } else if (ms < 300) {
    digitalWrite(ledpin1, LOW);
  } else {
    digitalWrite(ledpin1, HIGH);
    tenmetu_time_before = millis();
  }
}

void osippa_set1() {
  for (int i = 0; i < button_number; i++) {
    osippa[i] = 1;
  }
}

void music() {
  if (state == 0) {
    if (sound_state != 0) {
      noTone(speakerpin);
      sound_state = 0;
    }
    return;
  }

  music_time_after = millis();
  mc = music_time_after - music_time_before;

  if (mc < 100) {
    if (sound_state != 1) {  
      tone(speakerpin, 1319);
      sound_state = 1;
    }
  }
  else if (mc < 350) {
    if (sound_state != 2) {  
      tone(speakerpin, 1047);
      sound_state = 2;
    }
  }
  else {
    if (sound_state != 0) {  
      noTone(speakerpin);
      sound_state = 0;
    }
  }
}