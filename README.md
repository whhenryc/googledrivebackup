# Drive Transfer — Google Drive 資料夾搬運工具（Web UI）

4 步驟嘅 web wizard：連結帳戶 → 揀來源資料夾 → 揀目標位置 → 執行搬運（即時進度）。

**原理**：全程用 Google Drive API 嘅 `files.copy`，喺 Google 伺服器內部直接複製檔案。無論係呢個 app 所在嘅主機，定係使用者部電腦，都唔會經手任何檔案內容——只有 API 指令來回。

只需要授權「接收檔案嗰個帳戶（B）」一次；來源帳戶（A）只需要將資料夾分享畀 B。

---

## 1. 建立 Google Cloud OAuth 憑證

1. 去 [Google Cloud Console](https://console.cloud.google.com/) 開一個新專案
2. 「API 和服務」→「已啟用的 API 和服務」→ 啟用 **Google Drive API**
3. 「API 和服務」→「OAuth 同意畫面」：
   - 使用者類型選 **外部（External）**
   - 狀態設做「測試中（Testing）」就夠，唔使送審
   - 「測試使用者」加入你想用嚟接收檔案嗰個 Google 帳戶 email
4. 「憑證」→「建立憑證」→「OAuth 用戶端 ID」：
   - 應用程式類型：**網頁應用程式（Web application）**
   - 已授權的重新導向 URI：
     - 本地開發：`http://localhost:3000/auth/google/callback`
     - Railway 部署後：`https://你的網域/auth/google/callback`（部署完攞到網域先加返呢條，之後重新部署一次）
   - 建立後記低 **用戶端 ID** 同 **用戶端密鑰**

---

## 2. 本地執行

```bash
npm install
cp .env.example .env
# 編輯 .env，填返 GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET
npm start
```

打開 `http://localhost:3000`，跟住 4 個步驟做。

---

## 3. 部署到 Railway

同你平時工作流程一樣（GitHub → Railway）：

1. 呢個資料夾 push 上一個新嘅 GitHub repo（`.env` 已經喺 `.gitignore`，唔會上到 GitHub，密鑰安全）
2. Railway → New Project → Deploy from GitHub repo → 揀呢個 repo
3. Railway 會自動偵測 Node.js，用 `npm start` 啟動（`package.json` 已經設定好）
4. Settings → Variables，加入：
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `GOOGLE_REDIRECT_URI`（用 Railway 分配到嘅網域，例如 `https://drive-transfer.up.railway.app/auth/google/callback`）
   - `SESSION_SECRET`（隨機長字串）
5. 部署完成攞到正式網域之後，返去 Google Cloud Console 個 OAuth 憑證，將呢個網域嘅 callback URI 加入「已授權的重新導向 URI」
6. 重新部署一次（或者 Railway 通常會自動重啟）即可使用

---

## 使用流程

1. **連結帳戶** — 用接收檔案嗰個 Google 帳戶（B）登入授權
2. **來源資料夾** — 貼上資料夾連結或 ID（記得先喺 A 帳戶分享畀 B，Viewer 已足夠，並確認冇開啟「限制下載/複製」）
3. **目標位置** — 貼上 B 帳戶入面想存放嘅資料夾（輸入 `root` 代表 My Drive 最頂層），可以選擇改新資料夾名
4. **執行搬運** — 按「開始搬運」，右邊會即時顯示搬緊嘅資料夾/檔案，完成後有連結直接打開新資料夾

---

## 技術備註

- Session 用 `express-session` 內建記憶體儲存，適合單一使用者/單一 instance 使用；如果之後想畀多人用或者要留紀錄，可以換做 SQLite（同你 CERC 個做法一樣）存 token。
- 進度更新用 Server-Sent Events（SSE），單向 stream，唔使另外裝 WebSocket library。
- Google Docs / Sheets / Slides 呢啲原生格式可以直接複製；捷徑（Shortcut）檔案會被跳過並喺記錄提示。
- Drive API 有每分鐘配額限制，程式已內建指數退避重試（429/500/503）。檔案量特別大（幾千個以上）建議分批用唔同嘅來源子資料夾執行。
- Shared Drive（共用雲端硬碟）都支援，程式已加 `supportsAllDrives`。

## 檔案結構

```
drive-copy-web/
├── server.js          # Express 後端：OAuth、resolve、複製工作引擎、SSE
├── public/
│   ├── index.html      # 4 步驟 wizard 畫面
│   ├── style.css        # 視覺設計
│   └── app.js            # 前端邏輯
├── package.json
├── .env.example
└── .gitignore
```
