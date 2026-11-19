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

## Tagutis の過去の例題をまとめて取り込む

Python 3.10 以降と Pillow を使います。Pillow が入っていない環境では、最初に仮想環境を用意してください。

~~~bash
python3 -m venv .tagutis-import/venv
source .tagutis-import/venv/bin/activate
python -m pip install Pillow
~~~

リポジトリのルートで、例題ページと画像を収集して問題集を生成します。取得済みのファイルは `.tagutis-import/cache/` から再利用されます。

~~~bash
python3 scripts/tagutis_site.py
python3 scripts/import_tagutis.py
~~~

収集の対象はサイトの「過去の例題」1〜800です。最初の100問だけ処理するときは、収集コマンドに `--end 100` を追加し、生成コマンドに `--sources .tagutis-import/sources-1-100.json` を指定します。保存済みのページと画像だけを使うときは、収集コマンドに `--offline` を追加します。

`.tagutis-import/review.html` をブラウザで開くと、元画像と抽出盤面を比較できます。確認・修正した盤面は画面の「修正JSONを保存」でダウンロードし、`python3 scripts/import_tagutis.py --corrections ダウンロードしたファイル.json` で再生成します。問題集には解が一意と確認できた盤面が入り、要確認と取得不可の例題は確認画面に残ります。

アプリの「JSON を読み込む」で `.tagutis-import/tagutis-puzzles.json` を取り込めます。読み込み操作は現在の問題集全体を置き換えます。既存の問題や途中入力も残すには、先にアプリからJSONを書き出し、生成コマンドに `--base-backup 書き出したバックアップ.json` を指定してから、生成されたJSONを読み込みます。

## Google Drive（任意）

`public/config.js` の `googleClientId` に、Google Cloud で作成した Web OAuth クライアント ID を設定すると、JSON バックアップを Google Drive に新規保存できます。公開サイトのオリジンを OAuth の承認済み JavaScript 生成元に登録してください。

アプリは `drive.file` の最小権限のみを要求し、利用者の操作時だけ短期アクセストークンを使います。Google Drive からのファイル選択・読み込みは未実装のため、現時点では通常の JSON インポートを使ってください。
