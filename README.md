# 同期動画視聴テスト MVP

YouTube／Vimeoの再生、停止、シーク、途中参加を試すMVPです。Supabaseを設定すると別PC・スマートフォン間で同期し、未設定時は同じブラウザの複数タブで動作します。

## 試し方

1. `/admin/test001/` を開く
2. 別タブで `/watch/test001/` を開く
3. 管理画面に埋め込み可能なYouTubeまたはVimeoのURLを入力する
4. 視聴画面で「視聴準備をする」を押す
5. 管理画面から再生、停止、シークを操作する

視聴画面に `?debug=1` を付けると期待位置と実位置を表示します。

## Supabase設定

1. `supabase/schema.sql` 内の `YOUR_ADMIN_CODE` を長い管理コードに置換してSQL Editorで実行する
2. Project URLとPublishable keyを`dist/config.js`へ設定する
3. 管理画面の「管理コード」に同じ値を入力する

秘密キーやService Role keyは`config.js`へ入れないでください。ブラウザにはPublishable keyだけを設定します。

## 現在の制限

- Supabase未設定時は同じブラウザ・同じプロファイルのタブ間のみ同期します。
- Supabase設定時はRoomState、Realtime Presence、簡易サーバー時刻補正を使用します。
- 管理者アカウント認証は未実装です。MVPではルームごとの管理コードをDB側で照合します。
- 動画側で埋め込みが禁止されている場合は再生できません。
- ブラウザの自動再生制限により、プレイヤー内の再生ボタンを一度押す必要がある場合があります。

本番利用前に管理者認証、非公開ルーム、複数端末での精度計測が必要です。

## Vercel公開

このリポジトリをVercelへImportすると、`vercel.json`の設定により`dist`ディレクトリがそのまま公開されます。ビルドや依存パッケージのインストールは不要です。
