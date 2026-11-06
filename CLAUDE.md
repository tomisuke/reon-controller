# REON Controller: Claude 引き継ぎ

このリポジトリは、Web Bluetoothで REON POCKET を操作し、人物間距離・M5StickS3の加速度・周囲温度で出力を切り替えるWebアプリです。

## 現在の基準

- 公開URL: `https://reon-pocket-glass.tomisuke.chatgpt.site/`
- 公開済みの基準コミット: `d0c5f2c1bf4c2cfb85f7d9caab47e34f491b1377`
- 現在のローカルブランチ: `main`
- Gitリモートは未設定。別の開発環境へ移す場合は、このフォルダを直接開くか、GitHubなどへpushしてからcloneする。
- SitesのプロジェクトIDは `.openai/hosting.json` に保存されている。認証情報・短期トークンはリポジトリには保存しない。

## 作業開始

```sh
bun install --frozen-lockfile
bun test
node scripts/build.mjs
node server.js
```

ローカル画面は `http://127.0.0.1:4173`。Web Bluetoothと実カメラの動作にはHTTPS対応ブラウザと実機が必要です。模擬デバイスを使うテストは実行できます。

## 重要な構成

- `dist/index.html`, `dist/style.css`, `dist/app.js`: REON操作画面と自動連動の統合。
- `dist/reon-client.js`, `dist/protocol.js`, `dist/gatt.js`: REONのBluetooth通信。本体のAUTO START/STOPを無効化してから手動出力を送る。ここを変更すると短時間で運転が停止する問題が再発し得る。
- `dist/distance-core.js`, `dist/distance-app.js`, `dist/distance-panel.js`: カメラ/動画による人物間距離の検出と共有API。
- `dist/distance-output.js`: 距離スコアからREONの段階出力へ変換する純粋関数。
- `dist/motion.js`, `dist/m5-client.js`: M5StickS3の加速度連動。
- `worker/api.js`, `worker/index.js`: 距離共有API。R2バインディングを使用。
- `scripts/build.mjs`: `dist/` をWorkerへ埋め込むビルド。`dist/server/index.js` は生成物なので直接編集しない。
- `tests/`: Bunテスト。`scripts/qa-*.cjs` はPlaywrightを使うブラウザ回帰テスト。

## 距離連動の仕様

距離計測と「REON連動」は別のスイッチで、どちらも初期値はOFFです。

| スコア | 出力 |
| --- | --- |
| 0 | 冷却5 |
| 25 | 冷却3 |
| 50 | 停止（連動は維持） |
| 75 | 温熱2 |
| 100 | 温熱4 |

- 0人・1人を計測中に検出した場合は、仕様どおりスコア100として温熱側になる。
- 検出が一瞬途切れた場合は、最大3秒の既存保持機能が直前のスコアを維持する。
- 計測停止、カメラ切断、共有API取得失敗、5秒超の更新切れでは、REONを停止して距離連動も解除する。
- 手動出力、手動停止、加速度連動、温度連動は距離連動を解除する。本体が自発停止を報告した場合も自動再始動しない。
- 同じ出力を繰り返し送らず、送信待ちの距離更新は最新の1件へまとめる。
- 本体が温熱4などの段階をサポートしない場合、能力情報から上限を調整して表示する。

## 変更時の確認

最低限、以下を実行する。

```sh
bun test
node scripts/build.mjs
```

距離出力の変更時は `tests/distance-output.test.js` と `tests/app.test.js` を更新する。ブラウザ検証環境がある場合は、ローカルサーバー起動後に以下も実行する。

```sh
node scripts/qa-distance-output.cjs
node scripts/qa-compact.cjs
```

実機検証は、少なくとも冷却・温熱・停止、本体のAUTO START/STOP無効化、距離連動の更新切れ、人物0〜1人時の挙動を確認する。

## 公開

公開先はOpenAI Sitesです。ローカル変更をGitで確定し、`node scripts/build.mjs` で生成したWorkerをSitesの既存プロジェクトへ保存・配信する。公開認証情報はClaude側に引き継がれないため、公開操作にはこのSitesプロジェクトの編集権限を持つアカウントが必要です。公開設定やR2バインディングは `.openai/hosting.json` の内容を維持する。

機能の詳細、データ仕様、技術選定理由は `README.md`、`DISTANCE.md`、`STOP-FIX.md` を参照する。
