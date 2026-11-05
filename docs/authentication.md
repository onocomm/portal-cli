# 認証

## ブラウザログイン（標準）

```bash
onocomm-portal auth login
```

共通Managed Loginに接続し、CLIが生成したPKCE S256・state・nonceで認証します。
CLIは`127.0.0.1`の19878番ポートだけでcallbackを受け、認可コードをCognitoへ直接交換します。
トークンをURLへ付けてブラウザからCLIへ転送する方式ではありません。
JWTの署名、issuer、audience、token_use、期限、利用者sub、nonceを検証します。

標準callbackは2026-11-05に本番・developの既存Portalクライアントへ登録済みです。
CLIからCognitoクライアントや認証ポリシーを変更する機能はありません。
`redirect_mismatch`を認証の無効化や別クライアントへのすり替えで回避しないでください。

ブラウザが自動で開かない場合は、表示されたURLを本人が開きます。

```bash
onocomm-portal auth login --no-browser
```

パスキー・Googleなどの外部IdP・MFAはブラウザで共通基盤に従って処理します。
CLI独自のパスワード保存・パスワード変更・共通Identityの作成や削除は行いません。

## リモート端末

同じ端末へcallbackが戻るようSSHポート転送を設定するか、手動受け取り方式を使用します。

```bash
onocomm-portal auth login --manual
```

別端末で表示されたURLを開き、ログイン後にブラウザが遷移した折り返しURLをCLIへ入力します。
ブラウザ側でlocalhostへの接続が失敗しても、アドレスバーにcode付きURLが残る場合があります。
そのURLを手元のCLIへ入力します。state・redirect URIが一致しなければ拒否します。
接続できない場合に無制限に試行せず、通常ブラウザ方式または利用可能なメールOTPを使ってください。

**code付きURLは短期の認証情報です。AIへのメッセージ・Issue・ログへ貼らないでください。**
この方式は標準Device Authorization Grantや自動承認・ポーリング方式ではありません。
`--manual`は人間による対話用で、`--non-interactive`と同時には使えません。

## メールOTP（代替）

```bash
onocomm-portal auth login-init --email user@example.com
onocomm-portal auth login-verify
```

メールを受け取った本人が確認コードを入力します。対話端末では入力をエコー表示しません。
手動callback URLの入力も非表示です。OTPをコマンド引数に渡す機能はありません。
非TTYでは、秘密入力を安全に渡せる仕組みから標準入力を接続します。

```bash
onocomm-portal --non-interactive auth login-verify --code-stdin
```

Cognitoの`USER_AUTH`と`EMAIL_OTP`を使用します。
MFA・IdP・アカウント状態によって使えない場合は明示的に失敗し、パスワード認証へ自動で切り替えません。
OTP送信・確認は実ユーザーへの認証操作です。AIが本人の承認なく送信・取得しないでください。

## トークン取り込み（自動化連携）

既に本人として取得した同じPortalクライアントのトークンを、標準入力から取り込めます。
パスワードの代わりに任意の文字列を受け入れる認証方式ではありません。

```bash
onocomm-portal auth import --stdin
```

入力形式は`{"idToken":"...","accessToken":"...","refreshToken":"..."}`です。
`refreshToken`は任意です。実トークンをコマンド引数・シェル履歴・チャットへ入れないでください。
取り込み時もJWT署名・期限・宛先とID/accessのsub一致を検証します。別サービスのトークンは拒否します。

## 自動更新・保存

- 保存先は既定で`~/.onocomm-portal/<profile>/`。Consoleとは分離します。
- ディレクトリは0700、ファイルは0600で保護し、原子的に保存します。シンボリックリンクや不適切な権限は拒否します。
- **現在の保存方式はOSファイル権限による保護であり、暗号化・OS Keychain保存ではありません。** 同じOS利用者・管理者権限を持つプロセスからの読み取りを防ぐものではありません。
- WindowsではPOSIX modeによる同等の保護を保証しません。プロファイル保存先のNTFS ACLを本人だけに限定してください。
- ID/access tokenは署名と期限を再検証し、必要ならrefresh tokenで更新します。更新で返されたrefresh tokenを保存します。
- AWS一時資格情報はコマンド内のメモリだけに置き、保存しません。管理者資格情報の自動検索は行いません。
- 同じprofileの認証更新はlockで排他します。強制終了で残ったlockは、実行中プロセスがないことを本人が確認してから取り除きます。
- 保存済みセッションは接続設定と結び付けます。別環境へ使い回しません。

## ログアウト

```bash
onocomm-portal auth logout
onocomm-portal auth logout --local-only
```

通常はこのCLIのrefresh tokenの失効を試み、成功・失敗にかかわらずローカル認証を削除します。
`remoteRevoked=false`ならサーバー側の失効は確認できていません。
`--local-only`はネットワーク接続せず削除します。他サービスを含むグローバルサインアウトは行いません。

## 参考

- [AWS公式 PKCE](https://docs.aws.amazon.com/cognito/latest/developerguide/using-pkce-in-authorization-code.html)
- [AWS公式 Cognito認証フロー](https://docs.aws.amazon.com/cognito/latest/developerguide/amazon-cognito-user-pools-authentication-flow-methods.html)
- [AWS公式 Identity Pool認証フロー](https://docs.aws.amazon.com/cognito/latest/developerguide/authentication-flow.html)
