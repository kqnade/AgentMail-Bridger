# AgentMail Bridger

Herdr の agent 状態イベントを購読し、worker が `done` になったら対応する
manager に Agent Mail の確認プロンプトを投入する小さな常駐プロセスです。
manager が作業中または入力待ちの場合は通知をキューし、`idle` または `done`
になってから送ります。

## 必要条件

- [mise](https://mise.jdx.dev/)（推奨）
- Node.js 20 以降（mise 使用時は Node.js 24）
- Herdr protocol 16
- manager / worker に一意な Herdr agent 名が付いていること
- 対象 agent が起動済みであること

## 開発環境

```sh
mise install
mise run setup
mise run ci
```

## 設定と起動

`config.example.json` をコピーし、Herdr の agent 名を設定します。

```sh
cp config.example.json config.json
npm start -- --config config.json
```

または環境変数だけでも起動できます。

```sh
export AGENTMAIL_BRIDGER_MAPPINGS='worker-a:manager,worker-b:manager'
npm start
```

ソケットは `socketPath`、`HERDR_SOCKET_PATH`、
`~/.config/herdr/herdr.sock` の順に解決します。プロンプト中の
`{{workers}}` は完了した worker 名のカンマ区切りに置換されます。

## 動作

1. Herdr の snapshot から設定済み agent 名と pane ID を対応付けます。
2. 対象 pane の `pane.agent_status_changed` をソケット購読します。
3. worker の `done` への遷移を manager ごとのキューへ追加します。
4. manager が `idle` / `done` なら、テキストと Enter を Herdr API 経由で送ります。
5. ソケット切断時は再接続し、snapshot と購読を作り直します。

キューはプロセス内のメモリに保持されます。プロセス再起動をまたぐ永続化は
行いません。

## テスト

```sh
mise run test
mise run check
```
