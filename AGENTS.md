# AGENTS.md

- 日本語で応対する。公開CLIのソースと利用ガイドを管理するリポジトリ。
- Node.js 22.12以上・TypeScriptを使用する。binは`onocomm-portal`。
- Console用非公開CLIやサーバー実装をコピーしない。Portal APIの公開クライアントとして実装する。
- 認証は共通Cognito基盤を利用する。認証基盤の変更は`onocomm-identity-platform`の責務。
- 有効なPortal Userと顧客グループによるサーバー側認可を維持する。メールや任意user_idを認可キーにしない。
- ambient AWS credentials、管理者Role、MCPサービスユーザー、任意GraphQL、DynamoDB直接アクセスを利用しない。
- 顧客情報・認証情報・実ログを公開しない。トークンを引数・stdout・エラーへ含めない。
- 外向き通信の遮断・宛先制限は導入しない。
- 公開前に`npm run check`、パッケージ内容、秘密情報、Git差分を確認する。
- 実ユーザーの認証・OTP送信・業務操作は人間の操作・承認が必要。テストはモックを基本にする。
- 本番デプロイ・npm公開は明示的な指示なしに実行しない。
- コミットメッセージは1行の簡潔な日本語にする。
