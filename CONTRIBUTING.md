# 開発

Node.js 22.12以上を使用します。

```bash
npm ci --ignore-scripts
npm run check
npm pack --dry-run
```

`npm run check`はビルド・テスト型検査・ユニットテストを実行します。
公開テスト用のクライアント契約fixtureを使用し、非公開サーバーのチェックアウトを要求しません。
運営者が既存APIとの整合を確認する場合は、`PORTAL_SCHEMA_PATH`に非公開環境のスキーマパスを指定します。
そのスキーマ全体をこのリポジトリへコピーしないでください。

テストは認証・SDK・HTTPをモックします。実ログイン、メールOTP送信、顧客データ取得、変更・送信を自動試験で行いません。
本番callback登録、npmレジストリ公開、実ユーザー受入は別途明示的な承認・確認のもとで実施します。
CIは検証だけで、AWSデプロイ・npm公開・認証情報発行を行いません。

コミットメッセージは1行の簡潔な日本語にします。
公開前にGit差分とパッケージ内容を確認し、認証情報・顧客情報・ローカル絶対パスを含めないでください。

## 責務

- このリポジトリ：CLI、公開設定、クライアントのテスト・ドキュメント。
- `onocomm-system-portal`：Portal API、認可、業務処理。
- `onocomm-identity-platform`：共有Cognito、App Client、callback、認証ポリシー。
- Consoleの非公開CLI：社内管理業務。コード・権限・配布経路を混在させません。

MIT Licenseです。第三者依存のライセンスとセキュリティ更新も確認してください。
