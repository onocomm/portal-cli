# ONOCOMM Portal CLI

株式会社オノコムのPortalを、人間・AIエージェント・スクリプトから利用する公式CLIです。
MCPは経由せず、ログインしたPortal利用者としてPortal APIへ接続します。
ソースコードはこの公開リポジトリで開発します。ライセンスは[MIT](LICENSE)です。

**初版0.1.0は参照専用です。** 主要15分野を含む36操作に対応します。
Consoleの管理機能、任意GraphQL、DynamoDB直接操作、契約変更・申請・送信は含みません。
公開ソースであることは、Portalの利用権限や顧客データへのアクセスを付与するものではありません。

## 現在の提供状況

- CLIソース、設定、テスト、利用ガイドを公開しています。npmレジストリへの公開は行っていません。
- 本番Portalの公開クライアント設定を既定値として使用します。秘密鍵・client secret・AWS管理者認証は含みません。
- **ブラウザログインに必要な`http://127.0.0.1:19878/callback`の本番登録は未反映です。** 共通認証基盤側の変更を準備しています。反映前はブラウザログインが`redirect_mismatch`になります。
- メールOTPは既存の許可フローを利用する代替方式です。MFA設定や外部IdPなどにより利用できないアカウントがあります。
- 実ユーザーでのブラウザ・OTP認証、実顧客データの参照は、受入確認が必要です。自動テストだけで実環境の動作完了とは扱いません。

## インストール

Node.js 22.12以上とnpm、Gitが必要です。

```bash
git clone https://github.com/onocomm/portal-cli.git
cd portal-cli
npm ci --ignore-scripts
npm run check
npm link
onocomm-portal --help
```

GitHubからインストールする場合、npmが`prepare`でTypeScriptをビルドします。
ソースと依存関係を確認してから実行してください。

```bash
npm install -g git+https://github.com/onocomm/portal-cli.git
```

## クイックスタート

ブラウザ認証はcallback登録の反映後に使用できます。
CLIがブラウザを開き、共通ログイン画面で本人が認証します。
パスキー、メールコード、Googleなどの選択肢は共通認証基盤と本人の設定に従います。

```bash
onocomm-portal auth login
onocomm-portal auth status --json
onocomm-portal auth me --json
onocomm-portal domain list --limit 50 --json
onocomm-portal domain get --domain-name example.com --json
onocomm-portal quotation list --all --json
```

`example.com`は文書用の例です。実行時は自分のPortalで利用を許可された対象に置き換えます。
`auth status`は保存済み期限の表示であり、オンライン認可の確認ではありません。
`auth me`はAPIへ問い合わせ、有効なPortal Userの認可を受けます。

## 人間とAIの使い分け

端末への出力は既定で人間向け表示、パイプ・非TTYではJSONです。
AIやスクリプトは`--json --non-interactive`を明示してください。

```bash
onocomm-portal --json --non-interactive schema
onocomm-portal --json schema invoice.list
onocomm-portal --json run domain.get --input '{"domain_name":"example.com"}'
onocomm-portal --json domain list --all --max-pages 1000
```

成功はstdout、エラーはstderrへJSONを出力します。認証の案内はstderrへ出力します。
`schema`と`--help`はログイン不要です。任意のGraphQLを`run`へ渡すことはできません。

```json
{"ok":true,"data":[],"meta":{"operation":"domain.list","pages":1,"nextToken":null}}
```

認証が必要なときに、AIがパスワード・OTP・本人確認を代行して突破する仕組みはありません。
人間がログインしたセッションを使用し、期限内は必要に応じて自動更新します。

## 認証とデータの境界

```text
本人のブラウザ認証（Authorization Code + PKCE）またはメールOTP
  -> 共通Cognitoの本人トークンを検証
  -> PortalのIdentity Poolから一時資格情報を取得
  -> SigV4署名したPortal APIリクエスト
  -> 有効なPortal User / customer_groupによる既存のサーバー認可
```

メールアドレスや任意の利用者IDを認可キーにしません。AWS profileや環境変数の管理者資格情報、
Console用Identity Pool、MCPサービスユーザーは利用しません。
認証に成功しても、Portal利用権限がない利用者・許可されていない顧客の参照はAPI側で拒否されます。

## 対応する操作

顧客情報、ドメイン、SSL、AWS契約、メール契約、課金契約、請求書、見積書、注文、サーバー、
サーバーレス、ストレージ契約、DNS契約、オノコムメンバーズ、作業報告、お知らせ、サポートケースを参照できます。
詳細は`onocomm-portal schema`と[コマンドガイド](docs/commands.md)を参照してください。

## ドキュメント

- [ブラウザ・OTP・標準入力による認証](docs/authentication.md)
- [コマンド・ページング・JSON仕様](docs/commands.md)
- [設定と環境の分離](docs/configuration.md)
- [AIエージェント向け手順](docs/agents.md)
- [セキュリティと報告先](SECURITY.md)
- [開発・検証](CONTRIBUTING.md)

## 関連リポジトリ

- [Portal MCPの公開ガイド](https://github.com/onocomm/portal-mcp)：MCPを利用する場合。
- Portalバックエンドの開発は非公開の`onocomm-system-portal`、共通認証の管理は`onocomm-identity-platform`で行います。
- 社内管理用の非公開`onocomm-cli`とは別製品です。管理画面の権限・コマンドは含みません。
