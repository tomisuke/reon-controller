# ブラウザから編集・公開する

- ソース: https://github.com/tomisuke/reon-controller
- ブラウザエディタ: https://github.dev/tomisuke/reon-controller
- 自動テスト・デプロイ: https://github.com/tomisuke/reon-controller/actions/workflows/deploy.yml
- GitHub Pages: https://tomisuke.github.io/reon-controller/

## 編集して公開

1. ブラウザエディタを開き、GitHubへログインします。インストールは不要です。
2. ファイルを変更し、左側の「ソース管理」から変更内容を確認します。
3. コミットメッセージを入力し、`main` へコミット・プッシュします。ブラウザ内に保存するだけでは、別の端末や公開サイトには反映されません。
4. Actionsの `Test and deploy` がWebテストとM5StickS3のコンパイルを実行します。両方成功したときだけ、同じコミットの `dist/` が公開されます。

表示は `dist/index.html`、見た目は `dist/style.css`、画面操作は `dist/app.js`、加速度の変換は `dist/motion.js`、M5本体用のコードは `firmware/m5sticks3-motion/src/main.cpp` にあります。

複数ファイルを編集する場合は、まとめて1回のコミットにするとデプロイ回数を減らせます。大きな変更では別ブランチとプルリクエストを使い、確認後に `main` へマージします。プルリクエストはテストのみ実行し、本番公開しません。

## 手動で再デプロイ

Actionsの `Test and deploy` → `Run workflow` → `main` → `Run workflow` を選びます。再実行時もテストとコンパイルを省略しません。

失敗した場合はActionsで赤いジョブを開き、エラーを修正してコミットします。その間、最後に成功した公開版が残ります。

## 前の版へ戻す

GitHubで対象コミットの差分を確認し、戻す変更を新しいコミットとして `main` へ反映します。履歴を書き換える強制プッシュは必要ありません。戻した版も同じテスト後に公開されます。

## 構成と選定理由

GitHubはソース、変更履歴、Webエディタをまとめて管理できます。GitHub PagesはこのアプリのHTML・CSS・JavaScriptをHTTPSで配信でき、Web Bluetoothの要件に合います。Actionsがテストと公開を担当するため、編集端末にNode.jsやBunを入れる必要はありません。公開用に個人アクセストークンやSSH秘密鍵を保存せず、実行時のGitHubトークンとOIDCを使用します。

このリポジトリは公開です。接続時の認証キーや設定はブラウザで生成・保存され、リポジトリへ送信しません。個人のキー、API認証情報、センサーの実測ログなどはコミットしないでください。

従来のSites版 `reon.tomisuke.com` は別の配信先です。GitHub側の自動公開先は上記GitHub Pages URLで、Sites版へ自動同期する構成ではありません。独自ドメインをPagesへ移す場合は、GitHub PagesのCustom domain設定とDNSの変更が必要です。

ドメインが変わると、ブラウザのBluetooth接続許可と保存設定は引き継がれません。新しいURLで機器を選び直してください。

## 公式ドキュメント

- https://docs.github.com/en/codespaces/the-githubdev-web-based-editor
- https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages
