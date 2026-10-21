# 人物間距離サービス

公開後の入口: `https://reon.tomisuke.com/distance`。REON Controllerの「人物間の距離」カードから同じページ内でも使用可能。

## スコアの仕様

`score = round(min(100, 100 × d / (hypot(videoWidth, videoHeight) × fullScale)), 1)`。

- `d` は人物の検出枠の中心間のユークリッド距離（ピクセル）。0に近いほど近い。
- `fullScale` の初期値は1。映像の対角線を100にする固定基準で、過去の最大値に自動追従しない。時間とともに同じ配置の値が変わる問題を避ける。
- 撮影範囲で最も遠い配置を100にしたい場合、その配置で「現在の2人の距離を100に設定」を押す。最大距離は対角線の5〜100%に設定可能。
- 0人・1人は100。3人以上では最も近い組を採用。人物IDの継続追跡や特定人物の選択は行わない。最大30検出枠、初期信頼度55%。
- 停止、一時停止、シーク中、終了、カメラ切断、解析失敗、非表示で出力を100に戻す。非表示から戻ったときは手動で再開する。
- 共有APIとControllerは5秒更新切れで100。APIの更新時刻はサーバー時刻。`fresh` と `status` で「遠い」と「計測なし」を区別できる。
- これは映像上の2Dの相対距離であり、メートルや3D距離ではない。カメラの角度・遠近・レンズ・遮蔽に依存する。実距離にはカメラ校正、床面の射影変換、または深度センサーが別途必要。

## 技術選定と理由

| 選定 | 理由・代替案との比較・制約 |
|---|---|
| ブラウザ内推論 | 映像をアップロードせず、ネットワーク往復やGPUサーバー運用が不要。モデル取得には初回インターネット接続が必要。画面を閉じた後の無人解析には使えない。常時動作が必要なら別途常駐プロセスが必要。 |
| TensorFlow.js 4.22.0 | JavaScriptの映像要素を直接モデルへ渡せ、既存ブラウザUIと統合しやすい。WebGLを優先し、初期化できなければCPUへ切替。WebGPU必須にせず対応範囲を確保する。CPUでは速度が下がる。 |
| COCO-SSD 2.2.3 / lite_mobilenet_v2 | 学習済みのpersonクラスと検出枠を使え、追加学習やモデル変換が不要。軽量なモデルを選び、端末内での実行を狙う。YOLO系はモデルの取得・変換・配布条件の判断が増え、MediaPipe Poseは不要な骨格推定が加わるので、今回の検出枠だけの要件には採用しない。小さい人物・重なった人物・特殊な視点での精度は保証しない。 |
| HTML / CSS / ES Modules | 既存REONがこの構成なので、そのまま拡張できる。React等の追加フレームワークやランタイム依存を増やす必要がない。画面、計算、連携、APIをモジュールで分離。 |
| getUserMedia / HTMLVideoElement / Canvas | ブラウザ標準APIでカメラ・動画ファイルと検出枠描画を実現。音声は取得しない。HTTPSとカメラ権限が必要。動画コーデック対応はブラウザ次第。 |
| 2Dの中心間距離と固定スケール | 単眼映像だけで誤ってメートルを推定せず、式を説明・再現できる。検出枠の端の間隔は重なったとき広い範囲が0になるため中心を選ぶ。履歴最大値での自動正規化は値が不安定になるため使わない。平滑化で0〜1人の100への切替を遅らせない。 |
| 解析は最大5fps、APIは最大1Hz | 人の位置変化と端末負荷のバランスを取るための初期設定。推論を重複させない。実fpsは端末の性能に依存し、最低速度を保証するものではない。APIへ送るのはscore・人数・スケール・activeのみ。 |
| 同一オリジンのWorker API | REONの既存ドメインに `/distance` と `/api/distance/…` を追加し、クロスオリジンのCookie/CORS問題を避ける。WebSocket専用サーバーを作らず通常のJSON取得で利用可能。既存のBluetooth処理は変更しない。 |
| Cloudflare Workers ESM | Sitesでサポートされるサーバー実行形式。静的サイトを既存URL・公開範囲・ファイルを維持して移行する。小規模APIなので、Nodeサーバーの常駐運用やVinextのUI再構築は不要。ビルドはNode標準ライブラリだけで既存アセットを埋め込む。 |
| R2の最新値保存 | 最新の数値1件と共有認証情報だけが必要で、SQLの関係・履歴検索は不要なためD1を導入しない。Workerメモリだけに依存せず、別端末・別インスタンスから同じ数値を取得する。履歴・画像・座標は保存しない。論理期限は7日で、期限後は410。失効オブジェクトの自動物理削除は未実装。 |
| 読み取り用128bitランダムID、書き込み用256bitトークン | 読み取りURLだけをControllerへ渡せる。作成はSitesのログイン済みユーザーに限定、更新・削除には別のトークンと同一Originが必要。サーバーにはトークンのSHA-256だけを保存。URLを知る人は数値を読めるため、公開投稿はしない。書き込みトークンは計測端末のブラウザストレージだけに保持し、ソースや画面には出さない。 |
| localStorage / BroadcastChannel | 同じブラウザ・同じオリジンでは共有API作成やログインなしで参照できる。永続サーバーデータの代用にはしない。別端末にはR2付きAPIを使う。計測画面は1つずつ使う。 |
| 最大5秒の鮮度期限、タイムアウト、直列更新 | 古い近距離値を使い続けない。通信やストレージ障害時は100に倒し、エラーを表示する。物理機器への出力は自動で開始せず、数値の参照機能を提供する。 |
| 固定バージョンのCDN | MLランタイムをSitesのWorkerに大きく埋め込まず配信できる。バージョンを固定して意図しない更新を避ける。CDNとモデル配布元に依存するため、外部配信停止時やオフライン初回利用ではモデルを読み込めない。Google Fontsは表示用で、取得できない場合はOSフォントへ戻る。 |

