# 数独ノート

ブラウザだけで動く、端末内保存型の数独アプリです。`isitdx` プロジェクトは変更しません。

## 開発

```bash
npm install
npm run dev
```

テストと本番ビルドは次で実行します。

```bash
npm test
npm run build
```

`dist/` は静的ファイルだけで構成され、GitHub Pages で配信できます。`main` ブランチへの push 時に `.github/workflows/deploy.yml` がビルド・デプロイします。リポジトリの GitHub Pages を GitHub Actions に設定してください。

## 保存

問題と途中入力は IndexedDB に自動保存されます。ブラウザデータ削除に備え、画面の「JSON を書き出す」でバックアップしてください。

## 写真取込

写真または画像を選択後、スライダーで数独の外枠を切り出して OCR を実行します。結果は必ず問題編集画面で確認・修正してください。画像処理はブラウザ内で行われ、アプリから画像を送信しません。

初期実装では、盤面を正面に近い角度で撮影することを想定しています。強い遠近歪みを補正する四隅指定は次の改善対象です。

## Google Drive（任意）

`public/config.js` の `googleClientId` に、Google Cloud で作成した Web OAuth クライアント ID を設定すると、JSON バックアップを Google Drive に新規保存できます。公開サイトのオリジンを OAuth の承認済み JavaScript 生成元に登録してください。

アプリは `drive.file` の最小権限のみを要求し、利用者の操作時だけ短期アクセストークンを使います。Google Drive からのファイル選択・読み込みは未実装のため、現時点では通常の JSON インポートを使ってください。
