# intro_git

GITの概念・使い方を理解するために利用します。

~ ブラウザ側でコミット

## Claudeでブラウザ予約を自動化するサンプル

`examples/claude-browser-reservation.js` に、Claude APIとPlaywrightを組み合わせてブラウザ予約を進めるサンプルを追加しました。

### 何をするサンプルか

- Claudeが画面内容を読み取り、次の操作を判断する
- 実際のクリックや入力はPlaywrightが行う
- 毎月同じ曜日・時間のレッスン予約のような、繰り返し操作を自動化する土台にできる

### セットアップ

```bash
npm install
npx playwright install chromium
cp .env.example .env
```

`.env` には少なくとも以下を設定してください。

```env
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=claude-sonnet-4-20250514
LESSON_USER_ID=your_login_id
LESSON_PASSWORD=your_password
```

### 予約内容を設定

`reservation.example.json` の `startUrl` と `task` を、実際のサイトに合わせて書き換えてください。

例:

```json
{
  "startUrl": "https://your-lesson-site.example/login",
  "task": "ログインし、今月の対象レッスン予約ページへ進み、毎月第2火曜日の21:00レッスンを1件だけ予約してください。確認画面があれば内容を確認して確定してください。",
  "headless": false,
  "maxSteps": 20,
  "successIndicators": ["予約完了", "予約が確定しました"]
}
```

### 実行

```bash
npm run reservation:sample
```

別ファイルを使う場合:

```bash
node examples/claude-browser-reservation.js --config your-config.json
```

### 使いどころと注意

- 画面構成がよく変わるサイトでは、固定セレクタだけの自動化より柔軟です
- 一方で、予約処理のような重要操作は `headless: false` で最初に目視確認しながら調整するのが安全です
- ログインが必要なサイトでは、プロンプトインジェクションや誤操作のリスクがあるため、専用アカウントや権限分離を推奨します
- 安定運用するなら、最終的には「ログイン」「対象月へ移動」「対象枠を選択」「確認して確定」を固定フロー化し、Claudeは例外時のみ使う構成の方が堅実です

### 補足

Anthropic公式ドキュメントでは、Claudeのツール利用とComputer Useが案内されています。今回のサンプルは、ローカルPC上で試しやすいように `Claude API + Playwright` の構成にしています。