公式資料: [COCO-SSD](https://github.com/tensorflow/tfjs-models/blob/master/coco-ssd/README.md)、[TensorFlow.js](https://www.tensorflow.org/js)、[getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)。

## REONからの利用

1. REONの「人物間の距離」→「この画面でカメラ・動画を解析」を開く。参照も開始される。閉じると解析を停止。
2. 別端末の場合、計測画面で「共有APIを作成」。必要ならChatGPTでログインし、戻って作成する。
3. 読み取り専用URLをREONの距離API欄に貼り、「スコアを参照」。または「この値をControllerで開く」。

参照のみを実装しており、スコアから冷却・温熱への対応は設定しない。既存の温度API欄は摂氏温度用なので距離APIは入れない。

同じブラウザでプログラムから参照:

```js
import {localDistance, fetchDistance} from '/distance-client.js';
const local = localDistance(); // {score, personCount, fresh, ...}
const remote = await fetchDistance('/api/distance/<共有ID>');
window.addEventListener('reon-distance', ({detail}) => console.log(detail.score));
// Controllerの参照中は window.reonDistance にも最新の読取値を公開。
```

別端末のAPI（同じオリジンからのfetch、またはサーバーからのHTTP GET）:

```json
{
  "schemaVersion": 1,
  "score": 24.3,
  "personCount": 2,
  "status": "tracking",
  "fresh": true,
  "timestamp": "2026-10-21T00:00:00.000Z",
  "ageMs": 100,
  "staleAfterMs": 5000,
  "metric": "nearest_centers_2d",
  "fullScale": 1
}
```

- `POST /api/distance/sessions` : Sitesログインと同一Originが必要。`id / writeToken / readUrl / expiresAt` を返す。
- `PUT /api/distance/:id` : `Authorization: Bearer <writeToken>` とJSON `{active:true,score:24.3,personCount:2,fullScale:1}`。停止は `{active:false}`。scoreは端末内推論による値で、サーバーは範囲・人数を検証する。
- `GET /api/distance/:id` : 読み取りURLによる最新値取得。書き込みトークンは不要。`Cache-Control: no-store`。状態が停止/期限切れなら100。
- `DELETE /api/distance/:id` : トークンと同一Originが必要。共有URLを失効。
- 不明ID404、期限切れ410、認証401、Origin違反403、入力不正400、ストレージ障害503。取得失敗時も呼び出し側は100を使う。
- 他のWebサイトのブラウザからのCORSアクセスは許可しない。同じREONサイトまたはサーバーから参照する。

## ローカル起動・検証

`node scripts/build.mjs` → `node server.js` → `http://127.0.0.1:4173/distance`。

ローカルプレビューのみメモリストレージと開発用IDを使用する。再起動すると共有は消える。本番WorkerはSitesから渡された認証情報とR2を使う。

計算・API: `node --test tests/distance.node.test.js`。既存REON回帰: `bun test`。ブラウザ確認スクリプトは `scripts/qa-distance.cjs`（PlaywrightとChromeが必要）。実際のカメラ、REON実機、撮影現場の検出精度は別途確認が必要。
