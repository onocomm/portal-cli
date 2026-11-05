# コマンドと出力

```bash
onocomm-portal --help
onocomm-portal domain --help
onocomm-portal domain get --help
onocomm-portal schema
onocomm-portal schema support-case.by-number
```

`schema`は操作名・入力名・型・必須指定・固定クエリ・ページングの有無を返します。
常にこのCLIバージョンのカタログを確認してください。
`login`、`logout`、`status`はオプションなしで使用する簡易エイリアスです。詳細なオプションは`auth`配下を使います。

## 参照

```bash
onocomm-portal auth me --json
onocomm-portal customer list --json
onocomm-portal domain list --all --json
onocomm-portal quotation list --json
onocomm-portal order list --json
onocomm-portal support-case list --json
onocomm-portal support-case by-number --case-number ABC123 --json
```

`ABC123`は架空の例で、テスト用ケースではありません。自身に許可された対象のみ指定します。
顧客・ケース番号を推測してアクセスしないでください。

請求書など一部の一覧は検索条件が必須です。入力仕様は`schema invoice.list`を参照します。
日時の整数項目はAPIと同じUNIXTIME（秒）です。日本語ラベルや日付文字列への自動変換は行いません。

## JSON入力

```bash
onocomm-portal run domain.get --input '{"domain_name":"example.com"}' --json
onocomm-portal run domain.get --input-file input.json --json
onocomm-portal run domain.get --input-file - --json
```

`run`で使用できるのはカタログ内の固定参照操作だけです。
任意クエリ、mutation、`update_user`、`auth_user_id`、未知の入力項目は受け付けません。
個人情報を含む入力ファイルはコミット・公開しないでください。

## ページング

- 既定は1ページのみ取得し、`meta.nextToken`を返します。
- `--limit 50`でページ件数を指定できます（1〜1000、実際の上限はAPIにも従います）。
- `--next-token <値>`で続きを取得します。
- `--all`は続きがなくなるまで取得します。空のページでもnextTokenがあれば続けます。
- `--max-pages`は既定1000、最大10000です。
- トークンのループやページ上限はエラーです。部分取得を全件成功として出力しません。

全件取得は時間・通信量・API費用を伴います。必要な範囲で使用してください。
一度の全件取得中は同じAWS一時資格情報を使用するため、長時間かかる場合は期限内に完了する範囲へ絞ってください。

## JSON契約

成功はstdoutに1つのJSONを返します。

```json
{"ok":true,"data":[],"meta":{"operation":"domain.list","pages":1,"nextToken":null}}
```

失敗はstderrにJSONを返し、stdoutに成功結果を出しません。
サーバーの生例外・トークン・部分応答はエラーへ含めません。

```json
{"ok":false,"error":{"code":"LOGIN_REQUIRED","message":"有効なPortalセッションがありません。loginを実行してください。"}}
```

| 終了コード | 意味 |
| --- | --- |
| 0 | 成功、help、version |
| 1 | その他の認証処理エラー（各error.codeも確認） |
| 2 | 認証・Portalアクセス拒否 |
| 3 | コマンド・入力・設定エラー |
| 4 | API・応答・ページングエラー |
| 5 | ローカル保存・排他・その他のCLIエラー |

`--help`は人間向けテキストです。機械的な操作発見には`schema --json`を使います。
人間向けの`--output table`は、入れ子を含むデータの読みやすいテキスト表示です。表形式の固定契約ではありません。
