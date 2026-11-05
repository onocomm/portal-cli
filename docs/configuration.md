# 接続設定

```bash
onocomm-portal config show --json
```

既定の`production`は本番Portalの公開アプリケーション設定です。
User Pool ID・App Client ID・Identity Pool ID・API URLはクライアント識別用の公開値であり、秘密鍵ではありません。
これらを知っても、本人の認証・有効なPortal User・サーバー側認可が必要です。

## 別環境

管理者から受け取った公開設定を、[設定テンプレート](../examples/config.json)の形式で保存します。

```bash
onocomm-portal --profile develop config set --file portal-develop.local.json --yes
onocomm-portal --profile develop auth login
onocomm-portal --profile develop domain list --json
```

この`--profile`はCLIのローカル保存区分で、AWS CLIのprofileとは別です。
`production`以外は設定が必須です。`--yes`は接続先を信頼し、保存済み認証を削除する確認です。
接続先はトークン・API署名の送信先になるため、不明な第三者が作った設定を取り込まないでください。

設定登録時に同じprofileのセッションとOTP待機状態を消去します。古いセッションのリモート失効は行いません。
必要なら設定変更前に`auth logout`を実行します。
URLはHTTPS、OAuthドメインはorigin、callbackは`http://127.0.0.1:19878/callback`だけを認めます。
callbackとクライアントは、共通認証基盤・Identity Poolで承認された組み合わせを使います。

## 保存先

```text
~/.onocomm-portal/<profile>/config.json
~/.onocomm-portal/<profile>/session.json
~/.onocomm-portal/<profile>/otp.json
~/.onocomm-portal/<profile>/lock.json
```

`ONOCOMM_PORTAL_HOME`で、本人専用の保存先ディレクトリへ変更できます。
親ディレクトリが存在する場所を指定し、認証情報をGit作業ディレクトリや共有フォルダーへ保存しないでください。
設定ファイルにも同じ所有者・権限の検査を適用します。
認証情報の保護範囲は[認証ガイド](authentication.md)を参照してください。

CLIは`AWS_PROFILE`や`AWS_ACCESS_KEY_ID`の管理者資格情報へフォールバックしません。
環境変数へアプリケーションの秘密鍵を登録する設定もありません。
