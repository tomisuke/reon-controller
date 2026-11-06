# REON Controller: Claude 引き継ぎ

このリポジトリは、Web Bluetoothで REON POCKET を操作し、人物間距離・M5StickS3の加速度・周囲温度で出力を切り替えるWebアプリです。

## 現在の基準

- 公開URL: `https://reon.tomisuke.com/`（GitHub Pages。`https://tomisuke.github.io/reon-controller/` も同じ配信物）
- ソース: `https://github.com/tomisuke/reon-controller`（`main`）
- 以前のOpenAI Sites版（Worker＋R2、`reon-pocket-glass.tomisuke.chatgpt.site`）は廃止。別端末共有APIも廃止した。

## 作業開始

```sh
bun install --frozen-lockfile
bun test
node server.js
```

ローカル画面は `http://127.0.0.1:4173`。Web Bluetoothと実カメラの動作にはHTTPS対応ブラウザと実機が必要です。模擬デバイスを使うテストは実行できます。

## 重要な構成

- `dist/index.html`, `dist/style.css`, `dist/app.js`: REON操作画面と自動連動の統合。
- `dist/reon-client.js`, `dist/protocol.js`, `dist/gatt.js`: REONのBluetooth通信。本体のAUTO START/STOPを無効化してから手動出力を送る。ここを変更すると短時間で運転が停止する問題が再発し得る。
- `dist/distance-core.js`, `dist/distance-app.js`, `dist/distance-panel.js`: カメラ/動画による人物間距離の検出。
- `dist/distance-output.js`: 距離スコアからREONの段階出力へ変換する純粋関数。
- `dist/motion.js`, `dist/m5-client.js`: M5StickS3の加速度連動。
- `dist/` はそのまま公開される。ビルド工程はない。パスはサブパス配信でも動くよう相対パスで書く（`/` 始まりにしない）。
- `.github/workflows/deploy.yml`: `main` へのpushでテスト・ファームウェアビルド・GitHub Pages公開。
- `tests/`: Bunテスト。`scripts/qa-*.cjs` はPlaywrightを使うブラウザ回帰テスト。

## 距離連動の仕様

距離計測と「REON連動」は別のスイッチで、どちらも初期値はOFFです。

REON連動の前に80cm・160cmの2点キャリブレーションが必須（`dist/distance-output.js` の `CALIBRATION`）。

| 実距離 | 出力 |
| --- | --- |
| 80cm以下 | 温熱2 |
| 112cm前後 | 停止（連動は維持） |
| 160cm以上 | 冷却3 |

間は段階値の線形補間を丸める。記録は「中心間距離÷対角線」の比で保存し、「100とする距離」の変更に影響されない。

- 0人・1人を計測中に検出した場合は、仕様どおりスコア100（160cm以上扱い）として冷却3になる。
- 検出が一瞬途切れた場合は、最大3秒の既存保持機能が直前のスコアを維持する。
- 計測停止、カメラ切断、5秒超の更新切れでは、REONを停止して距離連動も解除する。
- 手動出力、手動停止、加速度連動、温度連動は距離連動を解除する。本体が自発停止を報告した場合も自動再始動しない。
- 同じ出力を繰り返し送らず、送信待ちの距離更新は最新の1件へまとめる。
- キャリブレーション未完了・リセット・矛盾した記録では連動を開始せず、連動中なら停止して解除する。
- 本体が温熱2・冷却3をサポートしない場合、能力情報から上限を調整して表示する。

## 変更時の確認

最低限、以下を実行する。

```sh
bun test
```

距離出力の変更時は `tests/distance-output.test.js` と `tests/app.test.js` を更新する。ブラウザ検証環境がある場合は、ローカルサーバー起動後に以下も実行する。

```sh
node scripts/qa-distance-output.cjs
node scripts/qa-compact.cjs
```

実機検証は、少なくとも冷却・温熱・停止、本体のAUTO START/STOP無効化、距離連動の更新切れ、人物0〜1人時の挙動を確認する。

## 公開

`main` へpushすると `.github/workflows/deploy.yml` がWebテストとM5StickS3ファームウェアのビルドを行い、両方成功した場合だけ `dist/` をGitHub Pagesへ公開する。独自ドメイン `reon.tomisuke.com` はリポジトリの Settings → Pages の Custom domain とDNSのCNAME（`tomisuke.github.io`）で設定する。公開後は `https://reon.tomisuke.com/` を取得して反映を確認する。

機能の詳細、データ仕様、技術選定理由は `README.md`、`DISTANCE.md`、`STOP-FIX.md` を参照する。
